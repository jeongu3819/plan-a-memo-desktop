# PLAN-A Memo — Architecture

PLAN-A Work 개인 메모장과 **같은 화면·같은 편집 경험**을 가진 독립 Windows 로컬 메모 프로그램.
Web wrapper 가 아니다(planawork.com 을 띄우지 않는다).

```
PLAN-A Memo.exe
 ├─ React UI (Vite)            src/
 │    ├─ features/memo         주간 2×4 · 날짜 상세(메인/오전/오후) · 행 · 메뉴 · 입력
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
