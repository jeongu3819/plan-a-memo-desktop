# Memo Desktop 실제 연동 전 검토 — 2026-10-08

기준 코드: outside `ccb4998` 이후 이번 미커밋 변경. 입력은 사용자가 제공한
`handoff/PLAN_A_WORK_SYNC_HANDOFF.md`이며 원본은 수정하지 않았다. Desktop 0.2.1의
Rust/Frontend/Mock E2E/Installer 결과는 인계받은 결과이고 이 저장소에서 재검증하지 않았다.
이 문서는 코드 수정·오프라인 검증·향후 적용 준비 결과다. 실제 DB 접속, migration,
서버 시작, Staging/Production 배포, 계정 생성, commit/push를 수행하지 않았다.

## 1. 경로 검사 오류와 수정

기존 `(?:file:|[A-Za-z]:[\\/])`는 HTML 전체에 적용되어 https의 `s:/`, http의
`p:/`, profile의 `file:`을 검출했다. 반대로 UNC 링크는 놓쳤다. 인계서 12개 사례를
API TestClient에서 재현했으며 수정 전 **5 failed / 7 passed**, 수정 후 **12 passed**다.

이제 URL이 쓰이는 HTML 속성 및 srcset과 CSS url()을 검사한다. HTMLParser의 entity
해석과 tinycss2의 CSS escape/token 해석을 사용한다(tinycss2는 기존 bleach[css] 의존성).
공통 sanitizer가 잘못된 참조를 조용히 없애기 전 원본과 정리 후 결과를 둘 다 검사한다.
로컬 drive/file/UNC, protocol-relative, blob/data/attachment, 미허용 scheme을 거절한다.
명시적 HTTPS/HTTP와 상대 링크는 유지한다. 일반 글자 `profile:`과 경로를 설명하는
text node는 허용한다. 이미지 URL은 기존 개인 메모 소유권 검사까지 통과해야 한다.
Rich Text/표 정리는 기존 sanitizer 그대로이며 Web 저장 정책은 바꾸지 않았다.

참조 검사 오류는422 `detail={code: local_path_not_allowed|reference_not_allowed,
item: 0부터 시작하는 index}`다. 경로/본문을 오류에 싣지 않는다. 실패 시 문서 전체
transaction이 취소되고 revision/request record가 생기지 않는다. 그 요청 ID로 고친
본문을 다시 전송할 수 있다. 기존 accepted/conflict의 요청 ID는 여전히 불변이다.

## 2. 인계서 확인 요청 A–E

| 항목 | 확인 및 최종 동작 |
|---|---|
| A Conflict source | ORM에 `default='desktop'`가 이미 있어 NOT NULL 500은 재현되지 않음. Native 생성에 `source='desktop'`를 명시하여 ORM 암묵 의존 제거. Web=`web`. DAY/NEXT_LIST × 두 출처 × 양쪽 선택 8개 테스트로 전체 선택/History 검증 |
| B ACK Manifest | attachments()는 이미 전체 문서 이름 set → sort. 한 이미지를 3개 section에서 각 2번 써도 manifest 1개. Desktop의 중복 없는 ACK와 일치. ACK 자체의 중복/누락/추가 이름은409 `attachments_incomplete`; 순서는 무관 |
| C 크기 | item 500,000자/1,000개 초과422. 전체 content UTF-8 2,000,000byte 초과413. 공통 sanitizer 기본 raw 1MiB / sanitized 256KiB 초과도413(설정 가능). 구조/이미지 개수422. 500,000자까지 무조건 저장 가능하다는 뜻이 아님 |
| D 이동한 항목 | 현재 base에서 다른 unit 소속 ID 요구409 `item_moved_or_not_owned`; 기존 client_key 가로채기409 `client_key_in_use`. 오래된 base는 먼저200 conflict로 보존, 그 제안을 선택할 때도 동일409. 자동으로 목적지를 연결하거나 항목을 되가져오지 않음 |
| E 폐기/만료 | 만료는 같은 ID 재인증 가능, token만 회전하며 links/cursor 유지. 명시적 Web revoke/native logout은 ID를 영구 폐기. consent/exchange에서409 `device_revoked`. 폐기 전에 발급된 미사용 code도 차단. 새 명시적 로그인에서 ID를 생략하면 새 기기 등록은 가능하지만 이전 링크/큐를 자동 승계하지 않음 |

exchange도 credential 검증과 동일하게 최초 조회의 read snapshot을 끝낸 뒤 owner lock을
얻고 authorization/device/user를 current-read한다. 폐기와 교환의 MySQL stale-read
위험을 줄였으며 실제 MySQL 동시 실행은 아래 별도 검증 대상이다.

보존 회귀에서 추가 발견한 문제: 동일 항목을 ID와 client_key로 각각 지정하면 한
snapshot 안에서 두 번 수정되었다. 이제 literal 중복뿐 아니라 같은 row로 해석되는
별칭 중복도422로 거절하며 부분 저장/버전 증가는 없다.

## 3. 파일 범위

- Backend: `backend/app/services/memo_sync.py`, `memo_sync_api.py`.
- Tests: `backend/tests/test_memo_sync.py`, `test_memo_sync_schema.py`.
- Docs: 이 문서, `MEMO_SYNC_IMPLEMENTATION.md`, `contracts/memo-sync-v1.md`,
  `contracts/memo-sync-v1.mysql.sql`, 신규 `contracts/memo-sync-v1.verify.sql`.
- Frontend/모델/startup/공통 Web sanitizer: 변경 없음.
- 사용자 WIP: `docs/handoff/PLAN_A_WORK_SYNC_HANDOFF.md` 그대로 보존.

## 4. 실행한 검증과 한계

| 실행 | 결과 |
|---|---|
| database_safety + resource_safety | 54 passed; 기존 9개 테스트 안전 조건과 외부 I/O 격리 유지 |
| 인계서 12개 API 사례 | 수정 전5실패/7통과 → 수정 후12통과 |
| Sync + schema + 기존 personal_memos + today_picks + client_acl | 최종 262 passed (그 안에 Sync 75개, schema 3개 포함) |
| 공식 격리 standalone DDL renderer | PASS; SQL 파일만 생성, DDL 실행 없음. 실제 data.json sidecar 무변경 |

명령은 저장소 root의 `python -X utf8 -m pytest`를 사용했다. Windows에서는 설치된
Python312 절대 경로를 사용했다. pytest 임시 폴더 접근은 승인된 실행으로 처리했으며
root conftest/ENV_MODE=test/임시 SQLite/dotenv 금지/외부 서비스 guard를 우회하지 않았다.
테스트 확대 중 공용 IP rate bucket이 소진된 것은 테스트 fixture의 synthetic secret을
사례별로 분리하여 해결했다. 실제 limiter는 그대로 실행된다. 기존 deprecation 경고는 남는다.
최종 점검에서 CSS 참조 탐색은 반복문으로 처리해 깊은 중첩에도 Python 재귀 한계로
500이 나지 않게 했고, 1,200단계 중첩의 로컬 URL 거절을 포함해 전체 회귀를 다시 통과했다.

재현 명령(root, 기본 Python이 없으면 설치된 Python312 실행 파일 사용):

```text
python -X utf8 -m pytest backend/tests/test_database_safety.py backend/tests/test_resource_safety.py -q --disable-warnings
python -X utf8 -m pytest backend/tests/test_memo_sync.py backend/tests/test_memo_sync_schema.py backend/tests/test_personal_memos.py backend/tests/test_personal_memo_today_picks.py backend/tests/test_personal_memo_client_acl.py -q --disable-warnings --tb=short
```

검증 범위: DAY 3개 section, Next List 독립성, full snapshot 누락의 soft delete 의미,
item/document version 분리, 체크/이동/정렬/복원/반복, request retry/concurrency,
link generation, cursor, 이미지 SHA/누락/중복 ACK, offline 누적 변경, 최초 연결 conflict,
출처/양쪽 선택/삭제 충돌/오래된 해결/History, PKCE/code replay/만료/revoke,
사용자/namespace 경계, API flag OFF 상태의 버전 추적/History 이미지 pin.

**Mock/TestClient + SQLite 결과이며 실제 MySQL/S3/OAuth/Windows EXE 통합 완료가 아니다.**
Frontend는 이번 변경 없음. 기존 UI E2E 결과는 이전 구현 보고서의 결과이며 이번 서버
검증에서 실제 브라우저 로그인이나 EXE를 실행하지 않았다. live integration 허용을 위해
현재 offline pytest guard를 약화하거나 우회하지 않는다.

## 5. DDL 검토

| 테이블 | FK / 주요 제약·Index / 목적 |
|---|---|
| memo_sync_devices | users FK, owner index, token_hash UNIQUE; 기기/credential/폐기 |
| memo_sync_authorizations | users/device FK, code_hash UNIQUE, authorization PK; TTL/PKCE/code |
| personal_memo_lists | users FK/owner index, UUID PK; 이름 있는 Next |
| personal_memo_list_items | memo PK+FK, list FK/index; 한 row는 한 List 소속 |
| memo_sync_documents | users FK/index, owner+namespace+type+key UNIQUE, type/version CHECK |
| memo_sync_links | document/device FK+index, device+active+document index; 세대/ACK |
| memo_sync_revisions | document FK/index, document+version UNIQUE; 전체 History |
| memo_sync_changes | device/link/document FK, device+id cursor index; 증분 전달 |
| memo_sync_requests | device FK, device+request_id PK; Push 중복 방지 |
| memo_sync_conflicts | document/device FK, document index, source NOT NULL; 제안/양쪽 History |
| memo_sync_image_pins | document/image FK, 복합 PK; History 첨부 보호 |
| memo_sync_uploads | device/image FK, device+request_id PK; Upload 중복 방지 |

12개 모두 신규 CREATE이며 기존 users/personal_memos/personal_memo_images ALTER,
backfill, ID 재할당이 없다. 부모가 먼저 나오는 순서와 FK의 signed INT/UUID 길이를
모델 기준으로 테스트했다. CASCADE 삭제 없음. 필요한 FK child index는 명시적 index/PK
또는 InnoDB가 생성하는 FK index로 충족한다. 링크 활성 pair 중복 및 cross-owner/cross-
namespace 일치는 단순 FK만으로 보장되지 않으므로 owner lock과 서비스 검사로 보장한다.
읽기 전용 검증 SQL에 이 무결성의 aggregate 확인도 포함했다.

후보의 요구 버전은 **MySQL 8.0.16 이상 / InnoDB**다. 이전 버전은 CHECK를 강제하지
않는다([MySQL CHECK 문서](https://dev.mysql.com/doc/refman/8.0/en/create-table-check-constraints.html)).
MariaDB 및 MySQL 5.7은 이 후보의 검증 대상이 아니다. 문자열 FK는 charset/collation이,
정수 FK는 크기/부호가 맞아야 한다([MySQL FK 문서](https://dev.mysql.com/doc/refman/8.0/en/create-table-foreign-keys.html)).
후보 전체에 `DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`을 명시했다. 서버 기본
collation이 case-insensitive여도 opaque request ID를 임의로 같다고 처리하지 않게 한다.
기존 테이블의 client_key collation은 변경하지 않는다. Desktop은 canonical lowercase
UUID를 생성하고 대소문자만 다른 client_key로 별도 항목을 만들지 않아야 한다.

ORM Python default는 SQL DEFAULT가 아니다. source 포함 모든 필수값은 ORM/생성 경로가
제공하며 이번 Native source는 명시적이다. 수동 SQL insert/seed는 절차에 포함하지 않는다.
문서 unique key는 utf8mb4 최악 길이로도 InnoDB 3,072-byte index 제한 내이다.
JSON snapshot/request 결과 때문에 `max_allowed_packet`과 프록시 body limit도 확인한다
(최소 16MiB 이상을 통합 환경의 권장값으로 검토; 실제 최대 허용은 기존 sanitizer가 제한).
revision/change id는 현재 signed INT다. 장기 event/history 증가 모니터링 및 보존 정책은
후속 운영 과제이며 임의 pruning은 하지 않는다.

**실제 대상 DB와 충돌 없음은 아직 확정할 수 없다.** DB에 접속하지 않았다. 적용 전
version, signed PK, engine, existing memo unique index, 12개 테이블 이름 충돌,
constraint/index metadata, DB migration ledger를 읽기 전용 권한으로 확인해야 한다.
`contracts/memo-sync-v1.verify.sql`은 검토용 SELECT만 제공하며 이번에 실행하지 않았다.

## 6. 승인 후 Migration·Backup·복구 순서

이 절차 작성은 실행 승인이 아니다. 모든 persistent 개발/Staging/Production DB는
보호 대상이다. 현재 offline runner는 MySQL 자체를 차단한다. 자동 E2E는 별도로 승인한
**일회용 MySQL 인스턴스와 테스트 전용 Staging 배포**에서만 준비한다. 기존 persistent
Staging에 테스트 계정/메모를 자동 생성하는 계획으로 바꾸지 않는다.

1. 담당자가 대상 instance/schema, patch/DDL hash, 기존 schema baseline, migration
   ledger, 유지보수 시간, 저장소 경로 및 제한 계정·네트워크 경계를 지정한다. 실제
   MySQL 검증 runner를 마련하려면 별도 안전 검토가 필요하다. guard 예외를 추가하지 않는다.
2. read-only 계정/서버 정책을 확인한 뒤 verify.sql PRE 부분만 실행한다. application
   import/start로 조사하지 않는다. 12개 중 하나라도 이미 있으면 중단하고 ledger와
   SHOW CREATE 결과를 대조한다. IF NOT EXISTS나 DROP으로 차이를 숨기지 않는다.
3. **적용 직전 신규 backup 계획:** 담당자가 대상 DB의 일관된 전체 snapshot 또는
   승인된 논리 backup, schema/ledger, 저장소의 같은 시점 S3 version ID/manifest 또는
   로컬 파일 backup을 확보한다. 암호화·접근 제한·보존기간·복구 지점/책임자를 기록한다.
   내용/credential을 로그·이 문서에 싣지 않는다. 과거 사고 backup/forensics는 재개하지 않는다.
4. 별도 승인된 일회용 복구 대상에서 복구 가능성을 확인한다. 원래 DB에 덮어쓰지 않는다.
   신규 테이블만 백업하면 현재 메모/이미지와 History FK 일관성을 복구할 수 없다.
5. 쓰기 중지/maintenance를 담당자가 승인된 범위에서 수행하고 기존 자동 schema init은
   계속 false로 둔다. API/UI는 OFF. 검토한 SQL을 **문장별** 전용 migrator 권한으로
   실행·기록한다. application의 create_all, pytest, 파일명순 일괄 migration을 쓰지 않는다.
6. MySQL DDL은 implicit commit이므로 여러 CREATE/INDEX가 통째로 rollback되지 않는다
   ([MySQL 문서](https://dev.mysql.com/doc/refman/8.0/en/implicit-commit.html)). 중간 실패 시
   flag를 OFF로 유지하고 완료 문장/schema 차이를 기록한 뒤 미완료 부분만 별도 검토한다.
   자동 재실행/전체 DROP/restore는 금지한다.
7. verify.sql POST와 실제 SHOW CREATE를 대조한다. 신규12테이블/모든 FK·index/CHECK
   확인, violation count0, 기존 테이블 정의·PK 개수 불변을 maintenance 기준으로 확인한다.
   변경 추적이 시작되기 전에는 새 metadata 테이블이 비어 있어야 한다.
8. schema 전체 준비가 끝난 후 `MEMO_SYNC_SCHEMA_READY=true`와 고정 namespace를 모든
   앱 프로세스에 설정한다. 정상 Web 동작과 추적 보호를 확인한 뒤 승인된 통합용 환경에서만
   API flag → Frontend flag 순서로 활성화한다. 관련 런타임 계정에는 DDL 권한을 주지 않는다.
9. 실패 시 우선 API/UI만 OFF. **SCHEMA_READY/namespace는 유지**, 테이블/History/pin을
   보존하고 동기화 추적을 아는 호환 앱 버전으로 운영한다. 추적을 모르는 예전 바이너리로
   단순 복귀하면 변경/이미지 보존이 깨질 수 있다. 필요 시 쓰기 중지와 별도 복구 승인.
10. 데이터 복원은 가장 마지막 수단이다. 구체 대상·복구 시점·그 이후 변경 보존 방법을
    승인받고 별도 대상으로 DB와 첨부를 함께 복원/검증한 후 전환한다. 이 작업에는
    destructive rollback SQL, 원본 DROP, 자동 사용자 삭제를 제공/실행하지 않았다.

## 7. Staging 설정 준비

| 설정 | schema 적용 전 | 승인된 Staging 통합 | 기능만 OFF로 복귀 |
|---|---|---|---|
| AUTO_SCHEMA_INIT | false | false | false |
| MEMO_SYNC_ENABLED | false | true | false |
| MEMO_SYNC_SCHEMA_READY | false | true | **true 유지** |
| MEMO_SYNC_ENVIRONMENT | 미활성 | staging (로컬은 local) | 같은 값 유지 |
| MEMO_SYNC_SERVER_ID | 미활성 | 환경별 고유 8–64자 `[A-Za-z0-9_-]`, 고정 | 같은 값 유지 |
| VITE_MEMO_SYNC_ENABLED | false | true로 빌드 | false로 다시 빌드 |

서버 ID는 secret이 아니라 namespace 설치 식별자이며 재시작마다 재생성하지 않는다.
DB/credential/저장소는 production과 분리한다. `MEMO_SYNC_ENABLED=true`만으로도 코드가
schema를 사용하므로 migration 전 flag를 켜면 안 된다. SCHEMA_READY가 true인데
namespace를 지우면 Web 저장이503으로 실패할 수 있다. UI flag는 Vite build-time이다.

기존 Web session/CSRF, Google/Naver/email login 설정은 재사용하되 실제 테스트용 OAuth
등록 origin/callback, S3 bucket/prefix 또는 독립 UPLOAD_DIR, rate-limit secret, HTTPS
프록시와 body limit은 담당자가 확인한다. callback에는 PLAN-A code만 전달되며 provider
code/token은 전달하지 않는다. `/memo-desktop/authorize` SPA 경로와 API routing,
HTTPS 화면에서 loopback으로 가는 브라우저 정책/CSP는 실제 Windows에서 확인해야 한다.
이 문서는 비밀값이나 실제 환경 파일을 만들거나 수정하지 않는다.

## 8. Desktop 저장소에 전달할 사항 / 남은 문제

- HTTPS 오류 우회(링크 삭제)는 불필요. 현재 Mock의 전체 문자열 정규식을 새로운 URL
  position 정책으로 바꾸고 인계서12개 및 CSS/entity 우회 사례를 공유한다.
- 413/422는 문서별 거절 처리 유지. 422 detail이 문자열·Pydantic 배열·참조 객체 중
  하나일 수 있으므로 파싱해야 한다. item index는 사용자 표시용이며 서버 item ID가 아니다.
- ACK는 기존처럼 중복 없는 name 배열. 이미지 모두 저장/해시 검증 후 최신 version에
  ACK한다. accepted Push가 sync 완료를 의미하지 않는다.
- `item_moved_or_not_owned`, `client_key_in_use` code는 유지. stale conflict를 선택할
  때에도 반환될 수 있다. 기존 위치/로컬 내용을 보존하고 사용자가 다시 판단하게 한다.
- 신규 정책 `device_revoked`를 인식하고 revoked ID로 재인증 자동 반복을 멈춘다.
  로컬 메모/outbox 보존, 새 기기 등록은 사용자 명시 동의로만 진행, 기존 generation의
  큐를 새 링크에 자동 replay하지 않는다. 만료401은 기존 ID 재인증 경로를 유지한다.
- Native Push 항목에 snapshot 전체 wrapper나 attachments를 보내지 말고 계약 필드만
  전송한다. ID/client_key를 동기화한 뒤 전체 main/am/pm 또는 List를 구성한다. 누락은
  삭제다. 같은 row의 이중 표현은422다. client_key는 소문자 UUID를 권장한다.
- Next List 이름 변경은 **별도 개선 과제**다. v1에는 Web/Native rename API 없음.
  현재 PC-only 안내 유지. 단순 PATCH(title,request_id)만 추가하면 동시 rename/본문
  conflict/history와 정합성이 없으므로 base_version/link generation을 포함한 다음 계약
  설계가 필요하다. Last Write Wins를 추가하지 않으며 필수 통합을 막지 않는다.
- 선택 사항인 계정 표시 이름/email API는 이번에 추가하지 않았다(user_id 반환 유지).
- 인계서가 링크한 Desktop 쪽 sync-contract-verification.md/실제 Adapter/EXE는 이
  저장소에 없어 직접 검증하지 않았다. 다음 snapshot에는 memo_sync.py, api.py, models,
  personal_memos.py/task_description.py의 정책, Sync 테스트, 최신 계약/DDL/이 문서를
  전달한다. 파일 기준 hash/추후 승인된 commit을 표시하고 이번 작업을 commit했다고
  표기하지 않는다.

실제 EXE 통합의 남은 선행조건: 승인된 일회용 MySQL 테스트 환경과 전용 runner,
실제 schema/DDL 적용 검증, 분리된 저장소·OAuth 설정, 아래 Desktop 개발 빌드,
Windows loopback/CSP 검증이다. **코드/오프라인 준비 완료와 Staging 적용 완료는 다르다.**

## 9. 실제 E2E 진행 순서 (전부 미실행)

운영 Installer 0.2.1은 운영 origin 고정이므로 쓰지 않는다. Desktop 저장소가 제공한
development/Staging 빌드를 사용한다. 인계 기준 `npm run e2e:build` 후 테스트 전용
`PLANA_SERVER_ORIGIN`을 설정하고 `npm run e2e`를 실행한다. 실제 스크립트/호스트는
Desktop 담당자가 확인한다. production namespace 거절, 개발 전용 Windows credential
항목, 실행별 임시 PLANA_CONFIG_DIR을 먼저 검증한다. 기본 운영 자격증명을 가져오지 않는다.

| 순서 | 시나리오 / 합격 증거 |
|---|---|
| 0 | 승인된 일회용 DB·저장소·테스트 배포임을 확인, 실제 데이터/운영 credential 없음. 필요한 synthetic 테스트 identity는 별도 승인된 절차로 준비; 이 작업에서 계정 생성 안 함 |
| 1 | 시스템 브라우저 로그인 → 동의 → loopback state → PKCE exchange. 잘못된 verifier/code 재사용 거절. 로그에 code/verifier/token 남기지 않음 |
| 2 | Device 목록 일치, 로그인만으로 문서/이미지 업로드 없음. 다른 계정·다른 namespace·다른 기기 cursor 차단 |
| 3 | Web → Desktop DAY 1개 선택, 3개 section 함께 전달, 다른 날짜/Next 로컬-only 유지 |
| 4 | Desktop → Web DAY 1개 선택. 기존 양쪽 내용이 있으면 base0 conflict로 둘 다 보존, 선택 전 로컬 변경 보호 |
| 5 | NEXT_LIST A만 연결, B/default 불변. 이름 변경 PC-only 안내 확인 |
| 6 | main/am/pm의 본문·체크·정렬·section·날짜/List 이동·삭제. 연결 안 된 목적지를 자동 연결하지 않음, 옮겨진 row 재요구409 확인 |
| 7 | HTTPS/HTTP 링크·profile·표·Rich Paste 저장/재시작 왕복. file/UNC/entity/CSS 우회422 전체 원자성 확인 |
| 8 | 실제 저장소 이미지 업/다운, 같은 이미지 여러 번 참조, SHA와 name mapping, 다운로드 실패 ACK 거절, 모두 저장 후 synced |
| 9 | Desktop OFF 중 Web 수정, Desktop offline 로컬 편집, 복구 후 증분 cursor. 응답 유실 시 동일 request 재전송으로 중복/version 증가 없음 |
| 10 | 양쪽 동시 수정, DAY/List 전체 양쪽 선택, losing History/이미지 복원, conflict 미결 상태에서도 다른 문서 진행 |
| 11 | 비교 도중 새 Web 수정 → 오래된 resolution409, 갱신 후 사용자 재선택. 실제 MySQL 복수 worker 같은 base/request와 revoke/exchange 경합 검증 |
| 12 | Unlink 양쪽 사본 유지, relink 새 generation과 이전 Push/ACK 거절 |
| 13 | Web polling 자동 반영 및 열린/실패 초안 보호. 앱 종료/강제 종료/재실행 후 큐·cursor·이미지·credential 유지 |
| 14 | 단순 token 만료 재인증은 동일 link/cursor. Web revoke/logout은401 및 동일 ID 재인증409, 사전 발급 code도 차단. 새 기기 자동 relink 없음 |
| 15 | API/UI OFF + SCHEMA_READY/namespace 유지 중 Web 수정/History 이미지 보존, 다시 ON 시 변경 수신. AUTO_SCHEMA_INIT은 끝까지 false |

결과는 실행별 build hash, namespace, DB server version/DDL hash, storage/provider 종류,
시나리오 PASS/FAIL, 마스킹한 status/code/document version 증거로 기록한다. **Mock 통과,
SQLite API 통과, 실제 MySQL/S3/OAuth/EXE 통과를 별도 열**로 둔다. 성공 응답만으로
ACK의 로컬 내구성이나 실제 이미지 표시를 통과로 기록하지 않는다. 실패는 해당 단위만
보류하고 원본·큐·History를 보존한다. 종료 후 환경 폐기/테스트 데이터 정리도 별도 승인
대상이며 persistent 데이터에 자동 cleanup을 실행하지 않는다.
