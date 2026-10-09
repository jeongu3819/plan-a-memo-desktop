# PLAN-A Memo

PLAN-A Work 개인 메모장과 **같은 화면·같은 편집 경험**의 Windows 로컬 메모 프로그램.

* 로그인 없이 모든 기능 — 메모 작성·수정·체크·삭제·이동·정렬·이미지·검색·History·Next·즐겨찾기·내보내기
* 사용자 PC 에 저장(SQLite + 첨부 폴더), 인터넷 없이 동작
* 사용자가 고른 **날짜 하루(DayMemo)** 또는 **Next List** 만 PLAN-A Work 와 연결(자동 업로드 없음)
* 동시 수정은 자동 덮어쓰기 없이 비교 화면에서 선택, 선택하지 않은 쪽은 History 보관

> PLAN-A Work 연동은 memo-sync-v1 Contract 의 **실제 Adapter**(HTTPS · 브라우저 로그인 + PKCE + 127.0.0.1 loopback)로
> 구현했다. 운영·staging 빌드는 실제 서버, 개발 빌드(서버 주소 없음)는 개발용 Mock 서버를 쓴다.
> **실제 PLAN-A Work 서버와의 통합 검증은 아직이다**(서버 DB migration·feature flag 적용 전) — [docs/sync-adapter.md](docs/sync-adapter.md).

## 기술 스택

Tauri 2 · React 18 · TypeScript 5.9 · Vite 7 · MUI 7 · Rust(stable) · SQLite(rusqlite, bundled)

## 요구 사항(Windows 개발 PC)

* Node.js 22 (`.nvmrc` 와 같은 22.x 권장)
* npm: `npm ci` 는 npm 10.9 에서도 된다. 패키지를 **새로 추가**할 때 npm 10.9.8 은 arborist 버그
  (`Cannot read properties of null (reading 'edgesOut')`)로 실패하므로 `npx npm@11 install <패키지>` 를 쓴다
  (실제 peer 충돌은 없다 — npm 11 `--strict-peer-deps` 로 확인).
* Rust stable (`rustup`, MSVC toolchain)
* Microsoft C++ Build Tools(“C++를 사용한 데스크톱 개발”) + Windows SDK
* WebView2 Runtime(Windows 11 기본 포함)

## 실행

```bash
npm install
npm run tauri dev        # 앱 실행(개발)
npm run dev              # 화면 개발 서버만(브라우저에서는 로컬 저장소에 접근하지 않음)
```

## 테스트 · 검사

```bash
npm run e2e:build && npm run e2e   # 실제 앱 E2E(개발용 Mock 서버) — e2e/README.md
npm test                 # Frontend(vitest) — Web 공용 코드 테스트 포함
npm run lint             # ESLint(React 에 SQL 금지 규칙 포함)
npm run type-check
npm run test:rust        # Rust — SQLite·Migration·Crash·위치 변경·Contract DTO·HTTP Adapter·Mock Sync·Auth·네트워크 오류 분류
npm run e2e:installer    # 실제 Installer·Updater·제거(별도 테스트 앱 'PLAN-A Memo InstTest' — 10분 이상)
```

## 빌드 · Installer

```bash
npm run dist:staging       # 테스트용 — 'PLAN-A Memo Staging'(com.plana.memo.staging), staging 서버, staging 업데이트 채널
npm run dist:production    # 실사용자용 — 'PLAN-A Memo'(com.plana.memo), 운영 서버, production 업데이트 채널
```
환경을 정하지 않은 `npm run dist` 는 멈춘다. 환경 변수 이름은 **`PLANA_ENV`** 다 — `PLAN_A_ENV` 를 주면 빌드가 멈춘다
(예전에는 조용히 production 이 됐다). 결과는 `release/<환경>/`. 배포·업데이트 절차는 [docs/release.md](docs/release.md).

운영 빌드의 기본 서버는 https://planawork.com, staging 은 https://staging.planawork.com 이다(`PLANA_SERVER_ORIGIN` 으로 바꿀 수 있음,
`.env.example`). `dist:production` 은 서버 주소를 찾지 못하거나 memo-sync API 가 없으면 멈춘다.

Installer 는 사용자 단위 설치(기본 `%LOCALAPPDATA%\PLAN-A Memo`, 관리자 권한 없음)이고 시작 메뉴 바로가기와 `plana-memo://`
(창 열기 전용, staging 은 `plana-memo-staging://`)를 등록한다. 쓰기 권한이 없는 폴더를 고르면 설치 전에 안내하고 멈춘다.
**제거·업데이트해도 메모 저장 폴더는 지우지 않는다**(저장 위치는 설치 폴더 밖 — 기본 `%USERPROFILE%\PLAN-A Memo`).

## 폴더

```
src/                  React UI (features · editor · services · tauri · domain · vendor/plan-a-work)
src-tauri/src/        Rust (commands · memo · storage · attachments · sync · auth)
src-tauri/tests/      Rust 통합 테스트
migrations/           SQLite migration(앱에 포함)
docs/                 architecture · local-storage · sync-adapter · vendored-code · Contract 검증 · PLAN-A Work 인계
docs/upstream-plan-a-work/  PLAN-A Work 에서 복사한 memo-sync-v1 참고 자료(읽기 전용 — SQL 실행 금지)
```

## 문서

* [Architecture](docs/architecture.md)
* [Local Storage](docs/local-storage.md) — 저장 위치·Schema·Backup·위치 변경
* [Sync Adapter](docs/sync-adapter.md) — SyncTransport·Mock·Conflict·Auth·실제 Adapter 교체 목록
* [Contract 검증 보고](docs/sync-contract-verification.md) — memo-sync-v1 4개 참고 파일과 Desktop 구현 대조, 미검증 항목
* [PLAN-A Work 수정 요청](docs/PLAN_A_WORK_SYNC_HANDOFF.md) — https 링크 오탐 정규식, List 이름 API, 통합 테스트 준비
* [가져온 Web 코드](docs/vendored-code.md)
