# Memo Sync v2 — Desktop 연동(공통 복사·알림·확인)

기준: `docs/upstream-plan-a-work/memo-sync-v2.md`, `MEMO_SYNC_V2_DESKTOP_HANDOFF.md`, `memo_sync_v2_api.py`.
v1(DAY/NEXT_LIST Snapshot · cursor · Conflict · 이미지)은 그대로이고, v2 는 **연결된 DAY** 의 관리 상태만 다룬다.

## 범위

| 날짜 | 복사·안내 | 알림 설정·발생·확인 |
|---|---|---|
| Local-only | 이 PC(기존 0.2.3 그대로) | 이 PC(기존 그대로) |
| 연결 + 지금 계정 + 서버 v2 지원 | 서버 공통(이 PC 는 캐시 + Outbox) | 서버 공통 rule/occurrence, Windows 예약은 그 결과로 |
| 연결 + 서버 v2 미지원·확인 전 | 편집 막음(인계서 §6), 기존 예약 유지 | 편집 막음, 기존 예약 유지 |
| 다른 계정으로 연결 | 편집 막음 | 그 계정의 공통 알림은 띄우지 않음 |

## 구조

- `sync/contract_v2.rs` — DTO(보내는 본문은 Strict 필드만).
- `sync/transport.rs` — `v2_*` 메서드(기본 구현 = 경로 없음 → v1 전용 Transport 는 그대로).
- `sync/http.rs` — `native/v2/*`, 같은 Bearer credential. PUT reminder 의 409 `reminder_changed` 는 오류가 아니라 `RulePutResult::Changed{current, proposed}`.
- `sync/management.rs` — 범위 판단, `management_outbox`, 서버 상태 반영, 복사 결과 맞춤(reconcile), 알림 확인 token.
- `sync/mock/v2.rs` — 개발·테스트용 Mock(실제 서버 아님).
- `migrations/0004_memo_sync_v2.sql` — 새 테이블만(기존 0001–0003·데이터 무변경).

## 순서(SyncEngine.run_once)

1. 지금 계정 기록 → (연결된 DAY 가 있으면) `capabilities` 확인(지원 6시간·미지원 10분 캐시).
2. `management_outbox` — ACK → 복사 → 건너뛰기 → 알림 설정. **복사는 같은 날짜 본문 Push 보다 먼저**: 보내지 않은·맞추지 않은
   복사·열린 복사본 선택이 있으면 그 날짜 Push·첫 연결 비교를 미룬다.
3. v1 Outbox → changes → 문서 받기. 복사 결과가 있는 날짜는 받은 서버 문서로 **reconcile**:
   - 항목별: 고치지 않은 임시 복사본 → 서버 복사본 내용 / 이 PC 에서만 고침 → 유지 / 서버에서 지워짐·옮겨짐 + 고치지 않음 → 뺌 /
     양쪽 모두 바뀜·중복·서버 거절 → `carry_reviews`(화면에서 선택).
   - 문서 단위: 서버 변경이 우리 복사뿐 → 새 version 위에 이어 보냄 / 이 PC 변경이 복사뿐 → 서버 내용 받기 /
     그 밖 → 원래 base 로 보내 기존 날짜 전체 비교(Conflict). 오래된 Snapshot 에 새 base 를 붙이지 않는다.
4. v1 Outbox 2회차 → ACK(v1) → 관리 Outbox 2회차 → v2 changes(별도 cursor `mgmt_cursor|계정|기기`) → 날짜 상태 + cursor 를
   한 transaction 으로 반영. 처음(계정+기기)에는 연결된 DAY 전체 상태를 한 번 받는다.

## 식별자

- 원본: v1 매핑(`sync_item_map`)의 서버 item id + item version. 원본이 Local-only 면 `carry/local-source`(로컬 원본 UUID, 고른 내용만).
- 임시 복사본 key = 그 복사본의 client_key(서버가 본문 Push 로 재생성을 막는다). 응답의 정식 id/client_key 로 매핑.
- 알림 발생: 서버 occurrence id. Windows 알림 주소에는 이 PC 가 만든 일회용 token(`?ack=<32hex>`)만 — 누르면 그 알림의 발생만 확인.

## 알림

- 설정 저장: 이 PC 예약에 바로 반영 + rule 명령(기준 version = 마지막으로 본 서버 version). 409 → 두 설정 보관, 화면에서 선택.
- 첫 연결: 이 PC 설정 없음 → 서버 / 서버 없음(version 0) → 이 PC 설정을 base 0 으로 / 같음 → 맞춤 / 다름 → 선택.
- 확인: 알림 클릭(token)·놓친 알림 안내에서 날짜 열기만 ACK. 날짜를 열기만 한 것은 ACK 가 아니다. ACK 는 Outbox 에 먼저 저장.
- 작업 스케줄러 프로세스: 연결된 날짜 알림이 시각이 되면(온라인이면, 12초 안에서) 남은 ACK 를 보내고 발생 상태를 받은 뒤 띄운다.
  확인·취소·놓침 상태면 띄우지 않는다. 실패하면 로컬 상태로 진행. 다른 곳에서 확인된 알림은 알림 센터에서 거둔다(이미 떠 있는 배너는 남을 수 있음).

## 테스트

`cargo test --test sync_v2_tests`(Mock 시나리오), `--test http_adapter_tests`(v2 경로·본문·409), `node e2e/run.mjs shared-v2`(실제 앱 + Mock).
**모두 Mock/Stub 결과이며 실제 PLAN-A Work 서버 통합 결과가 아니다.**
