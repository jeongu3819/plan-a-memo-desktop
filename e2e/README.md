# PLAN-A Memo E2E

실제 앱 실행 파일을 띄우고 WebView2 원격 디버깅(CDP, `playwright-core`)으로 화면과 Tauri 명령을 조작한다.

```bash
npm run e2e:build      # development debug 빌드(src-tauri/target/debug/PLAN-A Memo.exe) — 서버 주소 없음 = 개발용 Mock 서버
npm run e2e            # 전체 단계
node e2e/section-heights.mjs   # 날짜 상세 메인·오전·오후 높이 — 실제 창 크기(기본·최소·최대화)별 측정·판정
node e2e/long-memo-edit.mjs    # 긴 메모(1.2만~3.2만 자): 카드가 끝까지 감쌈 · 누른 글자 자리에서 바로 편집(높이·스크롤·커서 그대로, 편집기 안 스크롤 없음) — Next·List·DAY·다가오는 요일 (--baseline: 판정 없이 측정)
node e2e/editor-edge-clip.mjs  # 편집 중 커서·글자·한글 조합 밑줄이 편집기 경계(첫·마지막 줄 맨 앞/끝, 빈 새 줄, 오른쪽 줄바꿈)에서 잘리지 않음 — overflow auto/visible 픽셀 비교, DAY 메인·오전·오후·Next·작은 창 (--os-ime: 실제 Windows 한국어 IME, 약 30초 키보드 사용)
node e2e/move-today-ime.mjs    # 메모 메뉴 T(오늘로 이동)를 실제 Windows 한국어 IME(한글 모드)로 — 메뉴·한/영·조합 중 ⋮ 메뉴는 이동, Ctrl+T·편집 중·서식 메뉴·검색창은 글자 입력(약 40초 키보드·앞 창 사용, 처음 입력 모드로 되돌림)
node e2e/run.mjs image search   # 이름에 맞는 단계만(앞 단계의 상태가 필요한 단계는 함께 지정)
```

| 단계 | 확인하는 것 |
|---|---|
| first-run | 설정이 없으면 첫 실행 화면, 저장 위치 초기화 |
| memo-create | 날짜 하루의 메인·오전·오후 입력(화면 조작) |
| image | 서식(굵게)·이미지 붙여넣기 → `attachment://<id>` 저장, 편집 재진입 시 콘솔 오류 없음 |
| search-no-edit-snapshot | 태그를 무시한 검색, 일상 편집은 Snapshot 을 남기지 않음 |
| restart-persistence | **강제 종료** 후 재실행 — 메모·이미지 그대로 |
| login-link | (Mock) 계정 연결: 127.0.0.1 loopback callback + PKCE 교환 → 날짜 연결 → 첫 Sync |
| conflict | (Mock) Web·Desktop 양쪽 수정 → 비교 화면 → Desktop 선택 → 선택하지 않은 쪽을 설정 > 보존된 내용에서 확인 |
| offline-restart-outbox | (Mock) 오프라인 편집 → 강제 종료 → 재실행 후 Outbox 유지 → 온라인 전송 |
| first-link-compare | (Mock) 같은 날짜에 이 PC·Web 모두 내용 → 연결해도 덮지 않고 첫 연결 비교(base_version=0), [나중에 선택] 후에도 양쪽 그대로 |
| relink-same-content | (Mock) 이미지·서식 있는 DAY·NEXT_LIST 해제 → 재연결 3회: 비교 창·재전송 없음, 서버 version·메모 그대로, 화면 재연결 안내. 해제 뒤 Web 수정 → 비교 화면 |
| linked-list-rename-refused | (Mock) 연결된 List 이름 변경·삭제 → 안내와 함께 막힘(× 없음, 메뉴에 이유), 보낼 것 없음, 연결·이름 그대로 |
| storage-move | 저장 위치 변경 후 같은 메모 |
| deep-link | `plana-memo-dev://open` → 두 번째 창 없이 기존 창(single instance) |
| device-revoke | (Mock) Web 에서 이 PC 해제 → 같은 기기 재연결은 `device_revoked` 로 거절(자동 재활성화 없음), 메모·Outbox 유지 → [새 기기로 등록] → 이전 연결은 보존·멈춤 |
| logout | (Mock) 로그아웃 → 연결은 '이 PC 에만', 메모 유지 |
| header-today | 상단 [검색] [오늘] [연동] [가져오기] [VOC] [설정] 순서·높이·겹침 없음(850px), 주 이동, 아이콘 설명, 일반 변경 이력 메뉴 없음, 보조 줄 없음, 빈 날짜의 구역 높이, [오늘] → 오늘 날짜 상세(이미 오늘이면 다시 만들지 않음), ← 주간 |
| date-labels | 주간 '이번 주' 문구 없음·‹ › 이동, 날짜 상세 큰 제목 + 요일(오늘만 Today, 숫자 반복 없음), 모든 요일·과거·미래·해 넘김, Next List·찾아보기, 화면 전환에도 도구 자리 그대로, 최소 창·좁은 창에서 제목 잘림·겹침 없음 |
| rich-menu | 메뉴 구성·강조, 선택 유지, 굵게·밑줄·취소선·Ctrl+I(기울임 만들지 않음), 크기·기본, 색, 링크 추가·수정·해제, Undo/Redo → 자동 저장 |
| rich-menu-lists | 글머리·1.·1)·①·끄기, 표기 Undo/Redo, 들여쓰기·내어쓰기(메뉴·Tab), 번호 이어쓰기, 읽기 화면 표기, 번호 흐름 잇기 |
| rich-menu-content-safety | 12만 자 긴 글·표·이미지가 있는 메모에 서식을 줘도 내용 그대로, 보존된 내용, 강제 종료 후 복원 |
| rich-menu-placement | 창 모서리에서 열어도 창 안(최소 창), 오전·오후·Next List·크게 편집에서 같은 메뉴 |
| memo-move-top | 편집 메뉴·행 메뉴·주간에서 맨 위로: 메인·오전·오후·Next List 각각 그 안에서만, 편집·입력 유지, 맨 위면 꺼짐, 20회 반복, 재실행 후 순서 |
| memo-move-bottom | 맨 위로 바로 아래·대칭 아이콘·같은 크기, 행 메뉴·편집 메뉴·주간에서 맨 아래로: 메인·오전·오후·Next List 각각 그 안에서만, 확인창 없음, 완료 메모(체크·취소선·완료 시각·서식·id 그대로), 맨 아래·한 개뿐이면 꺼짐, 작은 창에서 스크롤이 튀지 않음, 위·아래 섞어 20회, 다른 날짜 갔다 와도·재실행 후 순서 |
| linked-move-bottom | (Mock) 연결된 날짜에서 화면으로 맨 아래로 → sync → Mock Web 도 같은 순서·완료 그대로, 다시 동기화해도 비교 화면·번갈아 바뀜 없음, 오프라인 이동은 바로 + '전달 대기' → 온라인 복귀 후 한 번 전달 |
| upcoming-weekday | 다가오는 같은 요일 카드(+7·+14) 접힘 시작, 빈 날짜 '메모 없음' 한 줄, [기록]·[접기], 쓰는 중 저절로 접히지 않음, 접어도 쓰던 글 저장, [더 보기], 카드에서 체크·편집·삭제 → **그 날짜 문서만** 변경 |
| upcoming-sections | 접힌 카드의 메인·오전·오후 제목: 구역 하나만·셋 다·순서, 빈 구역 생략, 입력칸 없음, 일반 텍스트·긴 메모, 접힌 채 체크/해제(그 날짜만), 접기·펼치기 반복, 모두 비면 '메모 없음', 재실행, 연결된 날짜(Mock) |
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
| rich-highlight | 배경색: 굵게 위에·여러 줄·글자색과 함께, 색을 눌러도 선택 유지·강조, 일부만 제거(옆 글자 그대로)·섞인 색 한 번에 제거(배경 속성 없음, 투명·흰색 흔적 없음, 굵게·글자색 유지), Undo/Redo, 읽기 화면·강제 종료 후 같게, 열고 닫기만 하면 저장 없음 |
| italic-paste | 예전 기울임(em·style) 읽기·편집 화면 일반 글씨 + 열고 닫아도 HTML·수정 시각 그대로, Word HTML 붙여넣기(i·em·style·oblique·클래스 규칙·중첩) → 기울임만 빠지고 글자·굵게·밑줄·글자색·배경색·링크 유지 |
| weekly-recurrence | 메모 날짜의 요일 문구(지난·다른 요일)·메뉴 위치, ○요일마다 생성 → 다음·그다음 주 카드에 바로(미완료·같은 구역·원본 날짜 중복 없음), 먼 날짜는 볼 때만, 여러 번 조회해도 하나, 생성 중·반복 중지·이 항목만 삭제 표시·'시작할 때 내용' 안내, 그 날짜만 완료·수정, 강제 종료 후 유지, 중지 확인창(정리 수·남는 수·취소하면 그대로) → 손대지 않은 이후 회차만 정리·History, 정리할 것이 없으면 확인창 없이 중지, 연결된 날짜는 시작 불가 |
| voc-button | 설정 바로 왼쪽·같은 높이(주간·날짜 상세·찾아보기·850px), 이름 "VOC 및 FAQ"·툴팁, 클릭·키보드 Enter → 개발 빌드는 열 수 없는 이유 안내(staging·production 은 {PLAN-A Work}/voc 를 기본 브라우저로) |
| memo-move-today | 다른 날로 이동 날짜순(오늘·내일·모레·그다음 요일 8개, 토·일 제자리, 메모가 있는 날짜 꺼짐, '오늘' 옆 T·같은 높이, List·날짜 선택 유지), 우클릭 → T → 오늘(id·구역·완료·완료 시각·서식·배경색·이미지 그대로) = 메뉴 클릭과 같은 결과, 편집 중·서식 메뉴의 t·닫은 뒤 T·Ctrl+T·Alt+T 는 이동 아님, 연타에도 그 메모 한 번, 이미 오늘이면 저장·revision 없음, 주간·지난 날짜·Next List, 작은 창, 재실행 후 위치 |
| linked-move-today | (Mock) 연결된 날짜 → 연결된 오늘: T·메뉴 클릭 → 같은 Push → Mock Web 도 원래 날짜에서 빠지고 오늘에, 다시 동기화해도 비교 화면 없음, 오프라인 T 는 바로 + '전달 대기' → 복귀 후 전달, 연결되지 않은 오늘로는 T 로도 기존 확인창(취소하면 그대로) |
| table-structure | 표 안 우클릭 → '표 편집'(현재 행·열 삭제, 서식 메뉴 그대로·창 안), 첫/중간 행·열, 행·열 핸들(왼쪽·위 테두리) 클릭 → 선택 강조 → Delete, 핸들 끌기로 여러 행·열(우클릭 '선택한 행 삭제 (2개)'), Undo/Redo, 마지막 행은 꺼짐·Delete 도 그대로(표 유지)·중립(회색) 안내 '표의 마지막 행은 삭제할 수 없습니다.', 셀 배경·굵게·정렬·링크·표 밖 문단 유지, 저장 HTML 에 선택 흔적 없음, 읽기 화면, 열고 닫기만 하면 저장 없음, 여러 셀 글자 드래그 + Delete 는 글자만, Backspace·Esc(편집 유지)·글자 입력·한글 IME 조합·Ctrl+A 는 선택만 풀고 그대로, 표 밖 우클릭은 기존 메뉴, 병합 셀(rowspan 셀 다음 행으로), 크게 편집 창, 강제 종료 후 같은 HTML |
| table-undo-history | 브라우저 기본 Undo 하나로 이어짐: 행 삭제 → 다른 셀 입력 → Ctrl+Z(입력) → Ctrl+Z(행 복원 = 처음 HTML) → Ctrl+Y(행 삭제) → Ctrl+Y(입력), 열 삭제 + 입력, 여러 행 끌어 선택·열 핸들·우클릭 행 삭제 + 입력을 모두 되돌리고 모두 다시, 굵게 → 행 삭제 → 글자색을 역순으로 되돌리고 다시, Undo 뒤 새 편집이면 Redo 가 행을 지우지 않음, 병합 셀 삭제 + 입력, 삭제 후 편집기 포커스, 저장 HTML 에 표식 없음, 강제 종료 후 같은 HTML |
| table-toolbar-placement | 표 크기 도구: 짧은 위 문단이면 표 위 오른쪽(글자·열 핸들과 겹치지 않음), 긴 메모의 위·아래가 꽉 찬 문단이면 표 밖 글자를 가리지 않는 자리, 창 안, 나타날 때·균등을 눌러도 스크롤 그대로, 오른쪽 가장자리에서도 줄거나 글자가 겹치지 않음(초기화 포함), 표가 화면 밖이면 숨김 |
| table-paste-undo | Excel 형식 표 붙여넣기(병합 셀 유지) → 행 삭제 → Ctrl+Z(행) → Ctrl+Z(붙여넣기) → Ctrl+Y 두 번으로 그대로 |
| linked-table-structure | (Mock) 연결된 날짜에서 행·열 삭제(병합 머리 colspan 조정·셀 배경 유지) → sync → Mock Web 도 같은 표, 다시 동기화해도 비교 화면 없음·행·열이 되살아나지 않음 |

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

* **시험 날짜는 단계마다 따로** 쓴다(`today+N`). 같은 날짜를 두 단계가 쓰면 전체 실행에서만 결과가 달라진다(예전 memo-move-top 의 다른 날짜 확인 +45 = memo-move-bottom 의 시험 날짜).
  memo-move-top(+44·+45)·memo-move-bottom(+56·+57)은 시작할 때 `assertFreshDates` 로 날짜가 비어 있는지 확인하고, 겹치면 "시험 날짜 겹침" 으로 바로 멈춘다.
  memo-move-today 는 비어 있고 연결되지 않은 날짜를 골라 쓴다(`freeDate`). linked-move-today 는 도착지가 늘 오늘이라, 다시 연결한 오늘이 앞 단계 기록 때문에
  첫 연결 비교로 가면 그것을 확인하고 이 PC 내용을 골라 끝낸 뒤 판정한다.

## 알려진 E2E 문제(별도 이슈 — 2026-11-20 기록)

| 단계 | 증상 | 재현 | 상태 |
|---|---|---|---|
| reminder-setup | `예약 시각 = 아직 오지 않은 알림 시각` 실패 — `reminder_get` 의 pending 알림은 `[오늘T21:30, d7-2일T21:30]` 인데 `reminder_status().task.triggers` 가 `[]` | `node e2e/run.mjs first-run memo-create reminder-setup` — 2026-11-20 저녁 단독 실행 3회 모두 실패(메모 메뉴 T 작업 이전 코드 main 8fbac14 빌드 포함), 그 뒤 전체 실행에서는 통과 — 시각에 따라 달라지거나 불안정 | 원인 미조사(작업 스케줄러 등록 쪽). 전체 실행은 첫 실패에서 멈추므로 그 뒤 단계는 이름을 지정해 따로 실행 |
| memo-drag-scroll-long | 여러 단계를 이어 실행할 때 한 번 `Cannot read properties of undefined (reading 'id')`(시험 데이터 만들기 중), 콘솔에 새로고침 중 IPC `ERR_ABORTED` | 2026-11-20 `node e2e/run.mjs first-run memo-create linked-move-bottom upcoming … memo-drag …` 에서 1회. 단독 실행은 통과 | 불안정(타이밍 추정), 원인 미조사 |

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

## 실제 Staging 재연결 시험 재개

2026-11-05 에 보류했다 — Staging Web 의 `/memo-desktop/authorize` 가 비활성 빌드라 새 기기를 등록할 수 없다.
[인계 §7-2](../docs/PLAN_A_WORK_SYNC_HANDOFF.md) 가 끝나 승인 화면이 나온 뒤에만 시작한다. 승인 화면이 비활성이면 로그인을 반복하지 않는다.

조건: 서버는 `https://staging.planawork.com` 만, 별도 Google 시험 계정, 2028년 날짜만, 설치된 Staging 앱과 기존 메모는 건드리지 않는다.
`e2e/staging/` 은 Development 빌드(`com.plana.memo.dev`, credential `PLAN-A Memo (development)`)를 저장소 밖 폴더(`PLANA_STAGING_RUN`, 기본 `%TEMP%\plana-staging-run`)로 띄운다.

```bash
npm run e2e:build
node --no-warnings e2e/staging/fingerprint.cjs > before.json   # 설치본 지문(저장소 밖에 둔다)
node e2e/staging/drive.mjs start
node e2e/staging/drive.mjs init                                # 처음 한 번
# 시험 앱(target/debug/PLAN-A Memo.exe)만 끝내고 다시 start — 첫 실행 화면이 init 을 모르기 때문이다
node e2e/staging/drive.mjs start
node e2e/staging/drive.mjs status                              # env=development, webOrigin=staging, 저장 위치=시험 폴더 확인
node e2e/staging/login.mjs                                     # 격리 Chrome — 로그인·[확인]은 사람이
```

그다음 [인계 §7-3](../docs/PLAN_A_WORK_SYNC_HANDOFF.md) 의 항목을 차례로 확인하고, 결과는 Mock 결과와 따로 기록한다. 오류가 나면 덮어쓰거나 지우지 말고 멈춘 뒤 보고한다.

끝나면:

1. 시험 메모·서버 기기 등록·임시 폴더의 **정리 대상을 먼저 보고**한다. 기존 사용자 데이터는 대상이 아니다.
2. 승인되면 시험 앱에서 로그아웃(`(development)` credential 제거), Web 에서 시험 기기 해제, 시험 메모 정리, `PLANA_STAGING_RUN` 폴더 삭제 — Chrome 프로필에 로그인 정보가 남으므로 반드시 지운다.
3. `fingerprint.cjs` 출력이 `before.json` 과 같은지 확인한다(설치본이 그동안 직접 쓰였다면 그 변경만큼 달라질 수 있다).
