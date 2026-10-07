# Local Storage

## 저장 위치

* 첫 실행에 고른다. 기본값은 **운영체제가 알려 준 사용자 폴더** + `PLAN-A Memo`
  (`dirs::home_dir()` — 보통 `C:\Users\<사용자>\PLAN-A Memo`). 드라이브 문자를 코드에 적지 않는다.
* 다른 폴더(`D:\PLAN-A Memo`, `E:\My Notes` …)도 된다. 고른 폴더가 비어 있지 않은 일반 폴더면
  그 안에 `PLAN-A Memo` 폴더를 만든다. 드라이브 최상위·쓰기 권한 없는 곳은 거절한다.
* 위치는 `%APPDATA%\com.plana.memo\app-config.json` 에 **경로만** 기록한다.
* 설정된 위치를 찾지 못하면(외장 드라이브 분리 등) 빈 DB 를 새로 만들지 않고 '찾을 수 없음' 화면을 보인다.

```
<저장 위치>/
  .plana-memo-storage.json     저장소 표식
  data/memo.sqlite3            메모 · History · Sync Outbox · 설정 (WAL)
  attachments/YYYY/MM/<id>.png 이미지(복사본)
  backups/                     자동 Backup (VACUUM INTO)
  exports/                     내보내기 기본 폴더
  sync/                        Mock 서버 상태 등(개발용)
```

## Schema (migrations/0001_init.sql)

| 테이블 | 내용 |
|---|---|
| `documents` | Sync 단위. `kind` DAY(memo_date) / NEXT_LIST(next_list_id), `local_revision`, `synced_revision`, `server_version`, `sync_enabled`, `sync_status`, `deleted_at` |
| `memo_items` | `section` main/am/pm(날짜) · next(List), `kind` checklist/text, `content_html`, `content_text`(검색용 평문), `completed`, `favorite`, `sort_order`, soft delete |
| `next_lists` | List 이름·순서. 기본 Next 는 고정 id `00000000-0000-4000-8000-000000000001` |
| `attachments` | `relative_path`(상대 경로만), `mime_type`, `size`, `content_hash`(sha256), `server_attachment_id`, `sync_status` |
| `document_versions` | History — 문서 전체 Snapshot(JSON) + 검색용 평문, 사유(수정/삭제/이동/충돌…) |
| `sync_links` | 문서 ↔ 서버 문서 id |
| `sync_outbox` | 영속 대기열. 문서·작업(LINK/PUSH/UNLINK)당 1건, idempotency key, 재시도·backoff |
| `sync_state` | cursor · device id · account |
| `conflicts` | 열린 충돌(로컬·서버 Snapshot, 서버 버전) |
| `settings` | 앱 설정(last_app_version 등) |
| `schema_migrations` | 적용된 버전 · checksum |

> 구역 값은 PLAN-A Work 개인 메모의 기존 값 `main / am / pm` 을 그대로 쓴다(작업지시문의 morning/afternoon 과 같은 뜻).
> Web 과 같은 값이라 Adapter 에서 변환할 일이 없다. Next 항목은 `next`.

## 안정성

* `PRAGMA journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5s`.
* 모든 쓰기는 transaction. 로컬 변경 + revision + Outbox 를 함께 commit.
* 같은 날짜 문서는 하나(부분 unique index), 항목 생성은 화면이 만든 UUID 로 중복 방지(재시도 안전).
* Migration: 버전 순서대로 각자 transaction. 기존 DB 에 적용할 것이 있으면 **먼저 Backup**.
  앱보다 새 버전의 DB 는 열지 않는다(`db_newer_than_app`). DB 를 지우고 새로 만드는 경로는 없다.
* 이미지 파일은 임시 이름으로 쓰고 `fsync` 후 바꿔 끼운다.

## Backup

`backups/memo-<UTC시각>-<사유>.sqlite3` — Migration 전 · 저장 위치 변경 전 · 앱 버전이 바뀐 첫 실행 · 하루 한 번 · 수동.
최대 20개 · 1GB(최소 3개는 남김). 첨부 이미지는 지우지 않는 파일이라 Backup 에 복사하지 않는다.

## 저장 위치 변경

```
쓰기 잠금(연결 Mutex) → 기존 위치 Backup → WAL checkpoint
→ 새 위치에 DB(VACUUM INTO) · attachments · backups · exports · sync 복사
→ 검증: integrity_check · 테이블별 행 수 · 첨부 파일 존재·크기
→ 새 위치 열기 → 설정 파일 갱신 → 기존 저장소 닫음
실패: 새 위치에 만든 것만 삭제, 기존 저장소 계속 사용
```
기존 폴더는 지우지 않는다(사용자가 확인 후 정리).

## 이미지 참조

HTML 에는 `attachment://<local_attachment_id>` 만 저장한다(`file:///` · 절대 경로 · blob: · Base64 저장 거절).
화면에서는 `http://attachment.localhost/<id>` 로 그린다 — Rust 의 `attachment` URI scheme handler 가
id 로 DB 를 찾아 **저장 폴더 안의** 파일만 돌려준다.
Sync 때는 `plana-attachment://<server_attachment_id>` 로 바뀌어 전송된다(로컬 id·경로는 서버로 가지 않는다).

## 로그

`%LOCALAPPDATA%\com.plana.memo\logs\plan-a-memo.log` (2MB × 5). 메모 본문·이미지·토큰·code·PKCE verifier 는 기록하지 않는다.
설정 → [로그 폴더 열기].

## Migration v2 — memo-sync-v1 (`migrations/0002_memo_sync_v1.sql`)

기존 테이블·데이터는 지우지 않는다(`conflicts` 만 컬럼·상태 추가를 위해 복사 후 교체). 적용 전 자동 Backup(`pre-migration-v2`).

| 추가 | 내용 |
|---|---|
| `sync_links` + `account_key` · `link_id` · `acked_version` · `remote_pending` · `server_digest` | 계정·환경별 연결, 서버 link generation, ACK 한 version, 받아야 할 문서 표시 |
| `sync_outbox.account_key` | UNLINK 등 어느 계정의 작업인가(다른 계정으로 보내지 않는다) |
| `sync_item_map` | 로컬 항목 ↔ 서버 항목 id · client_key · item_version (문서별) |
| `sync_attachment_map` | 로컬 첨부 ↔ 서버 이미지 이름(계정별) · SHA-256 |
| `conflicts` + `server_conflict_id` · `source`(desktop/web) · `account_key`, 상태 `resolved_elsewhere` · `closed` | 서버 비교와 연결 |

## 쓰지 않는 이미지 정리

설정 → Backup → [쓰지 않는 이미지 정리]. 먼저 개수·용량만 보여 주고 확인을 받는다. 지우는 조건(모두 만족):
현재 메모(삭제된 항목 포함)·History Snapshot·비교 화면 어디에서도 참조하지 않음 **그리고** 남아 있는 어떤 Backup DB 도
참조하지 않음 **그리고** 7일 넘음(붙여넣은 뒤 아직 저장 전인 초안 보호). 읽을 수 없는 Backup 이 하나라도 있으면 아무것도
지우지 않는다. History 는 지우지 않는다(History 가 참조하는 이미지는 계속 남는다). 자동 실행하지 않는다.
