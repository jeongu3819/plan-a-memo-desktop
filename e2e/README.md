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
| linked-list-rename-refused | (Mock) 연결된 List 이름 변경·삭제 → 안내와 함께 막힘(× 없음, 메뉴에 이유), 보낼 것 없음, 연결·이름 그대로 |
| storage-move | 저장 위치 변경 후 같은 메모 |
| deep-link | `plana-memo-dev://open` → 두 번째 창 없이 기존 창(single instance) |
| device-revoke | (Mock) Web 에서 이 PC 해제 → 같은 기기 재연결은 `device_revoked` 로 거절(자동 재활성화 없음), 메모·Outbox 유지 → [새 기기로 등록] → 이전 연결은 보존·멈춤 |
| logout | (Mock) 로그아웃 → 연결은 '이 PC 에만', 메모 유지 |
| header-today | 상단 [검색] [오늘] [연동] [가져오기] [설정] 순서·높이·겹침 없음(850px), 이번 주·지난주·다음 주·실제 기간 표시와 툴팁, 아이콘 설명, 연동 메뉴의 History, 보조 줄 없음, [오늘] → 오늘 날짜 상세(이미 오늘이면 다시 만들지 않음), ← 주간 |
| upcoming-weekday | 다가오는 같은 요일 카드(+7·+14) 접힘 시작, 빈 날짜 '메모 없음' 한 줄, [기록]·[접기], 쓰는 중 저절로 접히지 않음, 접어도 쓰던 글 저장, [더 보기], 카드에서 체크·편집·삭제 → **그 날짜 문서만** 변경 |
| date-search | 날짜 형식 10가지, 연도 지정·미지정, 본문에 같은 문자열이 있는 메모, 없는 날짜, 결과 → 날짜 상세 |
| month-cards | 올해 월만·다른 해 연도+월, 최신 월부터, 오늘까지의 메모만(미래 달·날짜 없음), 이번 달만 펼침, 펼치기·이동, 작은 창, 접힌 달 검색 |
| memo-drag | 끄는 동안 자리 고정·삽입선·흔들림 고정, 사이·맨 위·맨 아래, 제자리(저장 없음), Esc 취소, 다른 구역·체크 유지, 재실행 후 순서 |
| memo-drag-scroll-long | 끄는 중 스크롤(삽입선이 커서를 따라감, 가리킨 자리에 저장), 긴 메모 주변 이동 |
| list-manage-trash | List 24개 줄바꿈·접기/펼치기·가려진 선택 표시·작은 창, 우클릭 이름 변경(Esc·빈 제목·Enter), ×·삭제 확인·취소, 휴지통 이동·복구(내용·서식·완료·순서), 영구 삭제 확인, 재실행 |
| linked-list-delete-refused | (Mock) 연결된 List 삭제 거절(휴지통·Outbox 변화 없음) · 연동 해제 뒤에는 이 PC 의 List 로 이름 변경·휴지통·복구, 저절로 다시 연결하지 않음 |
| memo-drag-stress | 시드 고정 무작위 정렬 65회(기본 창 40 · 최소 창 25) — 매번 삽입선·화면·저장 순서 일치, 재실행 후 순서 |
| carryover-icon-notices | 가져오기 아이콘: 항목 없음 안내(창 없음), List 화면에서 비활성·설명 |
| carryover | 지난주 같은 요일 미완료 안내 → 고른 항목만 복사(원본 그대로·새 id·미완료·같은 구역), 재요청 중복 없음, 재실행 후 다시 안내 없음, 보조 메뉴 재진입, 건너뛰기 유지 |
| reminder-setup | 알림 설정 화면 → 작업 스케줄러 등록(시각·창 없는 실행 인자), 모두 완료 → 예약 삭제, 미완료 → 다시 예약, 알림 끄기 |
| reminder-click-opens-day | `plana-memo-dev://open?date=…`(알림을 눌렀을 때와 같은 주소) → 그 날짜 상세 |
| shared-v2 | (Mock) memo-sync-v2 공통 관리: Web 복사 → Desktop 표시·다시 권하지 않음, 화면에서 남은 항목 복사 → 서버 한 번(중복 없음), Desktop 알림 설정 → 서버, Web 설정 → Desktop·작업 스케줄러, Web 확인 → Desktop 확인·예약 제외, 동시 수정 → 알림 화면에서 선택 |

* **격리**: `PLANA_CONFIG_DIR`(development 빌드에서만 읽음)로 앱 설정을 임시 폴더에 두고, 저장 위치도 임시 폴더다.
  credential 은 Windows 자격 증명 관리자의 `PLAN-A Memo (development-e2e)` 항목만 쓰고 시작·끝에 지운다.
  사용자의 실제 설정·메모·운영 credential 은 건드리지 않는다.
* 스크린샷: `e2e/output/` (저장소에 넣지 않음). `PLANA_E2E_KEEP=1` 이면 임시 저장소를 남긴다.
* **실제 마우스로 끌어 놓기**: `node e2e/drag-os.mjs` — CDP 입력은 렌더러로 바로 들어가므로, OS 입력 경로까지 확인하려고 `e2e/os-mouse.ps1` 로 진짜 Windows 커서를 움직인다.
  **실행 중(1~2분) 커서를 쓴다** — 마우스를 움직이면 버튼을 놓고 '외부 입력' 으로 멈춘다(종료 코드 2, 다시 실행). 커서 아래가 테스트 창이 아니면 누르지 않고, 끝나면 커서를 되돌린다.
* **긴 텍스트 붙여넣기**: `node e2e/long-paste.mjs` (단계만: `node e2e/long-paste.mjs next-quick`) — 실제 Windows 클립보드에
  원문(최대 약 29만 자·7천 줄, 한글·Emoji·빈 줄·한 줄 6만 자·목록/표 형태 텍스트, 서식 HTML)을 넣고 Ctrl+V →
  입력칸/편집기 → 자동 저장 → SQLite(파일 직접 읽기) → 화면 전환 → 정상 종료·재실행까지 글자 수·줄·첫/중간/끝 표식
  `[END-OF-MEMO-PASTE-TEST-12345]` 를 비교한다. Next·DAY 메인/오전/오후·다가오는 같은 요일, 이어서 편집·Undo/Redo,
  저장 실패(DB 잠금)·2MB 초과 안내, Mock Sync. 결과 표: `e2e/output/long-paste-report.json`.
  **클립보드는 PC 전체가 함께 쓴다** — 실행 중(약 3분) 복사하지 말 것. 시작 때 클립보드 텍스트를 보관했다가 끝나면 되돌린다.
* 개발·E2E 빌드는 식별자 `com.plana.memo.dev`·scheme `plana-memo-dev://`(`src-tauri/tauri.dev.conf.json`)를 쓴다 — 실행 중인 운영 설치본과
  single-instance·앱 설정·`plana-memo://` 등록이 섞이지 않는다(예전에는 운영본이 켜져 있으면 E2E 앱이 바로 종료되고, deep-link 단계가 운영 등록을 덮었다).
* 창 크기: 실행 동안 개발 실행 파일의 창 상태 파일(`%APPDATA%com.plana.memo.dev.window-state.json`)을 치워 두고 끝나면 되돌린다.
* 날짜 알림의 **OS 동작**(앱 종료 상태 알림·클릭·최소화·알림 꺼짐·놓친 알림·제거 시 작업 삭제)은 `node e2e/reminder-os.mjs` —
  별도 테스트 앱 'PLAN-A Memo RemindTest' 를 release Installer 로 설치해 실제 작업 스케줄러·Windows 알림으로 확인한다(약 30분, 끝나면 제거·정리).
* 설치·업데이트·제거 E2E 는 `npm run e2e:installer`(`e2e/installer.mjs` — 별도 테스트 앱 'PLAN-A Memo InstTest').

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
