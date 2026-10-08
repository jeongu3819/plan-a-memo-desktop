# PLAN-A Work Integration Snapshot

이 디렉터리는 PLAN-A Memo Desktop에서
PLAN-A Work 연동을 구현하기 위한 읽기 전용 참고 자료다.

원본:
C:\Users\송명숙\Documents\GitHub\plan-a-work

## 우선순위

1. memo-sync-v1.md
   - Desktop ↔ PLAN-A Work Sync의 최종 계약
   - API 구현 시 가장 우선한다.

2. MEMO_SYNC_IMPLEMENTATION.md
   - PLAN-A Work에서 실제 구현한 내용과 현재 검증 상태 확인용.

3. source/*
   - Contract의 모호한 부분을 확인하기 위한 실제 Backend 코드 스냅샷.
   - Desktop에서 이 코드를 직접 사용하는 것이 아니다.

4. memo-sync-v1.mysql.sql
   - Server DB 구조 이해용.
   - Desktop에서 실행하지 않는다.

## 금지

- 이 디렉터리의 파일을 Desktop 앱의 실제 소스처럼 수정하지 않는다.
- mysql.sql을 실행하지 않는다.
- Python Backend 코드를 Desktop에 이식하지 않는다.
- Contract와 구현 코드가 다르면 임의로 하나를 선택하지 말고 차이를 보고한다.

## Desktop 구현

Contract를 기준으로 다음 Desktop Adapter를 작성한다.

- PlanAWorkSyncTransport
- PlanAWorkAuthProvider
- PlanAWorkDeviceService
- PlanAWorkAttachmentTransport
- PlanAWorkConflictService