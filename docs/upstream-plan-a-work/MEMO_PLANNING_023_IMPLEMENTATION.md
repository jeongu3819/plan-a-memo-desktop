# Desktop v0.2.3 호환 Web 개인 메모 개선

작업 기준: `outside`, 시작 HEAD `35593fa`. 기존 WIP 보존. Commit/Push, 실제 DB 접속·Migration, 배포, Desktop 저장소 수정은 하지 않았다. 아래 구현은 Web/Backend 코드이며 실제 Desktop EXE 연동 완료를 의미하지 않는다.

## 1. 기존 구조와 Desktop 차이

- `PersonalMemoHost`/`PersonalMemoContext`의 공용 Store가 Dashboard, 주간, DAY, Next, 팝업의 편집·체크·삭제·이동을 담당한다. 기존 `PersonalMemoRow`, `PersonalMemoQuickInput`, `RichDescriptionEditor`를 재사용했다.
- 서버 원본은 `personal_memos`다. `memo_date`, `section=main/am/pm`, `kind`, `completed`, 정렬, 고유 `client_key`, row `version`, soft delete를 유지한다. Native의 `item_version`은 이 row 버전이며 DAY/NEXT_LIST Document Version과 별개다.
- 기존 `personal_memos.py`의 HTML 정리·이미지 소유권·참조 추적, `memo_sync`의 ORM 변경/History hook을 재사용한다. 원본 테이블이나 기존 ID를 변경하지 않는다.
- Desktop v0.2.3의 복사 이력(`item_copies`, `carryover_prompts`)과 알림(`day_reminders`)은 Local SQLite에 있다. Web은 별도 서버 메타데이터를 사용한다. Windows 스케줄러·Local DB는 가져오지 않는다.
- 기존 `NotificationLog`, 알림 화면, 읽음 상태, 알림 수, leader가 시작하는 `notification_processor` Scheduler를 사용한다. 메모 알림은 `provider=web`, `event_type=memo_day_reminder`로 분리한다. 메일 outbox나 Web Push를 추가하지 않았다.

## 2. 상단·오늘·날짜 편집

- 개인 메모 Header만 **검색 → 오늘 → 설정**으로 정리했다. 주 이동 화살표, 현재 날짜 범위, 같은 요일 날짜 메뉴와 `← 주간`은 유지한다. 내보내기는 메모 설정에서 연다.
- 오늘은 클릭 순간 브라우저 로컬 날짜의 DAY 상세를 연다. Dashboard 작은 메모의 오늘 버튼도 같은 상세로 연결한다. 기존 서버의 업무용 오늘/KST 판정은 변경하지 않았다.
- 빈 main/am/pm 입력란의 최소 높이를 한 줄로 줄였다. 기존 편집기의 내용 확장, 큰 내용의 내부 스크롤, 표·이미지, Undo/Redo·선택·업로드 보호를 유지한다.
- 상세에서 선택한 날짜 +7/+14일의 카드를 제공한다. 카드당 처음 5개, 나머지 펼치기/접기, 추가 2주씩 최대 12주 탐색을 지원한다. 실제 날짜·section·내용·완료 상태를 표시하고, 빈 날짜는 미리 작성으로 이동한다.
- 미래 카드의 기존 Row에서 체크·편집·삭제·메뉴·큰 편집기를 그대로 사용한다. 변경 대상은 그 항목의 실제 미래 날짜다. 조회·탐색으로 Sync Link를 만들지 않는다. 작성/업로드 중 카드 접기로 편집기를 제거하지 않도록 보호한다.
- 검색은 Owner의 삭제되지 않은 메모를 50개씩 cursor로 조회한다. 빈 검색은 최근 생성 항목 목록이다. 문자열의 `%`/`_`를 SQL wildcard로 취급하지 않는다.

## 3. 지난 미완료 복사

- 자동 안내는 사용자 시간대의 현재 월~일 주간에 속하는 대상 날짜에만 표시한다. 원본 날짜는 항상 대상 -7일이다. 수동 메뉴는 다른 날짜에서도 사용할 수 있다.
- `checklist`, 미완료, soft delete 아님, 아직 이 날짜로 복사하지 않은 항목만 반환한다. 선택을 열면 전부 선택하지만 최종 확인 전에는 쓰지 않는다. 한 요청 100개까지이며 초과 시 UI에서 선택을 나누도록 안내한다.
- 원본의 버전을 확인한다. 선택 뒤 원본이 완료·삭제·이동·수정되면 `409 carry_source_changed`이고 전체 요청을 rollback한다.
- 새 ID/`carry-<uuid>` client_key, 미완료 상태, 원본 section과 정리된 HTML을 사용한다. 기존 대상 section의 마지막 순서 뒤에 붙인다. 원본 내용·완료·위치는 그대로다.
- `(owner_user_id, source_memo_id, target_date)` PK가 영구 중복 방지 기준이다. 같은 Owner의 기존 메모/Native 쓰기와 같은 lock 순서로 직렬화한다. 복사 항목·출처·이미지 참조·Sync revision을 한 transaction에 commit한다.
- 재시도는 기존 복사본을 반환한다. 복사본이 나중에 이동·삭제되어도 재생성하거나 복구하지 않는다. 원본 제목 유사도로 다른 메모를 삭제하지 않는다.
- 건너뛰기는 `(owner,target_date,source_date)`로 저장한다. 새로고침/재로그인 후 자동 안내는 숨기고 설정의 `지난 미완료 가져오기`로 다시 열 수 있다.

## 4. 이미지·History·Sync

- 기존 이미지 API의 소유권 검사를 거친 같은 Owner의 서버 이미지 참조를 재사용한다. 물리 파일을 중복 업로드하지 않는다. 기존 GC는 복사본을 포함한 메모 참조를 확인하므로 원본 soft delete로 복사본 이미지를 지우지 않는다. 표·서식도 기존 sanitizer 규칙으로 보존한다.
- 기존 Sync의 DAY=`owner+date`(main/am/pm 전체), NEXT_LIST=`owner+list_id`를 유지한다. 복사 생성 역시 ORM hook을 통과해 연결된 목적 DAY만 revision이 증가한다. 원본 DAY의 내용/version은 변경하지 않는다. 미연결 DAY를 자동 연결하지 않는다.
- Web과 Desktop에서 같은 원본을 각각 복사한 경우 Desktop의 새 client_key에는 공유 출처 정보가 없다. 현재 v1 필드만으로 의미상 같은 복사인지 안전하게 판정할 수 없다. **교차 클라이언트 복사 중복 방지는 미지원**이며 수동 내용 선택이 필요하다. 미래 계약 확장에는 원본의 공통 식별자+대상 날짜+idempotency가 필요하다. 이번에는 Sync v1 Request/Response를 바꾸지 않았다.
- Web 알림 시간대·예약·건너뛰기·복사 출처는 Sync 대상이 아니다. Desktop Windows 알림과 자동 공유하지 않으며 UI에도 안내한다.

## 5. 날짜별 Web 알림

- DAY/미래 카드의 알림에서 1주 전/2일 전을 각각 선택하고 `HH:mm`, IANA 시간대를 저장한다. 브라우저 시간대를 기본으로 사용한다. 날짜별 예약이며 반복 주간 예약은 없다.
- 예정 시각은 UTC로 저장한다. 이미 지난 시각은 `missed`, 미완료 체크리스트가 없는 날짜는 `cancelled`다. DST로 존재하지 않는 시각은 422, 두 번 존재하는 시각은 첫 번째 시각을 사용한다.
- 동일 `(owner,date,days_before)` 전달 행을 잠그고 알림함 기록과 `sent` 상태를 원자적으로 저장한다. worker 재시도·동시 실행, 설정 변경/해제/재설정에도 이미 보낸 offset은 다시 발행하지 않는다. 로그가 삭제돼도 발행 기록은 남도록 nullable FK/SET NULL을 사용한다.
- 기존 scheduler에서 60초마다 최대 100건 처리한다. 5분 넘게 지연된 예약은 재시작 후 소급 발행하지 않고 `missed`로 남긴다. Scheduler leader가 실제 실행되는 배포 설정은 별도 운영 검증이 필요하다.
- 발행 순간 최신 미완료 개수를 계산한다. 일반 Web 변경과 Native Push 후 그 날짜의 마지막 체크리스트가 완료·삭제·다른 날짜로 이동·text로 전환되면 남은 예약을 취소한다. 이동 목적 날짜의 예약은 자동 생성하지 않는다. 이후 다시 할 일이 생기면 사용자가 설정을 저장해 재예약할 수 있다.
- 설정 수정은 별도 `version`을 검사해 오래된 화면의 덮어쓰기를 409로 거절한다. 이 version은 메모 row/Sync Document Version과 다르다.
- 브라우저가 닫혀 있어도 Backend가 살아 있으면 알림을 생성·보관한다. 기존 알림 화면에 메모 알림을 표시하고 15초 polling, 읽음, `/personal-memos?day=YYYY-MM-DD` 이동을 제공한다. OS 배너·이메일·브라우저 Push는 보장하거나 전송하지 않는다.

## 6. API

모든 API는 기존 인증된 사용자, 기존 SaaS 세션/CSRF/Origin 정책을 사용한다. 개인 메모이므로 Space를 요구하지 않는다. body의 Owner/user_id는 받지 않는다. Planning API는 두 Backend 플래그가 모두 true일 때만 열리며 아니면 404다.

| Method / Path | 입력 | 결과/주요 오류 |
|---|---|---|
| GET `/api/personal-memos/search` | `q`, `before_id` | `items`, `next_before_id`; 50개씩 |
| GET `/api/personal-memo-planning/days/{day}/carry` | `timezone` | 원본/대상 날짜, `auto_prompt`, `dismissed`, canonical items |
| POST `…/days/{day}/carry` | `items:[{id,version}]` | canonical 복사 items; 재시도 같은 ID; 409 출처 변경, 422 잘못된 선택 |
| POST `…/days/{day}/carry/dismiss` | 빈 body | `dismissed:true`, 반복 요청 안전 |
| GET `…/days/{day}/reminder` | 없음 | `version,timezone,local_time,days_before,deliveries` |
| PUT `…/days/{day}/reminder` | `version,timezone,local_time,days_before:[7,2]` | 최신 설정; 빈 배열은 예약 해제; 409 설정 변경, 422 시각/시간대 오류 |
| GET `…/notifications` | 없음 | 최근 100건, `unread_count` |
| POST `…/notifications/{id}/read` | 빈 body | `read:true`; 타 Owner/없는 알림 404 |

`days_before`는 현재 pending인 예약만 나타낸다. `deliveries`에는 sent/cancelled/missed도 남는다. 실제 사용자 데이터가 없는 SQLite fixture로 세션/CSRF·다른 Owner 거절을 검사했다.

## 7. DB 변경 후보·활성화·복구

신규 **4개** 테이블이며 기존 Sync 12개 테이블 Migration과 별개다. [DDL](contracts/memo-planning-v1.mysql.sql), [검증 SQL](contracts/memo-planning-v1.verify.sql)은 검토용이고 실행하지 않았다.

| Table | PK/UNIQUE·FK·Index | 목적 |
|---|---|---|
| memo_carry_copies | PK(owner,source,target); UNIQUE copied_memo_id; users/personal_memos FK; source index | 영구 복사 중복 방지 |
| memo_carry_notices | PK(owner,target,source_date); users FK | 자동 안내 건너뛰기 |
| memo_day_reminders | PK(owner,date); users FK; version >= 1 CHECK | 날짜별 시각/시간대/설정 버전 |
| memo_reminder_deliveries | PK(owner,date,offset); users/log FK; status+scheduled_at, notification_id index; offset/status CHECK | 예약·발행 중복 방지 |

MySQL >=8.0.16, InnoDB, utf8mb4_bin, 부모의 signed INT ID를 전제로 한다. 기존 부모 테이블·데이터의 ALTER/backfill은 없다. ORM와 후보 DDL 일치/제약은 격리 테스트에서 검사했지만 실제 MySQL 버전·부모 FK·실행 계획은 확인하지 않았다.

활성화 설정:

```text
AUTO_SCHEMA_INIT=false
MEMO_PLANNING_ENABLED=false             # 미설정도 false
MEMO_PLANNING_SCHEMA_READY=false        # 미설정도 false
VITE_MEMO_PLANNING_ENABLED=false        # 빌드 시 적용
```

Header/오늘/검색/미래 카드 편집은 기존 메모 저장소로 작동한다. 신규 DB가 필요한 복사·예약·메모 알림 UI만 별도 플래그로 막는다. `MEMO_SYNC_*`, `VITE_MEMO_SYNC_ENABLED`를 신규 기능 flag로 재사용하지 않는다.

승인 후 절차:

1. `TEST_DATABASE_SAFETY.md` 조건의 disposable allowlisted `*_test` DB, 제한 계정·네트워크 격리를 먼저 준비한다. 보호되는 개발 DB에서 리허설하지 않는다.
2. 대상 이름/버전/부모 타입/기존 제약을 read-only로 확인한다. 네 테이블 중 하나라도 이미 존재하면 중단하고 적용 이력을 조사한다. `IF NOT EXISTS`로 부분 적용을 숨기지 않는다.
3. 승인된 대상의 접근 제한된 일관된 전체 백업 및 복원 가능한 별도 폐기용 환경을 확보한다. dump/계정/메모 내용을 보고서에 출력하지 않는다. 복원 시험도 보호 DB에 하지 않는다.
4. 기존 Sync Migration과 별도 작업 번호로 기록하고, DDL 순서대로 4 CREATE TABLE/Index를 실행한다. MySQL DDL은 transaction 전체 rollback을 보장하지 않으므로 적용 문장별 성공 여부를 기록한다.
5. 검증 SQL의 POST, SHOW CREATE TABLE 대조, 기존 메모 수 보존 및 폐기용 DB의 경쟁/재시도/권한 테스트를 확인한다. 그 후 별도 승인된 Staging에 같은 절차를 수행한다.
6. 스키마 검증을 완료한 환경에서만 `SCHEMA_READY=true`, 이어 Backend/UI `ENABLED=true`를 설정한다. 메일 기능은 자동 활성화하지 않는다. 기존 leader scheduler·서버 UTC·IANA tzdata를 확인한다.
7. 장애 시 우선 Backend/UI ENABLED를 끈다. **스키마가 존재하면 SCHEMA_READY는 true로 유지**하여 메모 변경 시 예약 취소·계정 삭제 정리가 계속 동작하게 한다. 적용 이후 모델을 모르는 과거 코드로 무조건 롤백하지 않는다.
8. 부분 DDL 실패 시 기능을 끈 채 metadata로 성공 지점을 확인한다. 추가 실행/삭제/복원 SQL은 대상과 백업을 명시해 별도 승인받는다. 사용자 복사본이 생긴 뒤 출처 테이블을 삭제하면 중복 방지 정보가 사라지므로 자동 DROP/복구는 금지한다. 운영 데이터 전체 복원도 이 작업에 포함하지 않는다.

## 8. 변경 파일

- Backend 신규: `app/memo_planning_models.py`, `app/services/memo_planning.py`.
- Backend 연결: `main.py`, `app/test_database_safety.py`(임시 SQLite 모델 등록만), `services/personal_memos.py`, `saas_boundary.py`, `notification_processor.py`, `account_deletion_worker.py`.
- Frontend 신규: `api/memoPlanning.ts`, `MemoDayPlanning.tsx`, `MemoUpcomingDays.tsx`, `MemoSearchDialog.tsx`, `MemoNotifications.tsx`, `hooks/useMemoNotifications.ts`, `pages/PersonalMemosPage.tsx`.
- Frontend 연결: `PersonalMemoWorkspace/DayView/Dialogs/Panel`, `personalMemoDates`의 날짜 정책 설명, `TodayTasksWidget`, `App`, `MentionsPage`, `useNotificationCounts`.
- 테스트: `backend/tests/test_memo_planning.py`, `test_memo_planning_schema.py`; `frontend/tests/memo-planning/*`, `playwright.memo-planning.config.ts`; 기존 초대 화면 테스트의 오래된 mock/탭 이름과 메모 UX 브라우저 테스트의 고정 날짜·설정 진입 경로 갱신.
- 문서: 이 보고서 및 `memo-planning-v1.mysql.sql`, `memo-planning-v1.verify.sql`. 기존 Sync v1 계약 파일은 변경하지 않았다.

## 9. 검증 결과와 남은 범위

검증 결과는 아래 최종 실행 기록에 정리한다. 정상 backend pytest는 root guard를 통과한 `ENV_MODE=test`, dotenv 없음, 임시 SQLite를 사용한다. 실제 Chromium 테스트의 API/이미지는 합성 응답이며 외부 요청은 차단한다. Mock 응답을 실제 서버 통합 성공으로 계산하지 않는다.

| 검사 | 실제 결과 |
|---|---|
| Backend 메모·Sync·DDL·ACL·탈퇴·기존 알림 9개 파일 | **305 passed, 1 failed**. 실패는 기존 `test_public_spaces_withdrawal.py::test_discovery_is_opt_in_minimal_and_revocable`의 옛 응답 필드 기대값이다. 시작 HEAD의 `routers/space_discovery.py`에도 이미 `participation_status`가 존재한다. 제품 코드와 해당 테스트는 이번에 수정하지 않았다. 메모·Sync 관련 실패는 없다. |
| 신규 Planning + root DB safety 재검사 | **43 passed** = Planning 17 + safety 26. 테스트 lifespan이 schema/worker를 실행하지 않는 조건 포함. 위 실행과 중복되므로 합산하지 않는다. |
| Frontend 단위 회귀 11개 파일 | **99 passed**. Sync, Rich Text/링크, export, 날짜(월말·연말·윤년·로컬 자정), 미리보기, 알림 수, 초대 화면, Dashboard, 인증 전환 포함. |
| Chromium 기존 메모 UX | 17개 중 16개 통과 후, 긴 입력 드래그 테스트가 화면 밖 좌표를 클릭하는 문제를 수정해 해당 1개 별도 재실행 통과. 이미지 paste/undo/redo/소유 이미지 복사/오류, 포커스/선택/스크롤, Next/작은 팝업, offline HTML/ZIP 표·이미지 export 검증. |
| Chromium 기존 Sync | **3 passed**. DAY 연결/ACK 대기/전체 Conflict, polling과 실패 초안 보존, Next List 연결/기기 없음. |
| Chromium 신규 날짜 UX | **6개 통과**: 기본 5개 실행 + 브라우저 LA/서버 KST 날짜가 다른 경우 1개 별도 실행. 검색→오늘→설정, 입력 높이/Undo, 미래 항목만 수정/체크/삭제/펼치기, 사용자 선택 복사/새로고침 후 건너뛰기, 알림 시각/클릭 이동, 390px 팝업/연말, 브라우저 로컬 오늘과 팝업 제목 확인. |
| TypeScript / production 정적 빌드 | `npm.cmd run type-check`, 최종 `npm.cmd run build`(tsc + Vite) 통과. 배포하지 않음. 기존 Browserslist 데이터 연령, lottie eval, bundle 크기 경고는 남음. |
| 변경 검사 | `git diff --check` 통과. 기존 Sync v1 계약/DDL 변경 없음. |

최초 확장 Backend 실행의 Windows 임시 폴더 PermissionError는 샌드박스 권한 문제였으며, 같은 공식 pytest를 승인된 실행 환경에서 재실행한 결과가 위 표다. DB guard를 우회하거나 보호 DB로 대체하지 않았다. 브라우저 fixture는 서버 날짜를 고정한 것에 맞춰 실제 브라우저 시계도 고정했고, 새 설정→내보내기 경로로 갱신했다. 체크는 비동기 캐시 반영을 기다린 후 상태를 확인한다.

실제 MySQL 잠금/FK/DDL 적용, Staging scheduler 리더·여러 worker 운용, S3/OAuth, Desktop v0.2.3 EXE, Web↔Desktop 동시 복사 의미상 중복 처리는 미검증/미지원 범위다. Desktop의 추가 개발 없이 기존 DAY 본문/체크 Sync 계약을 사용할 수 있다. 복사 출처·알림 설정 공유는 별도 공통 계약 승인과 양 저장소 작업이 필요하다.

재현 명령(Backend는 저장소 root, Frontend는 `frontend/`에서):

```powershell
python -X utf8 -m pytest backend/tests/test_memo_planning.py backend/tests/test_memo_planning_schema.py backend/tests/test_memo_sync.py backend/tests/test_memo_sync_schema.py backend/tests/test_personal_memos.py backend/tests/test_personal_memo_today_picks.py backend/tests/test_personal_memo_client_acl.py backend/tests/test_public_spaces_withdrawal.py backend/tests/test_invitation_notifications.py -q --disable-warnings --tb=short
python -X utf8 -m pytest backend/tests/test_memo_planning.py backend/tests/test_database_safety.py -q
npm.cmd test -- tests/memoSync.test.tsx tests/richTextFormatting.test.ts tests/richLink.test.ts tests/personalMemoExport.test.ts src/utils/personalMemoDates.test.ts src/components/personalMemo/personalMemoPreview.test.ts src/hooks/useNotificationCounts.test.tsx src/components/MembershipNotifications.test.tsx src/components/today/TodayTasksWidget.voc.test.tsx src/pages/MentionsPage.invitations.test.tsx src/api/authTransition.test.ts
node scripts/run-rich-content-tests.mjs --config=playwright.memo-planning.config.ts
node scripts/run-rich-content-tests.mjs --config=playwright.memo-sync.config.ts
node scripts/run-rich-content-tests.mjs --config=playwright.personal-memo-ux.config.ts
npm.cmd run type-check
npm.cmd run build
```
