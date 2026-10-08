# Sync Adapter — PLAN-A Work memo-sync-v1

> **기준:** 저장소 안 스냅샷 `docs/upstream-plan-a-work/`(memo-sync-v1.md · MEMO_SYNC_IMPLEMENTATION.md ·
> source/memo_sync_api.py · memo-sync-v1.mysql.sql — 읽기 전용). 2차 작업은 plan-a-work commit `ccb4998` 을 직접 읽었고,
> 3차부터는 스냅샷만 본다. Contract 대조 결과: [sync-contract-verification.md](sync-contract-verification.md),
> PLAN-A Work 수정 요청: [PLAN_A_WORK_SYNC_HANDOFF.md](PLAN_A_WORK_SYNC_HANDOFF.md).
> **실제 PLAN-A Work 서버와의 통합 검증은 아직 하지 않았다** — 서버 DB migration·feature flag 가 아직 적용 전이다.
> 검증 상태는 이 문서 끝의 표.

## 구조

```
React UI ─ typed commands ─▶ memo (Local DB + Outbox, 한 transaction)
                                   │
                         SyncRuntime(변경 1.5초 묶음 · 30초 주기 · [지금 동기화])
                                   │
                              SyncEngine ── DesktopAuth(AuthProvider) ── AuthApi
                                   │                                         ├ PlanAWorkAuthApi (HTTPS)
                              mapper(도메인 ↔ Contract DTO)                     └ MockSyncTransport
                                   │
                            SyncTransport (contract.rs DTO 만 주고받는다)
                     ┌─────────────┴─────────────┐
       PlanAWorkSyncTransport (http.rs)    MockSyncTransport (mock.rs, Contract 흉내 · 테스트·개발)
```

* 환경별 선택(`state.rs`): production → https://planawork.com, staging → https://staging.planawork.com,
  development(주소 없음) → Mock. 운영·staging 빌드에는 Mock 과 개발용 도구가 없다.
* 환경 분리: 운영 주소는 운영 빌드에서만. 서버 namespace 도 빌드와 맞아야 credential 을 저장한다 —
  production 빌드 ← `production:*`, staging ← `staging:*`, development ← `local:*`·`staging:*`(운영 서버 시험 금지).
* Rust 에서만 HTTP 를 부른다 — credential 이 WebView(JS)로 나오지 않는다. Cookie 를 다루지 않는다.

## Endpoint (모두 `/api/memo-sync/native` 아래, Desktop Bearer)

| 용도 | Method · Path | 구현 |
|---|---|---|
| 로그인 시작 | POST `/auth/start` {name, challenge(S256), state, redirect_uri, device_id?} | `PlanAWorkAuthApi::start` |
| code 교환 | POST `/auth/exchange` {code, verifier, redirect_uri} | `PlanAWorkAuthApi::exchange` |
| 로그아웃(기기 폐기) | POST `/logout` | `PlanAWorkAuthApi::logout` |
| 이름 있는 Next List 만들기 | POST `/lists` {id(로컬 List UUID), title} | `create_list` |
| 연결 | POST `/links` {type: DAY\|NEXT_LIST, key} | `link` |
| 연결 해제 | DELETE `/links/{link_id}` | `unlink` |
| 변경 목록 | GET `/changes?cursor=` | `changes` |
| 문서 받기 | GET `/documents/{id}` | `document` |
| 보내기 | POST `/documents/{id}/push` | `push` |
| ACK | POST `/documents/{id}/ack` {version, link_id, attachments} | `ack` |
| 비교 조회 | GET `/documents/{id}/conflicts` | `conflicts` |
| 비교 해결 | POST `/documents/{id}/conflicts/{cid}/resolve` {base_version, side} | `resolve` |
| 이미지 올리기 | POST `/attachments/{request_id}` (multipart `file`) | `upload` |
| 이미지 받기 | GET `/attachments/{name}/download` | `download` |

Web 전용 경로(`/web/...` — 기기 목록·Web 연결·History 복원 등)는 Desktop 이 부르지 않는다.

오류(`http::map_status`): 401 → 다시 로그인(credential 만료·Web 에서 기기 해제), 404 `Memo sync unavailable`·503 →
'아직 사용할 수 없음'(변경 보관), 404 → 찾을 수 없음, 409 `{code}` → link_inactive · request_id_reused ·
resolution_stale · ack_version_stale · attachments_incomplete · item_moved_or_not_owned · client_key_in_use ·
cursor_namespace_mismatch · device_revoked(교환), 413/422 → 거절(문서만 오류 표시 — detail 이 문장·Pydantic 목록·
`{code: local_path_not_allowed|reference_not_allowed, item}` 중 무엇이든 읽는다), 429 → 잠시 뒤, 네트워크 → 오프라인.
409 를 받았다고 비교 화면을 열지 않는다 — 비교는 Push 의 HTTP 200 `status=conflict` 와 서버 conflict 목록으로만 연다.

## DTO Mapping (`mapper.rs`)

| Desktop | memo-sync-v1 |
|---|---|
| DAY 문서(날짜 하루 = main+am+pm) | `type=DAY`, `key=YYYY-MM-DD` |
| Next List 문서 | `type=NEXT_LIST`, `key=default`(기본 Next) 또는 로컬 List UUID(서버에 같은 id 로 만든다) |
| `documents.id`(로컬 UUID) | `sync_links.server_document_id` + `link_id`(link generation) — 로컬 id 를 바꾸지 않는다 |
| `memo_items.id`(로컬 UUID) | `sync_item_map`: 서버 `id`(정수) · `client_key`(새 항목 처음 보낼 때 만든 키) · `item_version`(그대로 되돌려 보냄) |
| section `main/am/pm` · Next `next` | `main/am/pm` · NEXT_LIST 는 `main` |
| kind · completed · 순서 | `kind` · `completed`(text 는 false) · `sort_order`(구역 안 0부터) |
| `<img src="attachment://<local id>">` | `<img src="/api/personal-memos/images/<name>/download">` (`sync_attachment_map`) |
| favorite | 보내지 않는다(Contract 에 없음) — 받아도 로컬 즐겨찾기 유지 |
| List 이름 변경 | 보내지 않는다(이미 있는 List 의 이름을 바꾸는 API 가 없음) — 화면이 '이 PC 에만' 이라고 알린다 |
| `documents.local_revision` | `local_version`(진단용) |
| `documents.server_version` | `base_version` |
| List 삭제 | `deleted=true`, `items=[]`(tombstone) 후 연결 해제 |

* 서버 주소·서버 id 는 로컬 본문(HTML)에 저장하지 않는다(전송 사본에서만 바꾼다).
* v1: Desktop push 로 다른 문서의 항목을 가져올 수 없다 — 같은 로컬 항목이 다른 날짜로 가면 그 문서에서는 새 client_key.
* 서버에서 받은 항목은 같은 서버 id → 같은 로컬 id(즐겨찾기·History 유지). 단 연결 안 된 문서에 따로 있는
  로컬 항목은 건드리지 않는다(새 로컬 id).

## Engine (`engine.rs`)

1. 연결 문서·Outbox 가 없고 로그인도 안 했으면 **요청 0**. 로그인했으면 Web 이 이 PC 로 연결한 문서를 알기 위해
   `changes` 만 본다(메모는 올리지 않는다).
2. **계정 보호**: Sync 상태는 `account_key = <namespace>|<user_id>` 로 묶인다. 다른 계정·환경의 Link·Outbox·cursor 는
   보내지도 지우지도 않고 '다른 계정으로 연결된 메모' 로 멈춘다(user_id 로 권한 판단하지 않는다 — 권한은 서버가 credential 로).
3. Outbox: UNLINK → LINK → PUSH.
   * LINK: (List 면 `POST lists`) → `POST links` → `GET document` → 비교. 서버 빈 문서 + 로컬 내용 → 그 version 위에 push
     (서버에서 삭제된 tombstone 은 '빈 문서' 가 아니다 → base 0 비교, 몰래 되살리지 않음).
     로컬 빈 문서 → 서버 내용 받기. 둘 다 내용이 있고 다르면 **base_version=0** 으로 push → 서버가 비교를 만든다.
     같으면 id 만 맞춘다. 비교하는 사이 로컬이 또 바뀌면 다음 실행에서 다시 비교.
   * PUSH: 이미지 먼저 업로드(request id = 로컬 첨부 id — 재전송해도 한 장) → 본문 → **요청 전체를 Outbox 에 저장한 뒤** 보낸다.
     응답을 잃으면 같은 request_id·같은 본문으로 다시 보내 서버의 처음 결과를 받는다(중복 항목·중복 version 없음).
   * 실패: 오프라인·429 → 멈춤(Outbox 유지). 401 → '다시 연결 필요'. 거절(413/422) → 그 문서만 오류.
     그 밖 → backoff(5초…10분). 한 실행 안에서 실패한 항목은 다시 보내지 않는다.
4. Changes: cursor 이후 이벤트로 '받아야 할 문서' 표시만 하고 cursor 와 **같은 transaction** 에 저장
   (계정·기기별 키). `unlinked` → 로컬 연결 종료(내용 유지), `linked`(모르는 문서) → Web 이 연결한 문서로 받기.
5. 표시된 문서: `GET document` → 이미지 내려받기(SHA-256 확인) → 로컬 transaction(History `remote_apply`) → ACK.
   받지 못하면(이미지 저장 실패 등) 그 문서를 '오류 — 변경을 아직 받지 못했습니다' 로 표시하고 다음 실행에서 다시 받는다.
   보내지 않은 로컬 편집이 있으면 덮어쓰지 않고 원래 base 로 push → 서버가 비교를 만든다. 한 문서 실패가 다른 문서를 막지 않는다.
6. ACK: 로컬 DB 반영 + 본문이 참조하는 이미지 파일이 실제로 있을 때만, 정확한 version + 이미지 이름 전체로.
   `ack_version_stale`·`attachments_incomplete` → 다시 받기.

### Conflict

* 서버가 문서 전체 비교를 보관한다(제안 + 서버 현재). `source=desktop` 이면 PLAN-A Work 쪽 = 서버 현재,
  `source=web`(오래 열어 둔 Web 편집기의 늦은 저장)이면 PLAN-A Work 쪽 = Web 제안. 로컬 쪽은 지금 이 PC 내용.
* 선택 → `resolve(base_version = 비교 화면의 서버 version, side)`. **서버가 성공한 뒤에만** 로컬을 확정한다.
  Desktop 선택 후 이 PC 에 더 고친 내용이 있으면 새 version 위에 이어 보낸다.
* 409 `resolution_stale` → 비교 화면을 최신으로 다시 채우고 다시 묻는다(오래된 선택으로 덮지 않음).
* 다른 곳(Web)에서 해결됨 → 로컬 비교를 닫고 서버 결과를 받는다(이 PC 내용은 History `conflict_local`).
* 선택하지 않은 쪽은 로컬 History 에(`conflict_local` / `conflict_remote`). 서버 History API 는 Desktop 에 없어 부르지 않는다.

### 다른 날짜로 이동(§27)

PLAN-A Work 와 같은 규칙: 연결된 날짜 → 연결 안 된 날짜로 옮기면 원래 문서에서 빠지고 대상은 **연결하지 않는다**.
Desktop 은 기본 버튼 [Desktop에서만 이동] 이 이 의미이고, [○○도 연결하고 이동] 은 사용자가 고를 때만(로그인 필요)
대상 연결 → 대상에 Web 내용이 있으면 비교. 서버가 `item_moved_or_not_owned` 를 주면 최신 서버 문서로 매핑을 고치고
"메모가 다른 위치에서 이미 변경되었습니다. 최신 상태를 불러왔습니다." 로 안내한다.

## Auth (`auth/`)

* `DesktopAuth`: PKCE(S256, verifier 43자) + state(43자) → `127.0.0.1:<임시 포트>/memo-sync/callback` listener 를
  **브라우저보다 먼저** 연다(`loopback.rs`) → start → 기본 브라우저로 `<origin><browser_path>` → callback(state 확인,
  5분 제한) → exchange → namespace 가 빌드 환경과 맞는지 확인 → Windows Credential Manager.
* 저장 값(한 건, JSON): credential, 만료 시각, 서버 device_id, user_id, namespace, 기기 이름. refresh token 은 Contract 에
  없다 — 30일 만료 후 [다시 연결](같은 device_id 로 start → 서버가 credential 을 바꾸고 link·cursor 유지).
* **만료와 폐기를 구분**: 401(만료 또는 Web 에서 해제) → [다시 연결] = 같은 device_id. 서버가 교환에서 409 `device_revoked` 를
  주면 그 id 는 끝 — credential 에 `revoked` 를 남기고(토큰 삭제) 같은 id 로 다시 시도하지 않는다. 사용자가 [새 기기로 등록]을
  고를 때만 device_id 없이 새로 로그인한다. 새 기기로 바뀌면 이전 기기의 연결·UNLINK 는 `<account_key>#device:<이전 id>` 로
  옮겨 보존만 하고(로컬 메모·Outbox·History 그대로, 새 credential 로 보내지 않음) 사용자가 고른 날짜/List 만 다시 연결한다.
* 로그아웃 = `POST logout`(서버가 기기 폐기 → link 모두 비활성) + 로컬 credential 삭제 + 그 계정 연결을 '이 PC 에만' 으로.
  오프라인이면 로컬만 지우고 Web 기기 관리에서 해제하라고 안내한다.
* `plana-memo://` deep link 는 창 활성화만 한다(로그인 callback 으로 쓰지 않는다 — Contract 가 loopback 으로 확정).
  loopback 이라 앱이 꺼져 있으면 callback 을 받을 수 없다(브라우저에 연결 실패) — 앱을 켠 채 다시 로그인한다.

## 검증 상태

| 항목 | 코드 구현 | Mock 검증 | 실제 PLAN-A Work 검증 |
|---|---|---|---|
| DAY/NEXT_LIST link · unlink · Web 이 연결 | 완료 | 완료 | 아직 |
| push · 응답 유실 재전송(idempotency) | 완료 | 완료 | 아직 |
| changes cursor · ACK(이미지 manifest) | 완료 | 완료 | 아직 |
| 이미지 업로드·다운로드(SHA-256) | 완료 | 완료 | 아직 |
| conflict(desktop/web 출처) · stale resolve · 다른 곳에서 해결 | 완료 | 완료 | 아직 |
| 브라우저 로그인 · loopback · PKCE · 재연결 · 로그아웃 | 완료 | 완료(Mock 동의 + 실제 loopback) | 아직 |
| 계정 바꾸기 보호 | 완료 | 완료 | 아직 |
| HTTP 요청 모양(Method·Path·Header·Body·multipart) | 완료 | stub HTTP 서버로 확인 | 아직 |
| https 링크가 있는 메모 | 완료 | 완료(4차: 서버의 URL 위치 검사 규칙으로 Mock 교체) | 아직(서버 수정 완료, 통합 확인 전) |
| 폐기된 기기(device_revoked)·새 기기 등록 | 완료 | 완료(Mock + 실제 loopback) | 아직 |
| 연결된 List 이름 변경 | 이 PC 에만(안내) | 완료 | 서버 API 없음(인계 §2) |

3차 Contract 대조의 항목별 표·테스트 목록: [sync-contract-verification.md](sync-contract-verification.md).
