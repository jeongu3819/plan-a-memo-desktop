# Memo Sync v2 공통 관리 상태 구현 보고

2026-10-11, `outside`, 시작 HEAD `85332e6`. 코드·격리 테스트·후보 DDL 작업이다.
commit/push, 보호 DB 접속/변경, migration 적용, Staging/Production 배포,
Desktop 저장소 수정은 수행하지 않았다. 기존 WIP를 정리하거나 삭제하지 않았다.

## 1. 기존 Copy/Reminder 구현 분석

Web Planning은 `memo_carry_copies`의 owner/source item/target date PK로 중복을
막고, `memo_carry_notices`로 건너뛰기를 보존한다. `memo_day_reminders`는
시간대·시각·version, `memo_reminder_deliveries`는 owner/date/offset별 예약·발행을
관리한다. 기존 NotificationLog와 notification_processor Worker가 Web 알림함을
발행한다. PersonalMemo mutation/이미지 참조/Sync ORM hook이 본문·History를 보호한다.
Dashboard·주간·상세는 같은 canonical 저장 경로를 사용한다.

## 2. 이전 불일치 원인

Desktop 0.2.3의 복사 출처·알림 설정·읽음 상태는 로컬에만 있고, Sync v1은 DAY/
NEXT_LIST 내용 Snapshot만 안다. 로컬 SQLite ID와 서버 memo ID는 별개다.
본문이 같다는 비교나 늦은 시각 우선 덮어쓰기로 이 문제를 해결하지 않는다.

## 3. 공통 관리 정책

- DAY 본문은 기존 v1, 관리 상태는 별도 v2. 조회로 링크를 만들지 않는다.
- 공통 원본은 namespace + owner + 서버 item ID. 복사본은 독립 신규 항목이며
  기존 owner/source/target 고유키가 Web/Native의 동시 복사를 한 결과로 만든다.
- 오프라인 복사 요청을 Snapshot보다 먼저 처리하고 provisional key→canonical
  ID/key를 반환한다. 알려진 provisional key의 Snapshot 재삽입은409로 막는다.
- 복사 이후 로컬 편집은 보존하고 pull/rebase 또는 기존 문서 Conflict로 처리한다.
  클라이언트가 오래된 Snapshot의 base_version만 새 값으로 바꾸는 것은 금지다.
- 알림은 같은 사용자/날짜/offset 발생 ID를 사용하고 확인 상태는 단조롭게 수렴한다.
  1주 전 확인은 2일 전 확인과 별개다. 날짜 화면을 열기만 해서는 확인하지 않는다.
- UI/기능 OFF와 스키마 보호 OFF는 다르다. 적용된 환경은 SCHEMA_READY를 유지한다.

## 4. 서버 모델 및 변경안

기존 4개 Planning 테이블과 v1 12개를 재사용한다. 기존 테이블 ALTER/메모
backfill/ID 교체/Live 메모 전체 복제 없이 **3개 부가 테이블**만 제안한다.

| Table | Key / FK / Index / Constraint | 목적 |
|---|---|---|
| memo_management_states | PK(namespace,owner,date), users FK, revision>=0 CHECK | 관리 revision, 선택 offsets, 공통 ACK 시각, 명시 취소 offsets, 수정 client |
| memo_management_changes | INT auto PK, users/device/link FK, owner+namespace+cursor 및 device+cursor index | Web/연결 Native용 별도 증분 cursor, 초기 연결/해제 이벤트 |
| memo_management_operations | PK(namespace,owner,client,request_id), users FK, owner+namespace+date index | 요청 digest/result/status, 설정 충돌 제안, 복사 identity mapping/재전송 |

알림 Rule 및 Occurrence의 본체는 기존 Planning 테이블이다. ACK는 state의
offset별 시각으로 보존하고 NotificationLog.read_at에 반영한다. 로그 보관 정책이
채널 로그를 지워도 ACK가 사라지지 않는다. Local-source의 선택한 내용은 요청
journal에도 남을 수 있으므로 접근/보관은 개인 메모 데이터와 동일하게 취급한다.

## 5. Carryover API

`/api/memo-sync/{native|web}/v2/days/{day}/carry` GET/POST,
`carry/dismiss` POST, `state` GET, `operations` GET을 제공한다.
Native만 `carry/local-source` POST를 제공한다. 기존 Web 후보 조회와 복사 서비스도
같은 canonical Planning 함수를 사용한다. 1–100개 선택, 원본 item version,
미완료 checklist/soft-delete/owner를 검사한다. 현재 대상 항목 뒤로 복사하고
section/HTML/표/소유 이미지 참조를 보존한다. 원본은 수정하지 않는다.
다른 request ID로 재시도해도 기존 복사본을 반환하며 삭제/이동된 복사본은 되살리지 않는다.

서버 원본 복사는 Native 기기의 source/target 모두 현재 링크 generation이 필요하다.
Web-only 원본 전체를 Native에 임의 노출하지 않는다. 선택한 Local-only 원본은
device+stable local-source UUID로 식별하며 원본 DAY 자체는 생성하지 않는다.
관련 DTO/오류/응답은 [인계서](handoff/MEMO_SYNC_V2_DESKTOP_HANDOFF.md)에 명시했다.

## 6. Reminder Rule API

`.../days/{day}/reminder` GET/PUT. PUT은 request_id와 writable rule(version,
timezone,local_time,days_before)을 받는다. 선택 offsets는 발행 상태와 별도로
보존한다. `[]`는 이 날짜의 남은 예약 해제다. 별도 반복 알림이나 이메일/Push를
추가하지 않는다. timezone/DST/과거 시각/완료 시 취소는 기존 Planning 정책을 따른다.

## 7. Occurrence / ACK API

`.../days/{day}/occurrences` GET, `.../occurrences/{id}/ack|cancel` POST.
ID는 namespace/owner/day/offset에 묶인 opaque 값이다. scheduled/published/
acknowledged/cancelled/missed와 delivery_status, acknowledged_at을 구분한다.
확인 요청이 Worker보다 먼저 와도 예정 시각 이후라면 읽은 Web 로그 한 건과
공통 ACK로 수렴한다. 로그가 아직 없는 상태의 auto-ID 처리 회귀도 추가했다.
취소는 읽음이 아니다. 명시 취소 occurrence는 다시 설정해도 재발행하지 않는다.
설정 해제/전체 완료로 취소된 아직 미발행 예약은 명시 저장으로 재설정할 수 있다.

## 8. Version / Conflict / Idempotency

기존 owner DB lock을 사용해 Web, Native, Worker의 갱신 순서를 직렬화한다.
item.version / v1 document.version / rule.version / management_revision은 별개다.
Rule의 base 불일치는409 current/proposed이며 제안도 journal에 보존한다.
다시 선택해도 최신 version 재검증을 거친다. 시각 기반 승자 선택은 없다.

모든 v2 command는 namespace/owner/client/request_id 및 payload digest를 저장한다.
동일 요청 재전송은 결과 재사용, 다른 내용은409다. auth/link 검사를 먼저 수행해
해제·폐기 후 cached 결과를 이용한 접근도 막는다. 복사 생성/출처/이미지/변경 기록/
요청 결과는 같은 transaction이다. ACK 재전송은 별도 요청 ID여도 단조롭게 수렴한다.

## 9. Sync v1 호환성

v1 Request/Response 및 계약/DDL 파일은 바꾸지 않았다. DAY 전체 main/am/pm,
NEXT_LIST 전체, attachment ACK, link generation, content Conflict/History를 유지한다.
변경은 normalize에서 이미 알려진 중복 provisional copy를 거절하는 보호 검사와
v2 route 등록이다. v2 OFF/스키마 미적용일 때 기존 동작을 테스트했다.

Desktop 0.2.3은 v1 본문 Sync를 계속 사용할 수 있으나 공통 관리 기능은 미지원이다.
수정되지 않은 구버전 EXE의 로컬 복사·알림을 서버에서 원격으로 막을 수는 없다.
따라서 구버전 혼용 중 공통 상태가 완전히 수렴한다고 보장하지 않는다. 업그레이드
클라이언트는 연결 DAY의 v2 capability가 없으면 공유 관리 편집을 제한하고 작업을
보존하도록 인계했다. Local-only 기능은 계속 로컬에서 사용할 수 있다.

## 10. Web UI 연결

기존 검색→오늘→설정, 미래 카드, 가져오기, 알림 UI를 유지한다. v2 flag가 켜지면
복사/건너뛰기/알림 저장/읽음이 공통 API를 사용한다. 복사/설정 응답 유실 시 같은
request ID를 재사용한다. 후보/알림함/열린 설정은5초 polling으로 갱신한다.
복사 대상을 선택 중이거나 알림 설정을 편집 중이면 자동 응답으로 입력을 지우지 않는다.
Rule 충돌 시 서버 설정/내 설정 선택을 표시하고 stale 선택은 재검증한다.
알림함의 날짜 이동·읽음은 공통 occurrence ACK, 취소는 별도 action이다.

## 11. Local-only 보호

일반 Native 관리 API는 현재 기기에 연결된 DAY만 접근한다. 인증 body의 user_id는
거절하고 owner/device/namespace/link generation을 서버에서 확인한다. 후보 조회는
원본 링크도 검사한다. Local-source API는 사용자가 선택한 항목과 필요한 이미지의
서버 참조만 받으며 source_date의 PersonalMemo/Sync Link를 만들지 않는다.
서로 다른 기기의 출처 불명 항목은 제목으로 합치지 않는다. 탈퇴 정리 경로는
새 FK 메타데이터를 기존 Planning/v1보다 먼저 정리하도록 연결했다.

## 12–14. 검증 결과

정상 root pytest guard: ENV_MODE=test, dotenv 차단, 임시 SQLite, 보호 DB/외부
서비스 차단. 시작 전 reload 서버 유무와9개 안전 조건을 확인했고 safety26개를
검증했다. 아래 중복 실행 결과는 서로 합산하지 않는다.

| 구분 | 실행 결과 / 한계 |
|---|---|
| Backend 10개 파일: v2/v1/Planning/schema/개인 메모/today pick/ACL/DB safety | **324 passed** |
| 최종 CSRF·취소 수정·계정별 정리 포함 v2+v2 schema+Planning | **35 passed** (v2 16, schema 2, Planning 17) |
| Frontend 단위 회귀 12개 파일 | **103 passed**; v2 transport, v1, RichText/링크, Export, 날짜, 알림 수, Dashboard/인증 전환 포함 |
| 실제 Chromium 신규 v2 | **6 passed**; 응답 유실 복사 재시도, 원격 안내, clean/dirty 설정·stale 선택, 해제 충돌 후 의도 보존, 명시 ACK, 원격 읽음·취소 |
| 실제 Chromium 기존 Planning | **6 passed**; 미래 편집/날짜 분리, 복사/건너뛰기, 알림, 작은 팝업, 로컬 날짜 |
| 실제 Chromium 기존 Sync | **3 passed**; DAY 연결/ACK/Conflict, 원격 polling·초안 보존, NEXT_LIST |
| TypeScript / 정적 빌드 | `npm.cmd run type-check`, `npm.cmd run build` 통과. 기존 Browserslist·lottie eval·bundle 크기 경고 유지. 빌드 후 해제 충돌 보완은 Chromium 및 TypeScript로 재검증 |
| DB schema | SQLite 제약 및 MySQL DDL compile/ORM 일치 검사 통과. 실제 MySQL 실행 아님 |
| 변경 검사 | `git diff --check` 통과. 기존 v1 계약/DDL 변경 없음 |

Frontend 확장 단위 테스트 첫 실행은 샌드박스 esbuild 접근 오류로 시작하지 못했고,
동일 명령을 승인된 실행 권한으로 재실행해103개 통과했다. Guard 우회나 보호 DB
대체는 없었다. Chromium은 실제 브라우저지만 HTTP는 합성 응답이고 외부 요청은
차단한다. Backend Native HTTP 테스트도 합성 클라이언트이며 실제 EXE 결과가 아니다.

## 15. Migration 후보 / 활성화 / 복구

[DDL](contracts/memo-sync-v2.mysql.sql), [PRE/POST 검증 SQL](contracts/memo-sync-v2.verify.sql).
기존 v1 12 → Planning4 → v2 3 순서. 기존 개인 메모 ID/내용/출처의 일괄 변경 없음.
후보 전제는 MySQL>=8.0.16, InnoDB, utf8mb4_bin, 부모 signed INT 및 UUID36 타입/
collation 일치다. 실제 대상 버전·기존 테이블·FK·백업은 이번 작업에서 조회하지 않았다.
CHECK 집행·잠금 경쟁·MySQL DDL 실행 성공으로 보고하지 않는다.

승인 이후에만 수행할 순서:

1. 보호 DB가 아닌 allowlisted disposable `*_test`와 제한 계정/네트워크를 준비한다.
2. 환경당 DB를 분리하고 정확한 대상·버전·부모 키·후보 테이블 부재를 read-only로
   확인한다. 3개 중 하나라도 있으면 중단한다. IF NOT EXISTS로 부분 실패를 숨기지 않는다.
3. 승인된 대상의 일관된 전체 백업·접근 제한·복원 가능한 별도 폐기용 환경을 확보한다.
   dump/사용자 내용/자격증명은 로그에 노출하지 않는다. 보호 DB에 복원 시험하지 않는다.
4. 기존12/4 검증 후 v2 DDL을 순서대로 실행하고 문장별 성공을 기록한다. DDL 전체가
   transaction rollback된다고 가정하지 않는다. PRE/POST SQL과 SHOW CREATE TABLE,
   기존 row count 보존, 폐기용 MySQL의 경쟁/재시도 검증을 완료한다.
5. 별도 승인된 Staging에 같은 절차를 적용한다. 스키마 검증 전에는 READY/ENABLED를
   켜지 않는다. AUTO_SCHEMA_INIT=false 유지. 코드 import/startup에 DDL 추가 없음.
6. 부분 실패: flags OFF, 성공 지점 metadata만 확인, 자동 재실행/DROP/restore 금지.
   구체적 대상/백업/복구 SQL을 별도 승인받는다. 출처·ACK 삭제는 중복 방지 정보를
   잃게 하므로 코드를 과거 버전으로 무조건 되돌리거나 테이블을 지우지 않는다.
7. 노출만 중단할 때는 ENABLED/UI flag OFF, 적용된 SCHEMA_READY와 고정 namespace는
   유지해 이력/취소/ACK 추적을 보호한다. 자동 계정 데이터 정리 외 일괄 보정 없음.

```text
AUTO_SCHEMA_INIT=false
MEMO_SYNC_ENABLED=false
MEMO_SYNC_SCHEMA_READY=false
MEMO_SYNC_ENVIRONMENT=staging
MEMO_SYNC_SERVER_ID=<환경별 고정 ID>
MEMO_PLANNING_ENABLED=false
MEMO_PLANNING_SCHEMA_READY=false
MEMO_SYNC_V2_ENABLED=false
MEMO_SYNC_V2_SCHEMA_READY=false
VITE_MEMO_PLANNING_ENABLED=false
VITE_MEMO_SYNC_ENABLED=false
VITE_MEMO_SYNC_V2_ENABLED=false
```

위는 적용 전 예시이며 실제 env 파일을 변경하지 않았다. 검증 후 각 범위 READY,
Backend 기능, Frontend 빌드 flag 순서로 활성화한다. 기존 scheduler 리더·UTC/tzdata·
OAuth·이미지 저장소는 별도 Staging 검증 대상이며 v2가 임의로 켜지 않는다.

## 16. Desktop 인계

[구현 가능한 Endpoint/DTO·Outbox·Mapping 인계서](handoff/MEMO_SYNC_V2_DESKTOP_HANDOFF.md),
[v2 공통 계약](contracts/memo-sync-v2.md)을 제공한다. Desktop은 서버 ID 매핑,
Copy-first Outbox, rule version 선택, occurrence ID와 Windows 작업 연결,
offline ACK 재전송, 수신 후 예약 취소, 계정/기기/namespace 격리, 구버전 이력
사용자 검토를 구현해야 한다. EXE나 Local SQLite는 이 저장소에서 수정하지 않았다.

## 17. Mobile 확장

같은 Native credential/client, DAY, operation, rule, occurrence, cursor 계약을
사용할 수 있다. 모델에 Windows/Web 전용 복사 이력이나 기기별 읽음 상태를 만들지
않았다. Mobile 로그인·로컬 DB·OS 예약/표시 구현은 이번 범위 밖이다.

## 18. 실제 통합에서 남은 검증

- disposable MySQL의 정확한 FK/collation/CHECK/잠금·다중 Worker·재시도 검증.
- 승인된 Staging의 OAuth/loopback/PKCE, S3 이미지, 요청 제한, scheduler 리더.
- v2 Desktop 개발 빌드의 실제 Offline Outbox 순서, dirty copy 보존/사용자 Conflict,
  앱 강제 종료 후 atomic mapping/cursor 복구, Windows 예약 갱신·제거.
- 구버전과 혼용한 로컬 이력의 명시적 매핑/검토 UX. 출처 불명 복사 자동 통합은 미지원.
- 오프라인 기기에 즉시 ACK 전달 및 이미 표시된 OS 배너의 완전 회수는 보장 불가.
- 실제 E2E는 로그인→device/link→양방향 복사·설정→이미지 ACK→offline 재연결→
  동시 복사/설정 충돌→두 occurrence 확인/취소→unlink/revoke→재시작 순서로 수행한다.
  실제 서버 단계가 skip되면 전체 PASS로 표시하지 않는다.

## 변경 파일

- Backend 신규: `app/memo_management_models.py`, `services/memo_management.py`,
  `services/memo_sync_v2_api.py`.
- Backend 수정: `services/memo_planning.py`(공통 service/알림 log 연결/정리),
  `services/memo_sync.py`(provisional 중복 보호), `services/memo_sync_api.py`(등록),
  `app/test_database_safety.py`(임시 SQLite 모델 등록만).
- Frontend: `src/api/memoPlanning.ts`, `MemoDayPlanning.tsx`, `MemoNotifications.tsx`,
  `hooks/useMemoNotifications.ts`.
- Tests: `backend/tests/test_memo_sync_v2.py`, `test_memo_sync_v2_schema.py`,
  `frontend/tests/memoManagement.test.ts`, `tests/memo-management/shared.spec.ts`,
  `playwright.memo-management.config.ts`.
- Docs: 본 보고서, `contracts/memo-sync-v2.md`, `.mysql.sql`, `.verify.sql`,
  `handoff/MEMO_SYNC_V2_DESKTOP_HANDOFF.md`.

재현: 저장소 root의 공식 `python -m pytest`로 위 Backend 파일을 실행한다.
Frontend는 `npm.cmd test -- <대상 test 파일>`, `npx.cmd playwright test
--config=playwright.memo-management.config.ts` / `playwright.memo-planning.config.ts`
/ `playwright.memo-sync.config.ts`, `npm.cmd run build`를 사용한다.
