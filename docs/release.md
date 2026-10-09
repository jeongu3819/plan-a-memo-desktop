# PLAN-A Memo 배포 · 업데이트

PLAN-A Memo 는 Tauri 2 공식 Updater(서명 검증)로 업데이트한다. 이 문서는 **빌드 → 서명 → 업로드 → 확인** 절차와
환경(staging / production) 분리, 서명키 관리, 업데이트 파일을 둘 곳을 정한다.

> 이 저장소의 스크립트는 아무것도 업로드하지 않는다. 업로드·서버 설정은 이 문서대로 사람이 한다.

## 1. 환경 · 채널

| | staging(테스트) | production(실사용자) |
|---|---|---|
| 빌드 | `npm run dist:staging` | `npm run dist:production` |
| 앱 이름 · 식별자 | PLAN-A Memo Staging · `com.plana.memo.staging` | PLAN-A Memo · `com.plana.memo`(기존 설치와 같음) |
| 기본 설치 폴더 | `%LOCALAPPDATA%\PLAN-A Memo Staging` | `%LOCALAPPDATA%\PLAN-A Memo` |
| 기본 메모 폴더 | `%USERPROFILE%\PLAN-A Memo Staging` | `%USERPROFILE%\PLAN-A Memo` |
| 앱 설정 · 로그 | `%APPDATA%\com.plana.memo.staging` | `%APPDATA%\com.plana.memo` |
| 창 열기 scheme | `plana-memo-staging://` | `plana-memo://` |
| 계정 credential | Windows 자격 증명 `PLAN-A Memo (staging)` | `PLAN-A Memo (production)` |
| PLAN-A Work 서버 | https://staging.planawork.com | https://planawork.com |
| 업데이트 확인 | `<BASE>/staging/latest.json` | `<BASE>/production/latest.json` |
| 서명키 | staging 키 | production 키(다른 키) |

두 앱은 한 PC 에 함께 설치할 수 있고 서로의 설치·메모·로그인·업데이트를 건드리지 않는다.

**다른 채널 업데이트를 받지 않는 장치(3중)**
1. 앱에 들어가는 엔드포인트 경로에 자기 채널 이름이 있어야 한다(`/production/` · `/staging/`) — 아니면 업데이트 확인을 끈 채 빌드된다(`config.rs validate_update_endpoint`).
2. `latest.json` 의 `channel` 이 앱 채널과 다르면 설치를 제안하지 않는다(`update.rs`).
3. 채널마다 서명키가 다르다 — 잘못 올린 파일은 서명 검증에서 걸린다.

**빌드 실수 방지**
* 환경 변수 이름은 `PLANA_ENV` 다. `PLAN_A_ENV` 가 있으면 빌드가 멈춘다(예전에는 무시되어 release 빌드가 조용히 production 이 됐다 — 0.2.2 'staging' 설치본이 실제로는 production 이었던 원인).
* `PLANA_ENV=staging` 인데 식별자가 `com.plana.memo.staging` 이 아니면(=운영 설치를 덮어쓸 빌드) 멈춘다. production 도 반대로 확인한다(`src-tauri/build.rs`).
* `dist:production` 은 운영 서버 주소를 DNS 에서 찾지 못하거나 memo-sync API 가 없으면 멈춘다(`--skip-server-check` 로만 건너뜀).
* 세 곳의 버전(package.json · src-tauri/Cargo.toml · src-tauri/tauri.conf.json)이 다르면 멈춘다.

## 2. 서명키

```powershell
# 채널마다 한 번. 비밀번호를 꼭 정한다(빈 비밀번호 금지).
npx tauri signer generate -w "$HOME\.plan-a-memo-keys\production.key"
npx tauri signer generate -w "$HOME\.plan-a-memo-keys\staging.key"
# 공개키만 저장소에 둔다
Copy-Item "$HOME\.plan-a-memo-keys\production.key.pub" src-tauri\updater\production.pub
Copy-Item "$HOME\.plan-a-memo-keys\staging.key.pub"    src-tauri\updater\staging.pub
```

* **개인키·비밀번호는 저장소·EXE·공유 폴더·메신저에 두지 않는다.** `.gitignore` 가 `*.key` 를 막지만 그것만 믿지 않는다.
  보관: 비밀번호 관리자(1Password 등) 또는 CI 비밀값(GitHub Actions secrets · AWS Secrets Manager). 오프라인 백업 1부.
* 개인키를 잃으면 **이미 설치된 앱에 더 이상 업데이트를 보낼 수 없다**(새 키로 서명한 파일은 기존 앱이 거부) — 사용자가 새 Installer 를 직접 받아야 한다.
* 개인키가 유출됐다고 의심되면: 새 키쌍 → 새 공개키로 빌드한 버전을 **기존 키로 서명해** 배포(앱이 새 공개키를 받음) → 이후 새 키만 사용.
* 앱은 `requireSignedVersion` 을 켠다 — 서명 안에 기록된 버전과 `latest.json` 의 버전이 다르면 설치하지 않는다(예전 설치 파일로 바꿔치기 방지).

## 3. 업데이트 파일을 둘 곳 — 비교와 추천

| | A. GitHub Releases | B. AWS S3 + CloudFront |
|---|---|---|
| 비용 | 무료 | 저장 거의 0 + 전송량(설치 파일 약 3.4MB × 사용자 수). 수백~수천 명이면 월 수 달러 이하 |
| 소스 비공개 | 비공개 저장소의 릴리스 파일은 **로그인 없이 내려받을 수 없다** → Updater 에 토큰을 넣어야 함(금지). 바이너리 전용 **공개 저장소**를 따로 둬야 한다 | 소스 저장소와 무관(버킷 비공개 + CloudFront OAC) |
| 주소 | github.com/…/releases/download/… (도메인 통제 불가) | `https://downloads.planawork.com/...` 같은 자기 도메인 |
| latest.json 캐시 | 통제 불가 | `latest.json` 은 짧게(no-cache), 버전 파일은 영구 캐시 — 배포 순서 보장 |
| 운영 | 매우 간단(UI 업로드) | IAM 업로드 권한·버킷·배포 설정 필요(1회) |
| 로그·차단 | 제한적 | 접근 로그, 필요 시 지역/버전 차단 |
| 이미 쓰는 인프라 | GitHub 저장소 | PLAN-A Work staging 이 AWS(서울)에 있음 |

**추천: B. S3 + CloudFront** (`downloads.planawork.com`, 버킷은 비공개 + OAC).
* 소스 저장소를 비공개로 돌려도 업데이트 경로가 바뀌지 않는다. (확인: 지금 `github.com/jeongu3819/plan-a-memo-desktop` 은 로그인 없이 열리는 **공개 저장소**다.
  소스를 비공개로 할 계획이면 A 는 바이너리 전용 공개 저장소가 하나 더 필요하다.)
* 자기 도메인·짧은 `latest.json` 캐시로 "파일 먼저, 공지는 나중" 순서를 지킬 수 있다.
* PLAN-A Work 가 이미 AWS 에 있어 계정·결제·권한 체계를 새로 만들 필요가 없다. 업데이트 서버(동적 API)는 만들지 않는다 — 정적 파일만.
* 빠르게 시작해야 하면 A(바이너리 전용 공개 저장소)로 시작하고 나중에 B 로 옮길 수 있다 — 단, 앱에 들어간 엔드포인트가 바뀌므로
  옮기는 버전은 **두 주소 모두에** `latest.json` 을 올려 한 번 이어 줘야 한다. 처음부터 B 를 권한다.

**B 준비 항목(담당자 — 이 저장소에서 하지 않음)**
1. S3 버킷(비공개, 버전 관리 켬) · CloudFront 배포(OAC, HTTPS 전용, `*.json` 캐시 0~60초)
2. 도메인 `downloads.planawork.com` → CloudFront(planawork.com DNS 는 Cloudflare — CNAME 추가, 인증서는 ACM us-east-1)
3. 업로드 전용 IAM 사용자/역할(해당 버킷 `plan-a-memo/*` 쓰기만)
4. `PLANA_UPDATE_BASE_URL=https://downloads.planawork.com/plan-a-memo`

**경로 규칙**
```
<BASE>/<채널>/latest.json                                   # 앱이 확인하는 파일(마지막에 올린다)
<BASE>/<채널>/<버전>/PLAN-A-Memo_<버전>_x64-setup.exe       # 업데이트 파일(= 설치 파일, 서명 대상)
<BASE>/<채널>/<버전>/PLAN-A-Memo_<버전>_x64-setup.exe.sig
<BASE>/<채널>/PLAN-A-Memo-Setup.exe                         # 새 사용자 다운로드용(선택)
```
staging 파일명은 `PLAN-A-Memo-Staging_<버전>_x64-setup.exe`.

`latest.json`(dist 스크립트가 만든다):
```json
{ "version": "0.2.3", "channel": "production", "notes": "- …(release-notes/0.2.3.md)", "pub_date": "…",
  "platforms": { "windows-x86_64": { "signature": "<.sig 내용>", "url": "<BASE>/production/0.2.3/PLAN-A-Memo_0.2.3_x64-setup.exe" } } }
```

## 4. 새 버전 배포 절차

1. **버전 올리기** — `package.json` · `src-tauri/Cargo.toml` · `src-tauri/tauri.conf.json` 같은 값(예: 0.2.4). `package-lock.json` 은 `npm install` 로 맞춘다.
2. **릴리스 노트** — `release-notes/0.2.4.md`(사용자에게 그대로 보인다. `- ` 목록 권장, 내부 용어·민감 정보 금지).
3. **검사** — `npm run lint && npm run type-check && npm test && npm run test:rust && npm run e2e:build && npm run e2e`
   (설치·업데이트 경로를 바꿨다면 `npm run e2e:installer` 도).
4. **staging 빌드**
   ```powershell
   $env:PLANA_UPDATE_BASE_URL = "https://downloads.planawork.com/plan-a-memo"
   $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$HOME\.plan-a-memo-keys\staging.key" -Raw
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<staging 키 비밀번호>"
   npm run dist:staging
   ```
   → `release/staging/0.2.4/…exe`·`.sig`, `release/staging/latest.json`, `release/staging/PLAN-A-Memo-Staging-Setup.exe`
5. **staging 업로드** — ① 버전 폴더의 exe·sig ② (선택) Setup.exe ③ **마지막에** latest.json. 순서를 바꾸면 앱이 아직 없는 파일을 받으려 한다.
6. **staging 확인** — 이전 staging 버전이 설치된 PC 에서 설정 → [업데이트 확인] → 설치 → 재실행 후 버전·메모 확인.
7. **production 빌드** — 4와 같되 production 키·비밀번호로 `npm run dist:production`. (서버 확인에서 멈추면 서버를 먼저 고친다.)
8. **production 업로드** — 5와 같은 순서. 기존 사용자 앱은 시작 20초 뒤·6시간마다 확인하고, 알림만 띄운다(설치는 사용자가 누를 때).
9. **기록** — git tag `v0.2.4`, 업로드한 파일의 sha256(빌드 출력) 기록. 환경 변수의 키는 셸을 닫아 지운다.

**되돌리기** — Updater 는 낮은 버전으로 내려가지 않는다. 문제가 있으면 ① `latest.json` 을 이전 내용으로 되돌려 더 퍼지지 않게 하고
② 고친 버전을 더 높은 번호로 배포한다.

## 5. 설치 · 업데이트 · 제거 정책(Windows)

* **사용자 단위 설치**(NSIS `currentUser`): 기본 `%LOCALAPPDATA%\PLAN-A Memo`, 관리자 권한 없음. 설치 화면에서 다른 폴더를 고를 수 있다.
* **쓰기 권한이 없는 폴더**(관리자가 만든 `C:\plan_a_work`, `C:\Program Files` 등)를 고르면 설치 전에 안내하고 멈춘다(`src-tauri/windows/installer-hooks.nsh`).
  Windows 권한 정책을 우회하지 않는다. 그런 폴더가 꼭 필요하면 관리자가 그 폴더에 사용자 쓰기 권한을 주거나, 다른 폴더를 쓴다.
* **업데이트**: 앱 안 업데이트(Updater)·새 Installer 실행 모두 이전 설치 위치를 그대로 쓴다(레지스트리 `HKCU\Software\PLAN-A\PLAN-A Memo`). 앱이 실행 중이면 설치 프로그램이 닫는다.
* **제거**: 설치 폴더의 파일을 지울 권한이 없으면(관리자 권한으로 설치했던 폴더) 아무것도 지우지 않고 멈춘 뒤 '관리자 권한으로 실행' 을 안내한다 —
  예전처럼 파일은 남았는데 '제거 완료'·등록 정보만 지워지는 불일치가 생기지 않는다. 그래도 실행 파일이 남으면 위치를 알려 준다.
* **메모 데이터는 설치 폴더 밖**(기본 `%USERPROFILE%\PLAN-A Memo`)이라 설치·업데이트·제거가 지우지 않는다. 저장 위치로 설치 폴더·앱 설정 폴더
  (`%APPDATA%\com.plana.memo*`, `%LOCALAPPDATA%\com.plana.memo*`, `%LOCALAPPDATA%\PLAN-A Memo*`)는 고를 수 없다.
  제거 화면의 [앱 데이터 삭제]는 앱 설정(저장 위치 기록·창 위치·로그)만 지운다 — 다시 설치하면 저장 위치를 다시 골라(같은 폴더) 이어 쓴다.
* **업데이트 직전**: 화면의 남은 입력 저장 → 저장 실패·이미지 넣는 중이면 멈춤 → `pre-update` Backup → 내려받기·서명 검증 → 설치.
  업데이트는 메모를 서버로 올리지 않는다(연결한 날짜·List 만, 기존 Sync 규칙 그대로).

## 6. PLAN-A Work 서버 준비(계정 연결에 필요 — 2026-10-08 확인 결과)

| 확인 | 결과 | 필요한 조치(Backend/인프라) |
|---|---|---|
| `planawork.com` DNS | Cloudflare 에 NS·SOA 만 있고 **A/AAAA 레코드 없음** → 이름 조회 실패 | 운영 서버 주소 레코드 추가(또는 실제 운영 주소를 정해 `PLANA_SERVER_ORIGIN` 으로 빌드) |
| `staging.planawork.com` | HTTPS 정상(`/api/health` 200, Backend `2026-07-03-…`) | — |
| staging `GET /api/memo-sync/native/changes` | `404 {"detail":"Not Found"}` — 라우트 없음 | memo-sync-v1 라우터 배포 + `MEMO_SYNC_ENABLED`·SCHEMA_READY·namespace(MEMO_SYNC_INTEGRATION_READINESS.md §7) |
| staging `POST /api/<아무 경로>` | `401 {"detail":"Authentication required"}` — 라우팅 전 전역 인증 | `POST /api/memo-sync/native/auth/start`·`/auth/exchange` 는 로그인 전 요청이다 → 전역 인증 미들웨어에서 **이 두 경로만** 제외(Desktop credential 경로는 Contract 의 Bearer 검사 유지). 인증 우회가 아니라 Contract 대로의 공개 경로다 |
| 브라우저 동의 화면 `/memo-desktop/authorize` | 확인 불가(위 API 가 없음) | Web 빌드 `VITE_MEMO_SYNC_ENABLED=true` |

Desktop 은 이 상태를 원인별로 안내한다: 서버 주소 없음(DNS) · 보안 연결(TLS) · 응답 없음 · 서버에 기능 없음(404) · 서버 인증 설정(auth/start 401) · 일시적 서버 오류(5xx).
진단 로그(`%APPDATA%\com.plana.memo\logs`)에는 단계·분류·서버 host 만 남는다(토큰·code·verifier·메모 없음).
