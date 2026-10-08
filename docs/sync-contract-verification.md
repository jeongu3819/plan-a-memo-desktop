# memo-sync-v1 Contract 검증 보고 (Desktop ↔ PLAN-A Work)

> 3차 작업(2026-10-08). **이 문서의 '검증'은 Mock 서버·HTTP stub·실제 앱(Mock 서버 연결) 결과다.
> 실제 PLAN-A Work Backend + MySQL + Web 과 연결한 통합 검증은 아직 하지 않았다**(서버 migration·flag 미적용 — §6).
> PLAN-A Work 쪽 수정 요청은 [PLAN_A_WORK_SYNC_HANDOFF.md](PLAN_A_WORK_SYNC_HANDOFF.md).

## 1. 기준 자료

이번 검증은 저장소에 복사된 4개 파일만 기준으로 했다(외부 `plan-a-work` 작업 폴더는 읽지 않았다).

| 파일 | 역할 | 확인 내용 |
|---|---|---|
| `docs/upstream-plan-a-work/memo-sync-v1.md` | 공식 계약(우선) | `memo-sync-v1`, "implementation contract; opt-in preview, disabled by default" |
| `docs/upstream-plan-a-work/MEMO_SYNC_IMPLEMENTATION.md` | 실제 구현·검증 상태 | 코드·테스트·DDL 단계. 실제 EXE·MySQL·S3·Google/Naver 연쇄는 **미검증**이라고 스스로 명시 |
| `docs/upstream-plan-a-work/source/memo_sync_api.py` | Endpoint·Pydantic 정의(552줄) | Method·Path·필드·길이·소유권·오류 코드 |
| `docs/upstream-plan-a-work/memo-sync-v1.mysql.sql` | Server DB 이해용 | "REVIEW ONLY: not applied". **실행하지 않았다.** Desktop SQLite 로 옮기지 않았다 |

* 스냅샷에는 PLAN-A Work commit 번호가 적혀 있지 않다. (2차 작업은 `ccb4998` 기준이었다.) 다음 스냅샷부터는
  `README.md` 에 원본 commit 을 적어 달라고 인계 문서에 요청했다.
* `memo_sync_api.py` 는 `app.services.memo_sync`(normalize·snapshot·attachments·publish·replace·status·namespace)를
  부른다. **그 파일은 스냅샷에 없다** — 그 안의 규칙은 §5 에 '확인 필요' 로 분리했다.

## 2. 결과 요약

| 영역 | 일치 | 부분 일치 → Desktop 수정 | PLAN-A Work 수정·확인 필요 |
|---|---|---|---|
| 데이터(DAY·NEXT_LIST·ID·version·Snapshot) | 11 | 1 (서버 tombstone 첫 연결) | 0 |
| 동기화(Link·Push·Pull·Cursor·ACK·Conflict·이미지) | 14 | 3 (Pull 실패 표시, Resolve 이미지, 비교 안내 문구) | 2 (정규식 오탐, ACK manifest 중복 규칙) |
| 인증(PKCE·Loopback·Exchange·Device·환경) | 13 | 1 (개발 빌드가 운영 서버를 받던 점) | 1 (폐기 기기 재인증 의도) |
| Next List 이름 | — | 1 (연결된 List 이름 변경 = 이 PC 에만, 안내) | 1 (이름 변경 API 없음) |

Contract 와 Desktop 이 **반대로 동작하는 곳(불일치)은 없었다.** 부분 일치 항목은 모두 이번에 Desktop 에서 고쳤다(§4).

## 3. Contract Gap Analysis

표기: ✅ 일치 · 🟡 부분 일치(이번에 Desktop 수정) · 🔴 PLAN-A Work 수정 필요 · ❔ 서버 확인 필요(스냅샷에 정의 없음)

### 3-1. 데이터

| Contract 요구사항(실제 Web Backend 규칙) | Desktop 현재 구현 | 일치 | 문제 영향 | 후속 조치 |
|---|---|---|---|---|
| DAY = owner + 날짜, main/am/pm **전체** | `mapper::build_push` 가 `repo::build_snapshot` 의 그 날짜 항목 전부를 구역 순서대로 보냄 | ✅ | 누락 시 서버 soft delete(데이터 유실) | 회귀 테스트 `every_push_carries_the_whole_document…` |
| NEXT_LIST = owner + List id, 기본 Next = `default` | `unit_of`: 기본 List → `default`, 이름 있는 List → 로컬 List UUID(소문자) | ✅ | — | — |
| 새 이름 있는 List: `POST native/lists {id: 소문자 UUID, title}`, 같은 id 재시도 안전, 제목 다르면 409 | LINK 전에 `create_list`, 409 는 이미 있는 List 로 보고 link 진행(남의 List 면 link 가 404) | ✅ | 이름을 바꾼 뒤 재연결이 막힐 수 있음 → 막히지 않음 확인 | `renaming_a_linked_list_stays_on_this_pc` |
| 서버 문서 UUID·기기 UUID·namespace 는 불투명 값 | `sync_links.server_document_id`, credential 의 `server_device_id`, `account_key = namespace\|user_id` | ✅ | — | — |
| 기존 서버 항목 id(정수)는 바뀌지 않음, 새 항목은 `client_key`(8–64) | 로컬 id(UUID) ↔ `sync_item_map`(server_item_id·client_key·item_version). 새 항목 client_key = 32자 hex, 처음 보낼 때 같은 transaction 에 저장 | ✅ | 재전송 때 다른 key → 중복 항목 | `lost_push_response…` |
| `item_version` 은 받은 값을 그대로 되돌려 보냄, base_version 대용 금지 | Push 항목 `item_version` = 매핑에 저장한 서버 값, `base_version` = 문서 `server_version` | ✅ | 혼동 시 잘못된 conflict·덮어쓰기 | 신규 `item_version_is_echoed_and_never_used_as_base_version` |
| Item 필드 `id, item_version, client_key, section(main/am/pm), kind(checklist/text), content, completed, sort_order(0–1,000,000)`, **extra=forbid** | `PushItem`(deny_unknown_fields, None 은 생략), 구역별 0부터 정렬 번호, text 는 completed=false | ✅ | 모르는 필드 → 422 | contract.rs 단위 테스트 |
| NEXT_LIST 는 section `main` 만 | Next → `main`, 받을 때 `main` → 로컬 `next` | ✅ | — | — |
| 즐겨찾기 — Contract 에 없음 | 보내지 않음, 받아도 로컬 즐겨찾기 유지 | ✅ | — | `favorites_never_leave_the_device` |
| Snapshot 전체 교체, 빠진 항목은 soft delete | 삭제 = 그 항목만 빠진 전체 문서, 서버도 그 항목만 soft delete | ✅ | — | 신규 테스트(삭제 1건만 서버 삭제 확인) |
| 문서 삭제 = tombstone(`deleted=true`, items 빈 배열), 자동 부활 금지 | List 삭제 → tombstone Push 후 연결 종료 | ✅ | — | 기존 테스트 |
| 첫 연결: 로컬에 내용 + 서버에 내용 → **base_version=0 으로 Push → 서버가 비교 생성**, 어느 쪽도 버리지 않음 | `first_link_compare`: 양쪽 같으면 id 만 맞춤, 로컬만 → 서버 version 위에 Push, 서버만 → 받기, 둘 다 다르면 base 0. **서버가 tombstone 인 경우를 '빈 서버' 로 보고 그 version 위에 Push(삭제된 문서를 몰래 되살림)** | 🟡 | 다른 곳에서 지운 문서가 비교 없이 부활 | **수정**: tombstone 은 비어 있어도 base 0 비교. 신규 `first_link_cases_never_lose_either_side` |

### 3-2. 동기화

| Contract 요구사항 | Desktop 현재 구현 | 일치 | 문제 영향 | 후속 조치 |
|---|---|---|---|---|
| Link: `POST native/links {type,key}`(device_id 생략 → 토큰 기기), 같은 연결 재시도 안전, link generation 저장 | LINK → link → GET document → 비교. `sync_links.link_id` 저장 | ✅ | — | 신규: 연결 중 네트워크 단절 후 재시도 → link·항목 중복 없음 |
| Unlink: 양쪽 사본 유지, 이전 generation 의 Push·ACK 거절 | `disable_link` 는 로컬 LINK/PUSH 를 지우고 UNLINK(link_id) 만 남김. inflight 는 `link_id` 가 현재 것과 같을 때만 재전송 | ✅ | 오래된 요청 재실행 | 신규 `stale_generation_outbox_is_never_replayed_after_relink` |
| `unlinked` 이벤트 = 로컬 사본 유지, 이전 generation 이벤트는 합침(몰래 새 연결 금지) | `record_event`: link_id 가 같을 때만 종료, 다르면 무시 | ✅ | — | 기존 테스트 |
| Push: `base_version, local_version, request_id(8–64), link_id, deleted, items` | `PushRequest`(deny_unknown_fields) | ✅ | — | HTTP stub 테스트 |
| **Push conflict = HTTP 200 + `status=conflict`**(제안 저장) | `PushResponse::Conflict` → 비교 열기, `pushed` 로 세지 않음 | ✅ | 저장 성공으로 오인 | 신규 테스트에서 `pushed == 0` 확인 |
| 같은 request_id + 다른 본문 → 409 `request_id_reused`, 같은 본문 → 처음 결과 | Push 본문 전체를 Outbox 에 저장한 뒤 전송, 응답 유실 시 그대로 재전송 | ✅ | 중복 항목·version | 기존 + 신규(첫 연결 base 0 재전송 → 비교 1건) |
| 열린 conflict 가 있으면 같은 문서 Push 는 새 conflict | `has_conflict` 동안 Push 보류(비교 화면의 Desktop 쪽은 지금 내용) | ✅ | 비교가 쌓임 | 신규 `edits_during_an_open_conflict…` |
| Changes: 불투명 cursor, 최대 100건, cursor 와 로컬 처리를 함께 commit | 이벤트 → '받아야 할 문서' 표시(remote_pending) + cursor 를 한 transaction | ✅ | 강제 종료 시 변경 유실 | 신규 `cursor_and_pending_documents_survive_a_crash` |
| cursor 불일치 → 409 `cursor_namespace_mismatch` | cursor 버림 + 연결 문서 전부 다시 확인 | ✅ | — | 신규(HTTP 오류 테스트) |
| Pull: `GET documents/{id}` = snapshot + attachments(sha256) + link_id + status | `PulledDocument`. 보내지 않은 로컬 편집이 있으면 덮지 않고 원래 base 로 Push → 서버 비교 | ✅ | 저장 대기 내용 덮어쓰기 | 신규 `pending_local_edit_is_never_overwritten_by_pull` |
| 한 문서 conflict 가 다른 문서를 막지 않음 | 문서별 처리·오류 | ✅ | — | 신규 `one_conflicted_document_does_not_block_others` |
| Pull 실패(이미지 저장 실패 등) | 다음 실행에서 다시 받지만 **문서 상태는 그대로 'synced' 로 보였다** | 🟡 | 받지 못한 변경을 받은 것처럼 표시 | **수정**: 그 문서를 '오류 — PLAN-A Work 변경을 아직 받지 못했습니다' 로. 신규 `attachment_download_failure…` |
| ACK: 정확한 최신 version + 이미지 이름 전체, SQLite·파일 저장 뒤에만. HTTP 저장 성공 ≠ ACK | 로컬 반영 + 파일 확인 뒤 `ack_manifest`(로컬 본문이 참조하는 첨부의 서버 이름, 정렬·중복 제거). 실패 시 다음 실행 | ✅ | — | 신규 ACK 지연 테스트 |
| ACK 409 `ack_version_stale` · `attachments_incomplete` | 다시 받아 확인 후 ACK | ✅ | — | 신규 테스트 |
| ACK manifest 비교 `sorted(body) != sorted(manifest names)` — 서버 manifest 에 같은 이름이 두 번 오면 | Desktop 은 이름을 중복 없이 보냄 | ❔ | 같은 이미지를 두 번 쓴 문서가 영원히 ACK 안 됨(가능성) | 인계 §3-2 — `sync.attachments()` 중복 제거 여부 확인 |
| Conflict 조회: `{server, conflicts:[{id, proposal, source, created_at}]}` | `ConflictsResponse` | ✅ | — | — |
| `source=web` 이면 제안이 Web, server 는 현재(Desktop 이 먼저 저장한) 쪽. `side` 는 표시한 출처 | Remote 표시 = source=web 이면 제안, 아니면 서버 현재. 선택: 이 PC → `desktop`, PLAN-A Work → `web` | ✅ | — | 기존 `web_stale_editor…` |
| 화면에서 서버 쪽을 항상 'Web' 이라고 부르지 않기 | 비교 화면은 source 기준이었으나 알림(toast)·상태 표시가 'Desktop과 PLAN-A Work에서 각각 수정' 으로 단정. 첫 연결 비교도 같은 문구 | 🟡 | 잘못된 출처 안내 | **수정**: `conflictText.ts`(source·첫 연결별 문구), 알림·상태 표시는 중립 문구 |
| Resolve: `base_version`(서버 현재) + side, stale → 409 `resolution_stale`, 이미 해결 → 404 | 서버 성공 뒤에만 로컬 확정. 409 → 비교 화면 새로 고침, 404 → 최신 받기 + 이 PC 내용 History | ✅ | — | 신규 `resolving_a_conflict_already_resolved_elsewhere…` |
| Resolve 응답(새 version 문서)의 이미지 | `document.attachments` 만 내려받음 — 응답에 attachments 가 비면 '이미지 없음' 오류로 확정 실패 | 🟡 | 서버는 해결됐는데 로컬 확정 실패(다음 Pull 에서 회복) | **수정**: 본문이 참조하는 이미지 이름까지 합쳐 받기 |
| 이미지: Push 전 업로드, 안정된 request id, 서버 URL `/api/personal-memos/images/{name}/download` | request id = 로컬 첨부 id, 본문은 전송 사본에서만 서버 URL 로 바꿈(로컬 HTML 은 `attachment://`) | ✅ | — | 기존 |
| 서버가 업로드 이미지를 다시 인코딩(`process_task_inline_image`) — 받은 바이트 ≠ 보낸 바이트 | 업로드한 이미지는 내려받지 않고 서버 SHA-256 과 비교하지 않음. 내려받은 것만 SHA-256 확인 | ✅ | — | — |
| 이미지 정책: 기존 inline image(형식·크기), 일반 파일 첨부 없음 | 업로드 전 PNG·JPG·WEBP·10MB 확인, 아니면 그 문서만 '보낼 수 없음' 안내. 원본 보존 | ✅ | — | 신규 `server_limits_and_unsupported_images…` |
| `Local paths are not allowed` 검사 | 해당 문서만 오류, 본문 수정 없음, 1시간 뒤 같은 내용 재시도 | 🔴 | **https 링크가 있는 메모가 서버로 가지 않음** | 인계 §1. 안내 문구에서 '해당 글자를 빼면' 권유를 없앰 |

### 3-3. 인증·기기·환경

| Contract 요구사항 | Desktop 현재 구현 | 일치 | 후속 조치 |
|---|---|---|---|
| 시스템 브라우저 + 기존 PLAN-A 로그인 | 기본 브라우저로 `<origin><browser_path>`(경로만 받아 설정된 origin 에 붙임, `//`·`\` 거절) | ✅ | — |
| Listener 를 브라우저보다 먼저 | `auth_login_begin`: bind → start → open | ✅ | — |
| `http://127.0.0.1:<1024–65535>/memo-sync/callback`, credentials/query/fragment 없음 | `127.0.0.1` 에만 bind(포트 0 → OS 임시 포트), 정확한 문자열 | ✅ | 신규: 두 listener 포트가 겹치지 않음 |
| Start: name(1–80), challenge(43, S256), state(32–128), redirect_uri, device_id? | 기기 이름 80자 제한, PKCE verifier 43자, state 43자 | ✅ | — |
| Callback state 검증 | 상수 시간 비교, 5분 제한 | ✅ | 기존(위조 state 거절) |
| 60초 일회용 code, Exchange = code + verifier + 같은 redirect_uri | 401 → '로그인 코드가 만료되었거나 이미 사용' | ✅ | 기존(code 재사용 거절) |
| Exchange 응답 `access_token(pms_…), token_type, expires_in, device_id, user_id, namespace` | `pms_`·Bearer 확인, namespace 가 빌드 환경과 맞을 때만 저장(Windows Credential Manager, 환경별 서비스 이름) | ✅ | — |
| 30일 만료 → 브라우저 재연결, 같은 device_id 로 start → link·cursor 유지 | [다시 연결] = 저장된 device_id 로 start. account_key 같으면 Outbox·link 이어감 | ✅ | 기존 |
| 기기 폐기/로그아웃 → 즉시 credential 폐기, 로컬 메모 유지 | `POST logout` 후 credential 삭제, 그 계정 연결은 '이 PC 에만'. 401 → 만료 표시, 같은 토큰으로 계속 요청하지 않음 | ✅ | 기존 |
| Web cookie·Google/Naver code 를 쓰지 않음 | Cookie store 없음, Rust 에서만 HTTP | ✅ | — |
| namespace(`MEMO_SYNC_ENVIRONMENT`)별 토큰·cursor | `account_key = namespace\|user_id` 로 Link·Outbox·cursor 분리, 다른 계정 Outbox 는 보내지도 지우지도 않음 | ✅ | 기존 |
| 운영 서버에 시험 요청 금지 | **개발 빌드가 production namespace 를 받았고, `PLANA_SERVER_ORIGIN=https://planawork.com` 도 허용** | 🟡 | **수정**: 개발 빌드는 local·staging namespace 만, 개발·staging 빌드는 운영 주소 거부. 신규 환경 매트릭스 테스트 |
| 폐기한 기기를 같은 owner 가 device_id 로 재인증하면 기기가 다시 살아남(`revoked_at=None`), 링크는 비활성 유지 | Desktop 은 이후 Push 에서 409 link_inactive → 연결 종료(로컬 보존) | ❔ | 인계 §3-5 — 의도 확인 |
| 앱이 꺼져 있으면 callback 불가 | listener 가 없으면 브라우저에 연결 실패. 앱을 켜고 다시 로그인하도록 안내(sync-adapter.md) | ✅ | — |

### 3-4. 오류 코드

| 상태 | 서버(`memo_sync_api.py`) | Desktop |
|---|---|---|
| 200 + conflict | Push 제안 저장 | 비교 열기(성공으로 세지 않음) |
| 401 | credential 없음·만료·폐기, 교환 실패 | 동기화 멈춤 + '다시 연결', 로컬 보관 |
| 403 | 다른 계정 기기, Device mismatch | 그 문서만 오류 |
| 404 | 문서·link·기기·conflict 없음 / `Memo sync unavailable`(services, ❔) | 연결 종료(로컬 보존) / 이미 해결된 비교 / '아직 사용할 수 없음' |
| 409 | `link_inactive`, `request_id_reused`, `cursor_namespace_mismatch`, `ack_version_stale`, `attachments_incomplete`, `resolution_stale`, 문자열 'List ID already in use'·'Request ID reused'·'Authorization already issued', (services ❔) `item_moved_or_not_owned`·`client_key_in_use` | 각각 처리 — 어느 경우도 최신 version 으로 덮어쓰는 재시도 없음 |
| 413 | 이미지 정책, 문서 2MB(services ❔) | 그 문서만 오류(이유 표시), Outbox 보관 |
| 422 | Pydantic(항목 50만 자·1,000개·extra 필드), redirect URI, Local paths(services) | 그 문서만 오류 |
| 429 | auth/start·exchange rate limit | 이번 실행 멈춤, 다음 실행 |
| 503 | namespace 미설정(services ❔) | '아직 사용할 수 없음', 변경 보관 |

## 4. 이번에 수정한 Desktop 코드

| 파일 | 수정 |
|---|---|
| `src-tauri/src/sync/engine.rs` | (1) 서버 tombstone 문서 첫 연결 → base 0 비교(자동 부활 금지) (2) 받지 못한 문서는 '오류' 로 표시(동기화됨으로 보이지 않게) (3) Resolve 결과 이미지 = 응답 manifest ∪ 본문 참조 (4) 같은 이미지 이름은 한 번만 내려받기 (5) 'Local paths' 거절 안내에서 '글자를 빼라' 는 권유 제거(본문 우회 금지) (6) `ConflictView.first_link` |
| `src-tauri/src/auth/mod.rs` | 개발 빌드는 `local`·`staging` namespace 만(운영 credential 거부) |
| `src-tauri/src/config.rs` | 개발·staging 빌드는 운영 주소(`planawork.com`)를 `PLANA_SERVER_ORIGIN` 으로 받지 않음 |
| `src-tauri/src/memo/service.rs` | List 이름 변경은 Sync 대상 아님 — 문서 revision·Outbox 를 만들지 않음 |
| `src-tauri/src/sync/mock.rs` | 테스트용 `inject`(경로별 HTTP 결과 흉내), `pushes()`(보낸 본문 기록), `web_tombstone` |
| `src/features/sync/conflictText.ts`(신규), `ConflictDialog.tsx`, `App.tsx`, `SyncMark.tsx` | 출처·첫 연결별 안내, 알림은 출처를 단정하지 않는 문구 |
| `src/features/next/NextListTabs.tsx`, `src/domain/types.ts` | 연결된 List 이름 변경 시 '이 PC 에만 바뀜' 안내 |

Local SQLite 스키마·저장 구조·Rich Editor 는 바꾸지 않았다(migration 추가 없음).

## 5. 스냅샷에 없어 확인하지 못한 서버 정의 (PLAN-A Work 확인 요청)

`memo_sync_api.py` 가 부르는 아래 정의는 4개 파일에 없다. Desktop 은 2차 작업(`ccb4998`) 때 읽은 내용과 Contract
문장에 맞춰 두었고, Mock 도 그렇게 동작한다. **다음 스냅샷에 `backend/app/services/memo_sync.py`,
`backend/app/memo_sync_models.py`, `personal_memos.py` 의 `INLINE_IMAGE_POLICY`·`prepare_content`·`process_task_inline_image`
를 함께 넣어 달라**(인계 §5).

| 정의 | Desktop 이 가정한 값 | 틀리면 영향 |
|---|---|---|
| `sync.normalize` 의 로컬 경로 검사 | `re.search(r'(?:file:\|[A-Za-z]:[\\/])', content, re.I)` → 422 `Local paths are not allowed` | 인계 §1 |
| 다른 문서 항목 요구 시 409 code | `item_moved_or_not_owned`, `client_key_in_use` | 다른 code 면 일반 409 로 처리(재시도 대기) — 데이터 손상은 없음, 안내 문구만 다름 |
| `MemoSyncConflict.source` 기본값 | Desktop Push 로 생긴 conflict 는 `desktop` (Push 코드는 source 를 넣지 않는다, DDL 은 NOT NULL·기본값 없음) | 기본값이 없으면 Push conflict 가 500 |
| `sync.attachments()` manifest | 이름 중복 없음, `sha256` 포함 | 중복이 있으면 ACK 가 계속 409 |
| `sync.namespace()` 미설정 응답 | 404 `Memo sync unavailable` 또는 503 | 다른 문장이면 '찾을 수 없음' 으로 연결 종료(로컬 보존)될 수 있음 |
| changes 이벤트 `kind` | `linked`·`unlinked`·`conflict`·`changed`(그 밖은 version 비교로 처리) | — |
| `publish()` 응답 | WireDocument(attachments 는 없을 수 있음) | Desktop 은 없어도 동작 |

## 6. 검증 결과

| 구분 | 결과 | 비고 |
|---|---|---|
| Rust 단위(contract·mapper·config·loopback 등) | 21 통과 | |
| Rust HTTP Adapter(실제 HTTP stub 서버) | 6 통과(신규 1: `memo_sync_api.py` 오류 모양 그대로) | 요청 모양·오류 해석 |
| Rust Memo / Storage | 14 / 14 통과 | 회귀 |
| Rust Sync(Mock 서버 시나리오) | 46 통과(기존 28 + 신규 18) | 데이터 유실 방지 우선 |
| Frontend(vitest) | 69 통과(신규 3) · tsc · ESLint 통과 | |
| 실제 앱 E2E(debug, Mock 서버) | 13단계 통과(신규 2: 첫 연결 비교, 연결된 List 이름) | `npm run e2e:build && npm run e2e` |
| 실제 PLAN-A Work 통합 | **미실행** | 서버 준비 전(§7) |

기능별 상태(코드 구현 / Mock·Contract 검증 / 실제 통합):

| 기능 | 코드 | Mock·Contract | 실제 PLAN-A Work |
|---|---|---|---|
| DAY·NEXT_LIST 전체 문서 Push(누락 방지) | 완료 | 완료 | 미검증 |
| 첫 연결 비교(base_version=0, tombstone 포함) | 완료 | 완료 | 미검증 |
| Push 재전송(idempotency)·Outbox·강제 종료 | 완료 | 완료 | 미검증 |
| Changes cursor·ACK(manifest) | 완료 | 완료 | 미검증 — ACK manifest 중복 규칙 확인 필요 |
| Conflict(source)·stale·이미 해결·다른 문서 진행 | 완료 | 완료 | 미검증 — conflict source 기본값 확인 필요 |
| 이미지 업로드·다운로드·SHA-256·정책 안내 | 완료 | 완료 | 미검증(S3) |
| Link·Unlink·generation | 완료 | 완료 | 미검증 |
| 이동(DAY↔DAY, Next↔DAY) 선택적 연결 | 완료 | 완료 | 미검증 |
| 브라우저·PKCE·Loopback·교환·재연결·로그아웃 | 완료 | 완료(Mock 동의 + 실제 loopback) | 미검증(실제 로그인·CSP) |
| 환경 분리(dev/staging/production) | 완료 | 완료 | — |
| https 링크가 있는 메모 | 완료(본문 보존·재시도) | 완료(Mock 이 서버 규칙 재현) | **차단됨** — 서버 정규식 수정 필요 |
| 연결된 List 이름 변경 | 이 PC 에만(안내) | 완료 | 서버 API 없음 |

## 7. 실제 서버가 있어야 검증할 수 있는 항목

실제 Backend + MySQL + Web + EXE 연결이 필요하다. 준비 조건과 시나리오는 인계 문서 §4.

* Google/Naver/이메일 로그인 → `/memo-desktop/authorize` → loopback 이동(브라우저 정책·CSP)
* MySQL 트랜잭션·잠금 아래의 version·request·ACK 동작, conflict source 기본값
* 실제 정규식/`prepare_content` 가 Desktop HTML(표·서식·링크·이미지)을 받는지
* S3 이미지 업로드·재인코딩 후 다운로드·SHA-256·ACK manifest
* Web 화면의 연결·기기 목록·5초 polling 과 Desktop 30초 주기의 상호 동작, 장시간 오프라인
