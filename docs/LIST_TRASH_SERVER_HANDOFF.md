# 공통 List 관리 — PLAN-A Work(`outside` 브랜치) 개발 인계서

**목표 정책:** List 는 어디에서 만들고, 이름을 바꾸고, 삭제하고, 복구하든 연결된 모든 기기에서 같게 관리된다. 휴지통 보존은 7일이며 그동안 메모·이미지·History 를
보존하고, 영구 삭제하면 함께 삭제한다. Local-only List 는 사용자가 연결하기 전까지 그 PC 에서만 관리한다.

> **읽는 법.** 이 문서의 API·DTO·테이블은 **제안**이다. 서버 사실은 이 저장소의 사본(`docs/upstream-plan-a-work/`)으로만 확인했고 `outside` 브랜치는 보지 못했다.
> 실제 코드와 다르면 코드를 기준으로 고친다. 표시: **[확인]** Desktop 코드·테스트로 확인 · **[사본]** upstream 사본 기준 · **[제안]** 아직 어디에도 없음.

## 0. 서버 지원 전 임시 동작과 최종 목표

| 동작 | 지금(임시, Desktop 만) **[확인]** | 최종 목표 |
|---|---|---|
| Local-only List 이름 변경·삭제·복구·영구 삭제 | 정상 동작. 서버에 아무것도 보내지 않음 | 같음 |
| 연결된 List 이름 변경 | **막힘**(`linked_list_managed`) + 안내 | 모든 기기에 같은 이름 |
| 연결된 List 삭제 | **막힘** + 안내. 연동을 해제하면 이 PC 의 List 로 삭제 가능(서버 사본은 그대로) | 공통 휴지통 |
| 연결된 List 복구 | **없음** | 모든 기기에서 복구, 연결 유지 |
| 이전 WIP 빌드에서 지운 연결 List(`was_linked=1`) | **보존만**: 복구·영구 삭제·7일 만료 모두 안 함. 대기 중인 삭제 전달은 폐기하지 않고 기존 재전송 규칙대로 전송 | §14 에서 공통 상태로 편입 |
| Web 에서 지운 연결 문서(tombstone) | 기존 그대로: 메모 비움 + History 보존. List 탭은 남음. 휴지통에 안 들어감 | 공통 휴지통 |

이 임시 동작 때문에 지금은 **Web 에서 삭제가 Desktop 휴지통으로 오지 않고**, Desktop 에서는 연결된 List 를 지울 수 없다. 서버가 준비될 때까지의 제약이다.

## 1. 현재 Web/Desktop List 모델 비교

| 항목 | Web/서버 **[사본]** | Desktop **[확인]** |
|---|---|---|
| List | `personal_memo_lists(id, owner_user_id, title)` — 삭제 컬럼 없음 | `next_lists(id, name, is_default, sort_order, deleted_at, …)` |
| 기본 Next | 행 없음. key `default` | 고정 UUID `00000000-0000-4000-8000-000000000001` |
| 메모 | `personal_memos` + `personal_memo_list_items(memo_id PK, list_id)` | `memo_items(document_id, section='next', …)` |
| 문서 단위 | `memo_sync_documents(owner, namespace, type, key, version, deleted)` | `documents(kind, next_list_id, local_revision, server_version, sync_enabled, deleted_at)` |
| List 순서 | 서버 모델에 **없음**(확인 필요) | `next_lists.sort_order` — 이 PC 값 |
| 이름 길이 | 최대 120자(`NativeListCreate`) | 최대 100자 — **맞춰야 함** |
| 이름 변경·List 삭제 API | **없음** — `web/lists` 는 GET·POST, `native/lists` 는 POST 뿐 | 로컬에만 있음 |
| 휴지통 | 없음 | `list_trash`, 7일 |
| 영구 삭제 | 없음(History 로 복원 가능한 tombstone 만) | 있음 |

## 2. 기존 Sync v1/v2 계약과의 관계

* v1 **[사본]**: 문서 삭제는 tombstone(`deleted=true`, 빈 items) 이고 복원 가능한 History 가 남는다. "Delete/edit is a normal whole-document conflict, never an automatic resurrection." — 그래서 Desktop 은 `deleted=false` Push 로 되살리지 않는다.
* v1 **[사본]**: "Next List title is response-only." 같은 id 로 다른 title 을 `POST native/lists` 하면 409. 양방향 이름 변경은 base version·request ID·문서 단위 충돌을 써야 하고 last-write-wins 는 금지.
* v2 **[사본]**: 날짜 관리(복사·알림)용. List 관리는 없음. Native `/native/v2`, 별도 cursor, 3개 부가 테이블. Desktop 은 지원 여부를 탐지해 기능을 켠다(`sync/management.rs` capability, TTL 있음) **[확인]**.
* **제안**: 기존 계약을 바꾸지 말고 추가한다(가칭 `memo-sync-v3` 또는 v2 확장). 서버가 지원을 알리지 않으면 Desktop 은 §0 의 임시 동작을 유지한다.

## 3. 필요한 서버 API·DTO 제안 **[제안]**

경로는 기존 관례를 따른 예시다. Native 는 기기 토큰, Web 은 세션·CSRF.

| 기능 | Native(예시) | 요청 | 응답 |
|---|---|---|---|
| 지원 확인 | `GET /native/v3/capabilities` | — | `{list_management: true, retention_days: 7}` |
| 이름 변경 | `POST /native/v3/lists/{id}/rename` | `{title, base_list_version, request_id}` | `ListState` / 409 conflict |
| 삭제(휴지통) | `POST /native/v3/lists/{id}/trash` | `{base_list_version, request_id}` | `ListState` |
| 복구 | `POST /native/v3/lists/{id}/restore` | `{base_list_version, request_id}` | `ListState` / 409 `trash_expired` |
| 영구 삭제 | `POST /native/v3/lists/{id}/purge` | `{base_list_version, request_id}` | `{id, purged_at}` |
| 휴지통 목록 | `GET /native/v3/lists/trash` | — | `ListState[]` |
| 변경 조회 | `GET /native/v3/lists/changes?cursor=` | opaque cursor | `{events[], cursor, has_more}` |

```jsonc
// ListState
{
  "id": "uuid",                // 복구해도 바뀌지 않는다
  "title": "메모 개선",
  "list_version": 12,          // 이름·휴지통 상태용. 문서 version 과 별개
  "state": "active",           // active | trashed
  "trashed_at": null,          // 서버 시각(UTC)
  "purge_after": null,         // 서버가 정한 만료 시각 — 클라이언트 시계로 계산하지 않는다
  "document_id": "uuid",
  "document_version": 41
}
// 변경 이벤트
{ "cursor": "…", "list_id": "uuid", "list_version": 12,
  "kind": "renamed", // created | renamed | trashed | restored | purged
  "title": "메모 개선", "purge_after": null }
```

Web 쪽에도 같은 동작과 휴지통 화면(이름·메모 수·삭제일·만료일·복구·영구 삭제)이 필요하다.

## 4. 공통 List ID 관리

* List ID 는 만든 쪽의 UUID 를 그대로 쓰고(`POST native/lists` 재시도 안전 **[사본]**) 삭제·복구·이름 변경에도 바꾸지 않는다.
* 기본 Next(`default`) 는 이름 변경·삭제·연결 해제 대상이 아니다 — 서버도 거절한다.
* 복구는 새 List·새 문서를 만들지 않는다. 같은 `document_id`·같은 항목 id·같은 link generation.

## 5. Soft Delete / Restore / Purge

```
active ──trash──▶ trashed ──restore──▶ active
                     │
                     └──purge(사용자 또는 purge_after 경과)──▶ purged(tombstone 만 남음)
```

* **trash**: 문서·항목·이미지·History 를 그대로 두고 상태만 바꾼다. **link 를 끊지 않는다** — 지금의 tombstone(연결 종료)과 가장 큰 차이다.
* **restore**: 상태만 되돌린다. 항목·완료 상태·순서·이미지 그대로.
* **purge**: 메모·이미지·History 삭제, tombstone 보존(§7). **만료 정리는 서버 일괄 작업**이 한다 — 기기가 꺼져 있어도 진행된다.
* 보존 기간은 서버의 `purge_after` 가 기준이다. 클라이언트는 표시만 한다.
* **휴지통 상태에서 쓰기**: 메모 Push 는 거절(`409 list_trashed`). 내용은 버리지 않고 해당 기기가 보관·안내한다(§9).

## 6. History / Attachment 보존

* 휴지통 동안: 서버 이미지 pin(`memo_sync_image_pins` **[사본]**) 을 유지한다. 이미지 정리 작업에서 제외한다.
* 영구 삭제: 그 List 문서의 revisions·conflicts·pins 를 지운다. **이미지는 다른 메모·문서·날짜가 참조하지 않을 때만** 지운다(이름 기반 공유 가능성 확인 필요).
* Desktop 참고 **[확인]**: Backup 은 DB 만 복사하고 이미지는 참조만 한다. 그래서 영구 삭제한 이미지 파일은 대기표(`purged_attachments`)에 올렸다가 **참조하는 Backup 이 사라진 뒤** 지운다.
  서버 Backup 에도 같은 문제가 있으면 정책을 정해야 한다(§16).

## 7. Tombstone 및 Cursor

* 영구 삭제 뒤에도 `list_id`·`document_id`·소유자·`purged_at`·마지막 version 을 기록으로 남긴다(내용 없음). **보존 기간은 활성 기기의 cursor 보존 기간 이상**이어야 한다.
* 오래된 오프라인 기기가 그 List 로 Push·Link·`POST lists` 하면 `410 list_purged` 로 거절한다 — 다시 만들어지면 안 된다. 기기는 자기 사본을 "서버에서 영구 삭제됨" 으로 보관·안내하고, 자동으로 지우거나 올리지 않는다.
* cursor 는 기존처럼 기기별 opaque 값이다 **[사본]**. 이벤트를 먼저 정리해 cursor 가 만료되면 `410 cursor_expired` 후 전체 List 상태를 다시 받는다.
* 변경 이벤트는 **List 상태 → 문서 내용** 순서로 적용 가능해야 한다.

## 8. Idempotency

* 모든 변경은 기기별 `request_id` 를 쓴다. 같은 id·같은 내용 = 처음 결과 재반환, 같은 id·다른 내용 = 409 **[사본 규칙과 동일]**.
* 이미 trashed 인 List 에 trash, 이미 active 인 List 에 restore, 이미 purged 인 List 에 purge 는 성공(현재 상태 반환)으로 처리한다 — 두 기기가 동시에 눌러도 오류가 아니다.
* Desktop 은 요청 전체를 Outbox 에 저장한 뒤 보내고, 응답을 잃으면 같은 요청으로 재전송한다 **[확인]**.

## 9. 동시 변경 Conflict

시각으로 승패를 정하지 않는다(last-write-wins 금지). `list_version` 을 비교한다.

| 상황 | 처리 **[제안]** |
|---|---|
| 이름 변경 vs 이름 변경 | 나중 요청 409, 양쪽 이름을 보여 사용자가 고른다 |
| 이름 변경 vs 삭제 | 삭제 유지. 이름 변경 409(복구 후 다시) |
| 삭제 vs 메모 수정(오프라인) | 수정을 버리지 않는다. Push 는 `409 list_trashed` → 기기는 사용자에게 "복구하고 적용 / 내용만 이 PC 에 보관" 을 묻는다 |
| A 복구 vs B 영구 삭제 | 서버에 먼저 도착한 쪽. 나중 요청은 `trash_expired`/`list_purged` 또는 현재 상태 |
| 오프라인 중 삭제 → Web 수정 → 재연결 | base 가 오래됐으므로 trash 409. 자동 삭제하지 않고 재확인 |
| 만료 후 복구 요청 | `409 trash_expired`. 기기 사본은 지우지 않고 안내 |
| 삭제·복구 재전송 | §8 로 처음 결과 반환. 이전 데이터를 복원하지 않는다 |

## 10. 권한 및 소유자 검증

* 모든 경로에서 `owner_user_id` 와 namespace 를 검증한다. 남의 List 는 존재 여부도 알리지 않고 404 **[사본 규칙과 동일]**.
* Native 는 활성 link 가 있는 기기만 그 List 를 변경할 수 있게 할지 결정이 필요하다 — **제안**: 활성 link 필수. 폐기된 기기·끝난 link generation 의 요청은 거절.
* 영구 삭제는 Web·Native 모두 사용자 확인 후에만. 제목은 표시용 입력으로 검증(길이 1~100 으로 통일 제안, 제어 문자 거절).

## 11. Local-only 보호

* 연결하지 않은 List·메모·이름·이미지는 서버로 올리지 않는다 — 이 PC 의 삭제·복구·영구 삭제도 요청 0건 **[확인: `local_only_list_trash_never_talks_to_the_server`]**.
* 복구가 연결을 만들지 않는다. 계정 로그인이 Local-only List 를 올리지 않는다.
* 서버가 새 기능을 지원하게 되어도 자동 연결·일괄 업로드를 하지 않는다.

## 12. DB Migration 후보 **[제안]**

* `personal_memo_lists` 추가: `version INT NOT NULL DEFAULT 1`, `state`(active/trashed), `trashed_at`, `purge_after`, `trashed_by_device_id NULL`, `updated_at`. 인덱스 `(state, purge_after)`.
* 신규 `personal_memo_list_tombstones(list_id PK, owner_user_id, document_id, purged_at, last_version)`.
* 신규 `personal_memo_list_changes(id, owner_user_id, list_id, list_version, kind, title NULL, purge_after NULL, created_at)`. 또는 기존 `memo_sync_changes` 재사용 — 단 `kind VARCHAR(16)`·기기별 구조·link FK 를 확인할 것(링크 없는 Web List 변경은 담기 어렵다).
* 요청 멱등성은 기존 `memo_sync_requests` 재사용 검토.
* 기존 테이블은 additive 만. 기능 플래그 + 미적용 서버에서 새 테이블을 조회하지 않게(기존 v1/v2 방식).

## 13. 기존 데이터 Migration 정책

* **이미 있는 v1 tombstone(`memo_sync_documents.deleted=1`)**: 자동으로 복구 가능하게 만들지 않는다. 기존 History 로 복원 가능한 상태 유지. 공통 휴지통으로 옮길지(삭제 시각을 알 수 없어 7일 계산 불가)는 **서버 쪽 결정 필요** — 제안: 그대로 두고 신규 삭제부터 적용.
* **기존 List 행**: `state=active, version=1`.
* **이름 불일치**: 예전 Desktop 빌드에서 연결된 List 의 이름을 로컬에서만 바꾼 경우 서버 title 과 다를 수 있다. **어느 쪽도 자동으로 덮어쓰지 않는다.** 첫 동기화에서 다르면 사용자에게 고르게 한다. 사용자가 고르기 전에는 각자 이름 유지.
* **Desktop `was_linked=1` 휴지통 행**: §14.
* 이름 길이 120자 → 100자로 줄이지 않는다. Desktop 쪽 표시·제한을 맞춘다.

## 14. Desktop 연동에 필요한 후속 수정 **[제안]**

1. capability 탐지 추가(`sync/management.rs` 방식). 지원 없음 = §0 임시 동작 유지.
2. `service::rename_list` · `trash::move_to_trash` · `trash::restore` · `trash::purge` 의 `LINKED_MANAGED_CODE` 제한을 capability 조건으로 바꾸고 Outbox 작업(`LIST_RENAME`·`LIST_TRASH`·`LIST_RESTORE`·`LIST_PURGE`) 추가. `sync_outbox.op` 의 CHECK 제약을 바꾸려면 테이블 교체 Migration 이 필요하다.
3. List 변경 이벤트 처리 — 이름 반영, 휴지통 이동·복구·영구 삭제 반영. `purge_after` 는 서버 값 저장(`list_trash` 재사용).
4. `sync/engine.rs` 의 `deleted` → `disable_link` 경로는 capability 가 없을 때만.
5. **`was_linked=1` 행 편입**: 서버 상태를 조회해 판단한다 — 서버가 trashed 면 공통 휴지통으로, 서버가 tombstone 만 있으면 사용자에게 "이 PC 내용으로 다시 연결(첫 연결 비교) / 영구 삭제" 를 묻는다. 자동 재연결·자동 삭제 금지.
6. 화면: `NextListTabs` 메뉴 제한 해제, 휴지통에 공통 상태 표시, Conflict 안내(§9).
7. 이름 길이 정책 통일.

## 15. 구버전 클라이언트 호환

Desktop 0.2.3 이하가 새 서버와 만나도 List 가 손상되면 안 된다. 코드로 확인한 동작 **[확인]**:

| 구버전 동작 | 근거 | 서버가 할 일 |
|---|---|---|
| 응답의 모르는 필드 무시 | `WireDocument`·`ChangeEvent` 에 `deny_unknown_fields` 없음 | 필드 추가 가능 |
| **요청은 엄격** | `PushRequest`·`LinkRequest`·`NativeListCreate` 가 `deny_unknown_fields` | 기존 요청 형식 유지(새 필드를 필수로 만들지 말 것) |
| 모르는 `kind` 이벤트 | `record_event` 의 나머지 분기: 같은 link 면 version 이 클 때 문서를 다시 받음 | v1 cursor 에는 기존 kind 만 보내는 쪽을 권장 |
| 문서 받기에서 `deleted=true` | 메모를 비우고 History 보존, List 탭 유지 | trashed 문서를 구버전에는 tombstone 처럼 보낼지 결정(비워지지만 History 보존) |
| List 삭제 시 tombstone Push 후 연결 해제 | 0.2.3 은 메모를 기본 Next 로 옮긴 뒤 전송 | v1 tombstone Push 를 **trash 로 취급**하고 영구 삭제하지 말 것 |
| 없어진 List 로 `POST native/lists` | 409 를 "이미 있음" 으로 보고 연결 진행 | `list_purged` 는 409 가 아닌 **410/404** 로 — 409 면 구버전이 계속 link 를 시도한다 |

* **구버전이 공통 관리를 우회하지 않게**: v1 Push 에는 이름 필드가 없어 이름은 바꿀 수 없다. 휴지통 상태 List 로 오는 v1 Push 는 거절하고 문서 단위 충돌로 처리한다.

## 16. 서버 측 결정이 필요한 항목

1. 서버 Backup 보존 기간과 개인정보 삭제 정책(영구 삭제 후에도 Backup 에 남는 기간). Desktop 은 자동 Backup 최대 20개·1GB 동안 내용과 이미지가 남는다.
2. 기존 v1 tombstone 의 처리(§13).
3. Native 변경에 활성 link 를 요구할지(§10).
4. List 순서(`sort_order`)를 공통으로 할지 — 지금 정책 범위 밖이며 Desktop 은 이 PC 값.
5. 만료 일괄 작업 주기와 cursor·tombstone 보존 기간(§7).
6. Mobile 이 같은 Native API 를 쓰는지.

## 17. 실제 Web/Desktop E2E 시나리오

**실행 환경: Staging 전용. Production 서버 시험 금지.** 각 시나리오는 2개 기기(Desktop A·B) + Web 브라우저 1개.

| # | 시나리오 | 기대 결과 |
|---|---|---|
| 1 | Desktop A 에서 연결 List 이름 변경 | B·Web 에 같은 이름. 메모·이미지·List ID·link 유지 |
| 2 | Web 에서 이름 변경 | A·B 자동 반영 |
| 3 | A·Web 동시 이름 변경 | 나중 요청 충돌 → 고른 이름으로 수렴 |
| 4 | A 에서 삭제 | Web·B 휴지통에 표시, 활성 목록에서 사라짐. link 유지 |
| 5 | Web 에서 복구 | A·B 복구. 메모·이미지·완료·순서·History·연결 그대로, 새 List 없음 |
| 6 | A 오프라인 중 삭제 + Web 에서 수정 → A 재연결 | 어느 쪽도 사라지지 않음, 재확인 |
| 7 | A 오프라인 중 수정 + Web 에서 삭제 → A 재연결 | 수정 보존, 복구 여부 질문 |
| 8 | 삭제 후 만료(시각 조작) → A 재연결 | 서버 purge, A 는 안내. A 가 다시 올리지 않음 |
| 9 | 만료 뒤 A 에서 복구 시도 | `trash_expired` 안내, 이전 데이터 복원 없음 |
| 10 | 삭제·복구 응답 유실 → 재전송 | 한 번만 적용 |
| 11 | 영구 삭제 | 그 List 이미지 삭제, **다른 List·날짜가 쓰는 이미지는 유지** |
| 12 | 영구 삭제 후 오래된 기기 재연결 | 410, List 재생성 없음 |
| 13 | Local-only List 이름 변경·삭제·복구·영구 삭제 | 서버 요청 0건 |
| 14 | 구버전 Desktop(0.2.3) + 새 서버 | §15 표대로. List 손상 없음 |
| 15 | 다른 계정·폐기된 기기 | 거절, 데이터 변화 없음 |

## 18. 검증 상태

* Desktop 의 §0 임시 동작: Rust 테스트 + Windows 앱 E2E(**Mock 서버**) 로 확인.
* **실제 PLAN-A Work 서버(Staging 포함)로는 확인하지 않았다.** §3 이후의 공통 기능은 어디에도 구현되어 있지 않다.
* 서버 사실은 저장소 사본 기준이다 — `outside` 브랜치의 실제 코드로 먼저 대조할 것.
