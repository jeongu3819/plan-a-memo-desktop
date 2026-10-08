# PLAN-A Memo Desktop 연동 구현 기록

코드/테스트/검토용 DDL 단계. 실제 DB migration, staging/production 배포, commit,
push는 실행하지 않았다. 실제 Desktop EXE 통합 완료를 의미하지 않는다.

## 1. 기존 구조 조사

| 영역 | 확인한 구현과 재사용 범위 |
|---|---|
| 주간/날짜/Main/오전/오후 | `PersonalMemoWorkspace`, `PersonalMemoWeekView`, `PersonalMemoDayView`, `PersonalMemoRow` |
| Dashboard·팝업 | `TodayTasksWidget`, `PersonalMemoPanel`, `PersonalMemoHost`, `PersonalMemoDialogs`; 같은 memo API 및 store 사용 |
| 저장·체크·이동·정렬 | `PersonalMemoContext`, `personalMemoStore`, `api/personalMemos.ts`; Backend `services/personal_memos.py` |
| DB | `personal_memos`: 항목 ID, owner, memo_date(NULL=Next), section(main/am/pm), completed, content, sort_order |
| 기존 version | **본문** 저장만 증가. 체크/이동/정렬은 증가하지 않으므로 문서 Sync version으로 대체 사용 불가 |
| client_key | 소유자별 생성 중복 방지 UNIQUE; Desktop 신규 항목도 재사용 |
| 삭제/반복 | 일반 삭제 soft delete; 반복 중지의 미편집 미래 회차는 기존 physical delete. 연결된 문서의 회차는 soft delete로 보존 |
| 이미지 | personal_memo_images 소유권, sanitizer, upload policy, 서버 URL, orphan cleanup, 인증 download 재사용 |
| Rich Editor/Export | RichDescriptionEditor 및 기존 표·서식·붙여넣기·이미지 렌더러와 HTML/ZIP Export 유지 |
| Next List | 기존에는 이름 있는 다중 List 및 list_id가 **없음**. 기존 전체 Next=default List, 새 List membership만 추가 |
| History/검색/즐겨찾기 | 별도 개인 메모 version-history/search/favorite 기능은 현재 코드에 없음. 기존 export/list/삭제복원은 존재. 이번 History는 연결된 문서 버전 및 충돌 보존 |
| 인증 | 기존 get_active_user/Web session 및 SaaS CSRF 재사용. Desktop은 별도 memo-only bearer |

직접 변경 경로도 조사했다: Dashboard today-pick의 text→checklist 변환,
반복 materialization/update/stop, 이미지 본문 변경, 정렬에 의한 날짜 이동.
ORM flush/commit 훅에서 단위를 수집하며, 조건부 Core UPDATE 본문 저장은 명시적으로
mark한다. 문서 변경/스냅샷/변경 목록은 기존 메모 저장과 같은 트랜잭션이다.
오늘 업무 선택 관계, 작업노트로 복사, Export는 메모 본문이 바뀌지 않으면 문서를 올리지 않는다.

## 2. 최종 Sync Unit

`DAY = owner + memo_date`: main/am/pm 전체. `NEXT_LIST = owner + list_id`:
List 전체. 기존 personal_memos를 현재 내용으로 그대로 조회하여 문서를 조립한다.
기존 item ID 변경/전체 복제/backfill 없음. UUID document ID, 별도 정수 version,
기기별 link generation/ACK를 추가했다. Snapshot 테이블은 복구용 이력이다.

## 3. 변경 파일

* Backend: `app/memo_sync_models.py`, `services/memo_sync.py`, `memo_sync_api.py`.
  기존 `models.py`, `main.py` 등록, `personal_memos.py` 연결, `saas_cookies.py`와
  `saas_boundary.py`의 한정된 native 인증 경계, 기존 탈퇴 worker의 FK 정리 순서.
* Frontend: `api/memoSync.ts`, `MemoSyncControl.tsx`, `MemoNextLists.tsx`,
  `pages/MemoDesktopAuthorize.tsx`, App route, 기존 DayView/Context/QuickInput/store,
  Row/Dialogs의 전체 문서 충돌 안내.
* Test: `test_memo_sync.py`, `test_memo_sync_schema.py`, `memoSync.test.tsx`,
  `playwright.memo-sync.config.ts`, `tests/memo-sync/*`.
* 안전 harness: Windows Python 3.12의 OS 정보 조회를 프로세스 차단 설치 전에 캐시.
  DB/HTTP/SMTP/S3/subprocess 격리 예외는 추가하지 않았다.
* Docs: 본 기록, `contracts/memo-sync-v1.md`, `contracts/memo-sync-v1.mysql.sql`.

## 4. DB 변경안 — 미적용

DDL 후보는 [memo-sync-v1.mysql.sql](contracts/memo-sync-v1.mysql.sql).
신규 12개 테이블만 정의하며 기존 personal_memos 컬럼/ID 변경은 없다.

| Table | 주요 컬럼·제약/인덱스 | 목적 |
|---|---|---|
| memo_sync_devices | UUID PK, owner FK/index, namespace, token_hash UNIQUE, expires/revoked | 기기·전용 인증 |
| memo_sync_authorizations | random PK, challenge/state/redirect, code_hash UNIQUE, owner/device FK, expires/consumed | PKCE 일회용 코드 |
| personal_memo_lists | UUID PK, owner FK/index, title | 이름 있는 Next List |
| personal_memo_list_items | memo_id PK/FK, list_id FK/index | 기존 row의 List 소속 |
| memo_sync_documents | UUID PK, owner/namespace/type/key UNIQUE, version/type CHECK | 날짜/List 논리 문서 |
| memo_sync_links | generation UUID PK, document/device FK, device+active+document index, ack_version | 선택적 연결 |
| memo_sync_revisions | PK, document+version UNIQUE, JSON snapshot | 전체 버전 History |
| memo_sync_changes | 정수 PK cursor, device+cursor index, link/document FK, version/kind | 기기별 증분 변경 |
| memo_sync_requests | device+request_id PK, digest/result JSON | push 재전송 |
| memo_sync_conflicts | UUID PK, doc/device FK, source, base/local version, 양쪽 JSON, resolved_version | 전체 비교·보존 |
| memo_sync_image_pins | document+image PK/FK | History 이미지 GC 방지 |
| memo_sync_uploads | device+request_id PK, digest, image FK | 이미지 재전송 |

DDL은 모델에서 **컴파일만** 했고 MySQL에 실행하지 않았다. `test_memo_sync_schema`
테스트가 모델과 DDL 일치를 검사한다. 운영 migration 번호/적용 순서/rollback 실행은
별도 검토가 필요하다. MySQL InnoDB lock·실제 FK/DDL 검증은 아직 하지 않았다.

활성화 전 설정: `AUTO_SCHEMA_INIT=false`, 명시적 namespace/server ID,
`MEMO_SYNC_SCHEMA_READY=true`(승인된 migration 후), 서버/UI feature flag.
일반 사용자에게는 기본 비노출. UI/API flag를 다시 꺼도 SCHEMA_READY와 namespace를
유지하면 버전 추적·History 이미지 보호가 계속된다. 영구 DB에는 적용하지 않았다.

## 5. Sync API

공통 prefix: `/api/memo-sync`. N=`/native`, W=`/web`.
N은 Desktop bearer, W는 기존 Web 인증(+SaaS 쓰기 CSRF). 예외는 N auth/start와
auth/exchange 두 공개 PKCE 경로다. JSON은 extra 필드를 거절한다.
일반 오류: 401 인증/만료/폐기, 403 소유권, 404 비노출/미소유,
409 버전·세대·재전송 불일치, 413 본문 byte 용량, 422 스키마/항목 수·글자 수/참조 검사,
429 rate limit, 503 설정. 1,000항목/항목 500,000자 초과는422, 문서 2,000,000 UTF-8
byte 초과 및 공통 sanitizer byte 상한 초과는413이다.

| Method/path | Request | Response/동작 |
|---|---|---|
| POST N/auth/start | name, challenge(S256), state, redirect_uri, optional device_id | authorization_id, browser_path, namespace, 300초 |
| GET W/auth/request/{id} | path | 기기 이름/redirect 확인, 만료시404 |
| POST W/auth/authorize | authorization_id | 60초 일회용 PLAN-A code 포함 loopback callback |
| POST N/auth/exchange | code, verifier, exact redirect_uri | access_token, device_id, user_id, namespace, expires_in |
| GET W/devices | 없음 | 본인 활성 기기 ID/name |
| DELETE W/devices/{id} | path | revoke, 해당 기기 링크 중단 |
| POST N/logout | 없음 | 현재 기기 revoke |
| POST W/links | type,key,device_id | document_id,link_id,version,status |
| POST N/links | type,key | 토큰 기기에 선택 단위 연결; 동일 재시도 안전 |
| GET W/links | 없음 | 본인의 연결 단위·기기·version·상태 |
| DELETE W 또는 N/links/{id} | path | 데이터 보존, unlinked 변경 이벤트 |
| GET N/changes | optional cursor | 최대100 events, cursor, has_more; 환경/기기 불일치409 |
| GET N/documents/{id} | path | 현재 전체 snapshot, attachments SHA256, link_id/status |
| POST N/documents/{id}/push | base_version,local_version,request_id,link_id,items,deleted | accepted+snapshot 또는 conflict+conflict_id+version |
| POST N/documents/{id}/ack | version,link_id,attachments(이름 목록) | exact 최신 version+manifest 확인; 누락409 |
| POST N/attachments/{request_id} | multipart file | name,url,size; 동일 바이트 재전송 동일 결과 |
| GET N/attachments/{name}/download | path | 소유+연결/업로드 범위 내 이미지 바이트 |
| GET W 또는 N/documents/{id}/conflicts | path | server snapshot, unresolved proposals/source |
| POST W 또는 N/documents/{id}/conflicts/{cid}/resolve | base_version,side(web/desktop) | 선택한 전체 문서 새 version; stale409 |
| GET W/documents/{id}/history | before version(optional) | 최신50 revision snapshots |
| POST W/documents/{id}/history/{version}/restore | base_version | 과거 snapshot을 새 버전으로 복원 |
| GET W/documents/{id}/conflict-history | before UUID(optional) | 보존된 양쪽 conflict snapshots 최대50 |
| POST W/documents/{id}/conflict-history/{cid}/restore | base_version,side | 선택하지 않았던 내용도 복원 |
| GET/POST W/lists | title(POST) | Next 기본/이름 있는 List 메타데이터 |
| POST N/lists | stable UUID id,title | 선택한 신규 List 생성, UUID 재시도 안전 |
| PUT W/lists/{list_id}/items/{memo_id} | 없음 | 기존 ID 유지하며 List 소속 이동 |

Push conflict는 **HTTP 200 + status=conflict**이다(제안을 저장했음).
payload를 바꿔 같은 request_id를 쓰면409. 실패/충돌 후 임의로 최신 base로 덮어쓰지 않는다.
이름 있는 Next 생성은 기존 POST /api/personal-memos에 optional list_id를 추가했다.
기존 API shape는 그대로 유지된다. Desktop API에는 cookie나 body user_id를 사용하지 않는다.

예시 push:

```json
{"base_version":1,"local_version":4,"request_id":"stable-request-0001",
 "link_id":"server-link-generation","deleted":false,
 "items":[{"id":101,"client_key":null,"item_version":1,"section":"am",
   "kind":"checklist","completed":true,"content":"<p>회의 준비</p>","sort_order":1}]}
```

이 items 배열은 해당 문서 **전체**다. 생략한 기존 항목은 soft delete되므로,
개별 항목 patch처럼 사용하면 안 된다. 신규 item은 id를 생략하고 client_key를 제공한다.

## 6. Desktop Auth

시스템 브라우저에서 기존 Google/Naver/이메일 로그인을 사용한다. 새로운 로그인
provider 구현이나 사용자 계정 복제는 없다. Web의 확인 버튼은 기존 CSRF 경계를 통과한다.
PKCE verifier는 Desktop에만 남고 서버에는 challenge가 저장된다. 일회용 코드와
전용 credential은 hash만 DB에 저장한다. credential은 30일 만료; 기존 device_id로
브라우저 재인증하면 폐기되지 않은 기기는 동일 기기/링크를 유지하며 token을 회전한다.
명시적 revoke/logout 이후 동일 ID의 재인증은409 `device_revoked`이며, 새 기기 등록과
선택적 재연결이 필요하다. 만료와 폐기 정책은 계약 문서 참조.

Loopback 선택 근거와 Desktop callback/credential 저장 지침은 계약 문서 참조.
계정 탈퇴/비활성은 매 native 요청에서 거절한다. revoke/logout은 연결된 데이터 자체를
지우지 않는다. 기존 승인된 탈퇴 worker만 신규 FK 종속 메타데이터를 함께 정리하도록 했다.

## 7. Conflict와 Web 자동 갱신

소유자 단위 DB row lock을 먼저 획득한다. base 확인, 메모 수정, revision/change,
request result를 한 트랜잭션에서 기록한다. 다른 사용자끼리는 같은 lock을 쓰지 않는다.
MySQL current-read를 사용하는 문서/메모 조회와 credential 재검증을 적용했다.
SQLite 동시 요청 테스트는 통과했지만 MySQL 실제 동시성 검증을 대체하지 않는다.

Desktop 먼저 저장 후 오래된 Web HTML 저장도 item-version이 일치하는 과거 전체
snapshot을 바탕으로 Web 제안을 보존한다. 임의 HTML 병합 없이 전체 선택으로 해결한다.
기존 row 수준 ‘내 내용 덮어쓰기’ 버튼은 이 경우 차단하고 날짜/List 상단 비교로 안내한다.
늦은 Web 초안까지 서버에 보존된 뒤 비교 선택을 허용한다.

Web memo 화면은 보이는 동안 5초 polling, 기존 Dashboard 업무 카드는 기존 60초
갱신을 사용한다. 열린 편집기/미저장/업로드/실패 초안이 있으면 memo polling을 보류하고,
이미 시작한 조회 응답도 기존 편집 row를 제거하지 못하도록 한다.

## 8. 테스트 결과

* 사전 안전성: database safety **26 passed**. 최종 통합 안전/메모/권한/Sync/
  schema suite **256 passed** (DB/HTTP/SMTP/S3 격리, 임시 SQLite).
* Frontend UI·Export·날짜·preview·Rich Paste·표·Dashboard: **114 passed**.
* TypeScript type-check, production build, 새 UI 파일 ESLint 통과.
* Chromium UI **3 passed**: 날짜 연결/ACK 대기/전체 비교, polling/실패 초안 보호,
  Next List별 연결/기기 없음 안내. 모든 API mock, Backend/EXE는 실행하지 않음.
* DDL 생성은 공식 standalone isolation harness를 사용했고 실제 sidecar 무변경 확인.
* 최종 충돌 계약/credential 점검 후 집중 재실행: Sync+schema **18 passed**,
  UI **6 passed**. 위 전체 테스트 수에 중복 합산하지 않는다.

재현 명령(저장소 root, Frontend 명령은 frontend 디렉터리):

```text
python -X utf8 -m pytest backend/tests/test_database_safety.py backend/tests/test_resource_safety.py backend/tests/test_memo_sync.py backend/tests/test_memo_sync_schema.py backend/tests/test_personal_memos.py backend/tests/test_personal_memo_today_picks.py backend/tests/test_personal_memo_client_acl.py -q --disable-warnings
npx vitest run tests/memoSync.test.tsx tests/personalMemoExport.test.ts src/utils/personalMemoDates.test.ts src/components/personalMemo/personalMemoPreview.test.ts tests/mixedPaste.test.ts tests/tableAutoFitColumn.test.ts src/components/today/TodayTasksWidget.voc.test.tsx
npx playwright test --config=playwright.memo-sync.config.ts
npm run build
```

현재 Windows에서는 PATH의 python 대신 설치된 Python312 실행 파일을 사용했다.
pytest 임시 폴더 OS 권한 문제는 승인된 실행으로 해결했으며 conftest/격리를 우회하지 않았다.
빌드에는 기존 Browserslist 데이터·lottie eval·번들 크기 경고가 남아 있다.

Sync 테스트는 선택 단위, 세 section, 체크/본문/정렬/이동/삭제/복원/반복,
기기 꺼짐 후 cursor 조회, offline push 재시도, 동시 요청, 양방향 충돌,
오래된 해결 거절, 다른 문서 진행, losing History 복원, 이미지 ACK/업로드 재전송,
unlink/relink 세대, PKCE/replay, 타 계정, revoke, 환경, SaaS cookie 경계,
기기 재인증 및 UI 비활성 중 버전 보존을 확인한다.

아직 미검증: 실제 EXE/SQLite queue/Windows listener/자격증명 저장/파일 fsync,
실제 Google/Naver 로그인 callback 연쇄, 실제 S3 전송, MySQL migration·격리 수준,
실제 Web+Backend+EXE를 연결한 장시간 네트워크 단절 통합 E2E.
Frontend 브라우저 테스트는 API mock을 사용하며 Backend 통합/EXE 테스트로 간주하지 않는다.
현재 안전 harness는 Backend 네트워크 서버 실행을 허용하지 않으므로 기존 live-backend
Playwright 스크립트는 우회해서 실행하지 않았다. 회귀 범위와 미검증 범위를 구분한다.

## 9. Desktop 저장소 인계

[memo-sync-v1.md](contracts/memo-sync-v1.md)의 순서를 구현 기준으로 전달한다.
로컬 저장은 로그인과 독립적이다. 가입/기기등록만으로 메모 목록을 올리거나 받지 않는다.
선택 단위의 전체 내용과 필요한 이미지에 한해 link/push/pull한다.
동일 이름·날짜에 local-only 내용이 있으면 첫 pull로 덮지 말고 base=0 제안으로 비교한다.
ACK는 로컬 document+image 저장 완료 후 별도 전송한다.

## 10. 경계 동작과 남은 검증

* 연결 날짜→미연결 날짜: 원본 문서 제거만 전송. 목적 날짜의 기존 메모는 연결·다운로드하지 않음.
* 두 연결 날짜 이동: 같은 트랜잭션에서 양쪽 version/change 기록. 기존 ID 유지.
* 다른 unit으로 이미 옮겨진 ID를 오래된 Desktop push/history가 요구하면409.
  현재 목적지 메모를 되가져오거나 복제하지 않음. 사용자가 현재 위치를 확인한 뒤
  Web에서 명시적으로 이동해야 한다. 이 보수적 v1 제약은 계약에 명시했다.
* Next의 과거 데이터는 default List로 해석하며 backfill/ID 변경 없음.
* 이미지 이외의 일반 바이너리 첨부는 기존 개인 메모 모델에 없으므로 이번 API는 기존
  inline image 정책/형식만 지원한다. 임의 파일 첨부가 필요하면 별도 제품 확장이 필요하다.
* history/change/idempotency/upload 기록 자동 만료/물리 청소는 구현하지 않았다.
  삭제 때문에 offline 단말의 cursor 또는 history 이미지를 깨뜨리지 않기 위해 보존한다.
  장기 운영 전 보존량/quota/기기 폐기 후 보존 정책 검토가 필요하다.
* Web History UI는 최신50개를 표시하고 API는 이전 페이지를 조회할 수 있다.
* 실제 EXE 및 MySQL 통합 검증 전 일반 사용자에게 feature flag를 켜지 않는다.
