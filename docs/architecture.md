# PLAN-A Memo — Architecture

PLAN-A Work 개인 메모장과 **같은 화면·같은 편집 경험**을 가진 독립 Windows 로컬 메모 프로그램.
Web wrapper 가 아니다(planawork.com 을 띄우지 않는다).

```
PLAN-A Memo.exe
 ├─ React UI (Vite)            src/
 │    ├─ features/memo         주간 2×4 · 날짜 상세(메인/오전/오후 + 다가오는 같은 요일 · 지난 미완료 가져오기) · 행 · 메뉴 · 입력
 │    ├─ features/reminders    날짜 알림 설정
 │    ├─ features/next         Next List 탭
 │    ├─ features/search       List(찾아보기) · 전체 검색 · 즐겨찾기
 │    ├─ features/history      변경 이력
 │    ├─ features/sync         연결 버튼 · 상태 표시 · 충돌 비교
 │    ├─ features/auth         계정 연결
 │    ├─ features/settings     첫 실행 · 저장 위치 · Backup · 설정
 │    ├─ features/export       내보내기
 │    ├─ editor/               PLAN-A Work Rich Editor 래퍼(이미지 → 로컬 첨부)
 │    ├─ services/             자동 저장(DraftStore) · React Query
 │    ├─ tauri/api.ts          typed 명령(화면 ↔ Rust 의 유일한 입구)
 │    └─ vendor/plan-a-work/   Web 에서 가져온 공용 코드(docs/vendored-code.md)
 │
 └─ Rust (Tauri 2)             src-tauri/src/
      ├─ commands/             #[tauri::command] — 입력 검증 후 아래 모듈 호출
      ├─ memo/                 dayMemoService · nextListService · repository · history · search · export
      ├─ storage/              저장 위치 · SQLite 연결 · Migration · Backup · 위치 변경
      ├─ attachments/          이미지 복사·형식 확인 · attachment:// 프로토콜
      ├─ sync/                 contract(DTO) · mapper · SyncTransport(trait) · http(PlanAWork) · mock · SyncEngine · link
      ├─ auth/                 AuthProvider · PKCE · CredentialStore(Windows) · DeviceService
      └─ state.rs / config.rs  열린 저장소 · 환경(development/staging/production)
```

## 원칙

* **Local-first.** 입력 → Local DB 저장 → 화면 반영. 서버 응답을 기다리지 않는다. 인터넷 없이 모든 기능.
* **로그인 없이 전부.** 작성·수정·체크·삭제·이동·이미지·검색·History·Next·즐겨찾기·Export.
* **자동 업로드 없음.** 사용자가 [PLAN-A Work와 연결] 을 누른 DAY / NEXT_LIST 만 Sync 대상.
* **문서 단위.** 날짜 하루 전체(메인+오전+오후) = DayMemo 1건, Next List 하나 = 1건.
  연결·전송·충돌 비교 모두 이 단위다(항목별 연결 버튼 없음).
* **React 에 SQL 없음.** 화면은 `src/tauri/api.ts` 의 typed 명령만 부른다(ESLint 규칙으로 막는다).
  SQLite·파일은 Rust 가 관리한다. fs 플러그인을 쓰지 않아 WebView 에서 임의 경로 접근이 없다.
* **원자적 기록.** 로컬 변경과 Sync Outbox 기록은 같은 transaction(`memo::repo::touch`).

## 왜 rusqlite 인가(sqlx 대신)

단일 사용자·단일 프로세스 데스크톱 앱이라 연결 풀·비동기 드라이버가 필요 없다.
rusqlite 는 동기 API 라 transaction 경계가 분명하고, `bundled` 로 SQLite 를 함께 빌드해
사용자 PC 의 SQLite 버전과 무관하다. Migration 은 앱이 직접(버전 테이블 + transaction) 관리한다.
DB 작업은 async 명령 안에서 짧게 실행되고, 네트워크(await) 를 기다리는 동안 DB 잠금을 쥐지 않는다.

## 날짜 상세 도구

* **다가오는 ○요일** — 날짜 상세 아래에 **보고 있는 날짜** 기준 +7·+14일 같은 요일 카드(메모가 있는 더 먼 같은 요일은 [더 보기]).
  각 카드는 자기 날짜의 DAY 문서를 읽고 쓴다(`memo_day`) — 카드에서 체크·편집(기존 MemoRow·Rich Editor)·삭제하면 그 날짜만 바뀐다.
  보이기만 해서는 연결·업로드하지 않는다.
* **지난 미완료 가져오기** — D-7 의 미완료 체크리스트를 고른 것만 D 로 **복사**(`memo/carryover.rs`). 원본 그대로, 복사본은 새 id·
  미완료·같은 구역 맨 뒤, (원본, 대상 날짜) 복사 관계로 중복 방지. D 가 연결돼 있으면 D 의 변경으로 Outbox(`touch`).
* **날짜 알림** — 날짜당 하나(1주 전 · 2일 전 · 시각). 앱이 꺼져 있어도 알리도록 Windows **작업 스케줄러**에 이 사용자 권한의 작업
  하나(`PLAN-A Memo Reminders (<식별자>)`)를 등록한다. 작업은 시각마다 `<exe> --plana-reminder …` 를 실행하고, 이 프로세스는
  Tauri 창을 만들기 전에(main.rs) 갈라져 시각이 된 알림을 DB 에서 **선점**한 뒤 Windows 알림(Toast, AppUserModelID = 앱 식별자)을
  띄우고 다음 시각으로 작업을 다시 맞춘 뒤 끝난다. 알림 내용(미완료 수)은 알릴 때 센다 — 모두 완료면 띄우지 않고, 앱은 메모가 바뀔
  때마다 예약을 맞춘다(모두 완료한 날짜는 예약에서 빠짐). 알림을 누르면 `<scheme>://open?date=…`(protocol 활성화)로 앱이 그 날짜
  상세를 연다. PC 가 꺼져 시각을 놓치면 작업 스케줄러가 켜진 뒤 한 번 실행(StartWhenAvailable)하거나, 앱을 다시 열 때 '놓친 알림'
  으로 한 번 안내한다(15분 넘게 늦은 알림 · 대상 날짜가 지났으면 보내지 않음). 실행 중인 앱은 작업이 실행되지 않았을 때만(2분 유예)
  대신 알린다. 제거하면 작업도 지운다(`windows/installer-hooks.nsh`).

## 자동 저장 흐름

```
입력(Rich Editor) → DraftStore.edit (dirty) → 600ms 뒤 item_update_content (saving)
   → 성공: saved (캐시의 항목만 교체 — 편집 중 화면이 흔들리지 않게)
   → 실패: error ('저장 실패·확인 필요' + 다시 시도) — 저장됨으로 보이지 않는다
창 닫기(onCloseRequested) · 화면 전환 · 편집 종료 → flush
이미지 넣는 중에는 저장을 미룬다(반쪽 본문 방지)
```

## Sync 개요

`docs/sync-adapter.md` 참고. memo-sync-v1 Contract 의 `PlanAWorkSyncTransport` + `DesktopAuth`(브라우저 + PKCE + loopback)를
환경별로 쓴다(`state.rs`: production·staging = 실제 서버, development = `MockSyncTransport`). 도메인 ↔ 서버 DTO 변환은
`sync/mapper.rs` 한 곳 — Local DB·UI 는 서버 JSON 을 모른다.
