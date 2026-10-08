# PLAN-A Memo E2E

실제 앱 실행 파일을 띄우고 WebView2 원격 디버깅(CDP, `playwright-core`)으로 화면과 Tauri 명령을 조작한다.

```bash
npm run e2e:build      # development debug 빌드(src-tauri/target/debug/PLAN-A Memo.exe) — 서버 주소 없음 = 개발용 Mock 서버
npm run e2e            # 전체 단계
node e2e/run.mjs image search   # 이름에 맞는 단계만(앞 단계의 상태가 필요한 단계는 함께 지정)
```

| 단계 | 확인하는 것 |
|---|---|
| first-run | 설정이 없으면 첫 실행 화면, 저장 위치 초기화 |
| memo-create | 날짜 하루의 메인·오전·오후 입력(화면 조작) |
| image | 서식(굵게)·이미지 붙여넣기 → `attachment://<id>` 저장, 편집 재진입 시 콘솔 오류 없음 |
| search-history | 태그를 무시한 검색, 수정 전 History |
| restart-persistence | **강제 종료** 후 재실행 — 메모·이미지 그대로 |
| login-link | (Mock) 계정 연결: 127.0.0.1 loopback callback + PKCE 교환 → 날짜 연결 → 첫 Sync |
| conflict | (Mock) Web·Desktop 양쪽 수정 → 비교 화면 → Desktop 선택 → 선택하지 않은 쪽 History |
| offline-restart-outbox | (Mock) 오프라인 편집 → 강제 종료 → 재실행 후 Outbox 유지 → 온라인 전송 |
| first-link-compare | (Mock) 같은 날짜에 이 PC·Web 모두 내용 → 연결해도 덮지 않고 첫 연결 비교(base_version=0), [나중에 선택] 후에도 양쪽 그대로 |
| linked-list-rename-notice | (Mock) 연결된 List 이름 변경 → 이 PC 에만(서버 API 없음, 보낼 것 없음) |
| storage-move | 저장 위치 변경 후 같은 메모 |
| deep-link | `plana-memo://open` → 두 번째 창 없이 기존 창(single instance) |
| device-revoke | (Mock) Web 에서 이 PC 해제 → 같은 기기 재연결은 `device_revoked` 로 거절(자동 재활성화 없음), 메모·Outbox 유지 → [새 기기로 등록] → 이전 연결은 보존·멈춤 |
| logout | (Mock) 로그아웃 → 연결은 '이 PC 에만', 메모 유지 |

* **격리**: `PLANA_CONFIG_DIR`(development 빌드에서만 읽음)로 앱 설정을 임시 폴더에 두고, 저장 위치도 임시 폴더다.
  credential 은 Windows 자격 증명 관리자의 `PLAN-A Memo (development-e2e)` 항목만 쓰고 시작·끝에 지운다.
  사용자의 실제 설정·메모·운영 credential 은 건드리지 않는다.
* 스크린샷: `e2e/output/` (저장소에 넣지 않음). `PLANA_E2E_KEEP=1` 이면 임시 저장소를 남긴다.
* 개발 실행 파일은 실행될 때 `plana-memo://` 를 HKCU 에 등록한다(deep-link 단계). 운영 설치본은 Installer 가 등록한다.

## 실제 PLAN-A Work 서버로(통합 E2E)

```bash
PLANA_SERVER_ORIGIN=http://127.0.0.1:8000 npm run e2e
```

같은 harness 가 실제 Adapter(PlanAWorkSyncTransport)를 쓴다. **개발 빌드는 운영 주소(planawork.com)와 production
namespace 를 거부한다** — 로컬 Backend 나 staging 에만 연결된다(운영 서버에 시험 데이터를 올리지 않게).
서버 준비 조건·실제 시나리오 표: [docs/PLAN_A_WORK_SYNC_HANDOFF.md §4](../docs/PLAN_A_WORK_SYNC_HANDOFF.md). Mock 전용 단계(login-link·conflict·offline·logout)는
건너뛴다 — 실제 로그인은 브라우저에서 사람이 PLAN-A Work 로그인·[확인]을 해야 하기 때문이다. 실제 서버 결과는 Mock 결과와
따로 기록한다.
plan-a-work 쪽 준비(DB migration 적용, `MEMO_SYNC_ENABLED`·namespace 설정, Web feature flag)가 끝난 뒤
`login-link` 이후 단계를 실제 서버용으로 확장한다(브라우저 동의 대기 → loopback 완료를 `auth_status` 로 확인).
