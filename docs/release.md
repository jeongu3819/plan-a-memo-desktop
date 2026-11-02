# PLAN-A Memo 배포 · 업데이트

PLAN-A Memo 는 Tauri 2 공식 Updater(서명 검증)로 업데이트한다. 이 문서는 **빌드 → 서명 → 업로드 → 확인** 절차와
환경(staging / production) 분리, 서명키 관리, 업데이트 파일을 둘 곳을 정한다.

> Staging 은 `npm run release:staging` · `npm run publish:staging`(승인 후 업로드, §4-1)으로 한다. Production 업로드와 서버 설정은 스크립트가 하지 않는다 — 이 문서대로 사람이 한다.

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
   올린 뒤 `npm run release:verify:staging`(같은 `PLANA_UPDATE_BASE_URL`) — 게시된 latest.json 의 channel·version·signature 와
   업데이트 파일(HTTP 200·sha256)을 dist 결과와 비교한다. 실패하면 앱에서 시험하기 전에 고친다.
6. **staging 확인** — 이전 staging 버전이 설치된 PC 에서 설정 → [업데이트 확인] → [업데이트] → 재실행 후 버전·메모 확인.

   (Staging 의 1~5 는 `npm run release:staging` · `npm run publish:staging` 이 한다 — §4-1.)

7. **production 빌드** — 4와 같되 production 키·비밀번호로 `npm run dist:production`. (서버 확인에서 멈추면 서버를 먼저 고친다.)
8. **production 업로드** — 5와 같은 순서, 확인은 `npm run release:verify:production`. 기존 사용자 앱은 시작 20초 뒤·6시간마다 확인하고, 알림만 띄운다(설치는 사용자가 누를 때).
9. **기록** — git tag `v0.2.4`, 업로드한 파일의 sha256(빌드 출력) 기록. 환경 변수의 키는 셸을 닫아 지운다.

**되돌리기** — Updater 는 낮은 버전으로 내려가지 않는다. 문제가 있으면 ① `latest.json` 을 이전 내용으로 되돌려 더 퍼지지 않게 하고
② 고친 버전을 더 높은 번호로 배포한다.

**dist 스크립트가 멈추는 경우(업데이트 관련)** — 아래 상태로 만든 설치본은 앱 안 업데이트를 받을 수 없어 다시 직접 설치해야 하므로 빌드 전에 막는다.
* `PLANA_UPDATE_BASE_URL` 이 https 가 아니거나 계정 정보·로컬 주소가 있거나, 경로에 다른 채널 이름(`/production/`·`/staging/`)이 들어 있음
* `src-tauri/updater/<채널>.pub` 이 Tauri 서명 공개키 형식이 아님
* 빌드한 실행 파일에 업데이트 주소가 들어가지 않음(빌드 캐시 문제 — `cargo clean` 후 다시)

## 4-1. Staging 릴리스 자동화

평소 흐름: **기능 개선 → 테스트 → `npm run release:staging` → `npm run publish:staging`(버전 번호 입력으로 승인) → 앱에서 [업데이트 확인]**

| 명령 | 하는 일 | 서버 변경 |
|---|---|---|
| `npm run release:check-server` | 업데이트 경로 확인 — 없는 파일은 404(Nginx 기본 HTML 404 도 정상, 웹 화면 HTML 200 은 실패), `latest.json` 은 404 또는 staging JSON(`-- --probe` 는 확인 파일의 200·JSON Content-Type·본문까지) | 없음 |
| `npm run release:staging` | Git 확인 → 서버 확인 → 서명 키 확인 → 버전 올리기 → 릴리스 노트 → 검사(type-check·lint·Vitest·Rust) → 서명 빌드 → 산출물 검증 → `release-record.json` 기록 | 없음 |
| `npm run publish:staging -- --dry-run` | 게시 대상·해시·서버 현재 버전만 보여 준다 | 없음 |
| `npm run publish:staging` | 파일 재검증 → 대상 표시 → **버전 번호 입력(승인)** → 설치 파일·서명 업로드 → HTTP 로 내려받아 해시 비교 → 마지막에 `latest.json` | 있음 |
| `npm run release:verify:staging` | 게시본과 빌드 결과를 다시 비교(읽기만) | 없음 |
| `npm run update:data-check -- snapshot` · `compare` | 업데이트 전후 메모·History·이미지 비교(내용은 보지 않고 개수·해시만, 원본에 쓰지 않음) | 없음 |

Production 게시 명령은 없다. 두 스크립트는 staging 전용이고 `PLANA_ENV` 가 다른 값이면 멈춘다.

**값이 있는 곳**

| 파일 | 내용 | Git |
|---|---|---|
| `scripts/release.staging.json` | 업데이트 주소 · 개인키 위치(`~/` 경로) | 커밋 |
| `scripts/release.staging.local.json` | SSH 대상(서버·사용자·키 파일·폴더) | **커밋 안 함**(`.gitignore`) — `release.staging.local.example.json` 을 복사해 만든다 |
| `src-tauri/updater/staging.pub` | 공개키 | 커밋 |
| `~/.plan-a-memo-keys/staging.key` | 개인키 | 저장소 밖 |

개인키와 비밀번호는 저장하지 않는다. 비밀번호는 실행할 때 화면에 보이지 않게 입력한다(또는 그 셸에서 `$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). 서명 키를 새로 만들지 않는다 — 설치된 앱이 업데이트를 받지 못한다.

**버전 번호** — 기본은 패치 +1. `--bump minor|major`, `--version 0.3.0`, `--no-bump`(이번 버전을 게시 전에 다시 빌드).
이미 빌드 기록이 있거나 게시본 이하인 번호는 새 업데이트로 다시 쓰지 않는다.

**릴리스 노트** — `release-notes/<버전>.md` 가 없으면 지난 빌드 이후 커밋 제목으로 초안을 만들고 멈춘다. 초안 표시 줄을 지워야 진행한다(앱 화면에 그대로 보인다).

**메모리** — Rust 병렬 작업은 기본 4개다. 메모리가 부족하면 다른 프로그램을 닫거나 `$env:CARGO_BUILD_JOBS=2` 로 줄인다. 릴리스 빌드의 마지막 링크(LTO)는 병렬 수와 관계없이 메모리를 많이 쓴다.

### 실패했을 때

`release:staging` 은 버전 파일·`release/staging/latest.json`·설치 파일 사본·버전 폴더의 사본과 기록을 `release/staging/.release-tx/` 에 먼저 남긴다.

| 상황 | 결과 | 할 일 |
|---|---|---|
| 서버 미준비 · 비밀번호 틀림 · 키 불일치 | 버전을 올리기 전에 멈춤 | 원인을 고치고 다시 실행 |
| 검사·빌드·산출물 검증 실패, Ctrl+C | 자동으로 시작 전 상태로 되돌림(`↩` 표시) | 고치고 다시 실행 — 같은 번호로 다시 시도 |
| 노트 초안에서 멈춤 | 되돌림, `release-notes/<버전>.md` 만 남음 | 노트를 고치고 다시 실행 |
| 강제 종료(메모리 부족 등 — 되돌릴 틈 없음) | 버전이 올라간 채 남음 | `npm run release:staging` 다시 실행 — 먼저 되돌린 뒤 진행 |
| `--no-bump` 재빌드 실패 | 이전 빌드 폴더·기록 복원 | 그대로 게시 가능 |

성공하면 버전 파일 변경은 남는다(커밋은 사람이 한다).

| 게시가 멈추는 경우 | 서버 상태 | 할 일 |
|---|---|---|
| 서명이 `staging.pub` 과 다름 · 서명된 버전이 다름 · 빌드 뒤 파일이 바뀜 · 게시본 이하의 버전 | 변경 없음 | 새 번호로 다시 빌드 |
| 서버가 웹 화면 HTML 을 200 으로 응답 | 변경 없음 | §4-2 |
| SSH·업로드 실패 | `.incoming-*` 만 남을 수 있음(웹에 안 보임) | 그대로 다시 실행 — 지우고 다시 올린다 |
| 올린 파일 해시 불일치 · 같은 버전 폴더에 다른 파일 | 버전 폴더만 있음, `latest.json` 그대로(앱은 이전 버전을 봄) | 새 번호로 다시 빌드·게시. 잘못된 폴더는 나중에 지운다 |
| `latest.json` 을 올린 뒤 다시 읽은 내용이 다름 | 새 `latest.json` 일 수 있음 | 캐시·서버 확인, 필요하면 아래 되돌리기 |

**게시 되돌리기** — 앱에 잘못된 버전이 보이면 `latest.json` 만 되돌리고 고친 버전을 더 높은 번호로 게시한다. 이미 받은 PC 는 그 다음 버전으로 올라간다(앱은 낮은 버전으로 내려가지 않는다).

```bash
# 두 번째 게시 이후
cp /var/www/memo-updates/staging/latest.previous.json /var/www/memo-updates/staging/latest.json
# 첫 게시를 취소(이전 파일 없음)
rm /var/www/memo-updates/staging/latest.json
```

**Node 경로** — 스크립트는 `C:\.nodejs` Shim 대신 실제 Node 폴더에서 npm·Tauri CLI 를 실행한다(`PLANA_NODE_HOME` → `C:\nvm\v<.nvmrc>` → 실행 중인 node). `npm` 자체가 Shim 문제로 실행되지 않으면:
`C:\nvm\v22.23.2\node.exe scripts\release-staging.mjs` · `C:\nvm\v22.23.2\node.exe scripts\publish-staging.mjs`

## 4-2. Staging 서버 준비(1회 — 서버 변경이므로 승인 후)

업데이트 주소는 `https://staging.planawork.com/memo-updates/staging/latest.json` 이다. **이 경로가 설정되지 않은 서버는 없는 파일에도 웹 화면 HTML 을 200 으로 돌려준다**(SPA fallback) — 그 상태에서는 `release:staging` 과 `publish:staging` 이 멈춘다. 없는 파일의 404 는 본문 형식을 가리지 않는다(Nginx 기본 404 는 HTML 이다).

아래에서 `<서버>` · `<사용자>` · `<키>` 는 `scripts/release.staging.local.json` 의 값이다.

1. **접속** — 이 PC 의 공인 IP 만 보안 그룹의 22 번에 허용한다. 접속 확인(읽기만):
   ```powershell
   ssh -i "$HOME\.ssh\<키>" <사용자>@<서버> "whoami; sudo nginx -T 2>/dev/null | grep -nE 'server_name|listen |location |root |error_page|include .*sites|^# configuration file'"
   ```
   **기존 설정을 보기 전에는 아무것도 바꾸지 않는다.** 볼 것: staging 의 `server { }` 가 어느 파일인가 · `/memo-updates` 와 겹치는 `location` 이 없는가 · nginx 가 Docker 안이 아니라 호스트에 있는가(Docker 면 폴더를 볼륨으로 연결해야 한다) · SSH 사용자가 `release.staging.local.json` 과 같은가.
2. **설정 파일 백업·폴더 만들기**(게시는 SSH 사용자 권한으로 한다, sudo 를 쓰지 않는다):
   ```bash
   sudo cp -p <staging server 파일> <staging server 파일>.bak-before-memo-updates
   sudo mkdir -p /var/www/memo-updates/staging
   sudo chown -R <사용자>:www-data /var/www/memo-updates
   sudo chmod -R 2775 /var/www/memo-updates
   ```
3. **nginx** — `scripts/server/memo-updates.nginx.conf` 내용을 staging 의 `server { }` 안(`location /` 앞)에 넣는다. `nginx -t` 가 통과할 때만 reload 한다:
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```
   웹 화면·API 가 그대로인지 함께 본다. 문제가 있으면 백업 파일로 되돌리고 `sudo nginx -t && sudo systemctl reload nginx`.
4. **이 PC 에서 확인** — 파일이 없을 때 404:
   ```powershell
   npm run release:check-server
   ```
5. **정적 파일 확인** — 서버에 확인 파일을 잠깐 두고, 끝나면 지운다:
   ```bash
   echo '{"probe":"plan-a-memo-update-probe"}' > /var/www/memo-updates/staging/probe.json
   ```
   ```powershell
   npm run release:check-server -- --probe
   ```
   ```bash
   rm /var/www/memo-updates/staging/probe.json
   ```

4·5 번이 통과해야 v0.2.4 서명 빌드를 시작한다(주소가 설치본에 영구히 들어간다). Production 파일·키는 이 경로에 두지 않는다.

## 4-3. Staging 앱 안 업데이트 시작 — 0.2.3 에서 한 번 전환

지금 설치된 PLAN-A Memo Staging 0.2.3 은 공개키·업데이트 주소 없이 빌드되어 [업데이트 확인]이
"이 버전에는 업데이트 서버가 설정되어 있지 않습니다" 로 끝난다. 앱 안에서는 이 설정을 바꿀 수 없으므로
**업데이트 설정이 들어간 Staging 설치본을 한 번 직접 설치**하고, 그다음 버전부터 앱 안에서 업데이트한다.

공개키와 게시 주소는 **전환 설치본에 영구히 들어간다** — 바꾸면 다시 직접 설치해야 하므로 §4-2 의 주소를 계속 쓴다.
`src-tauri/updater/staging.pub` 은 커밋한다(개인키는 저장소 밖 · 비밀번호 관리자 + 오프라인 백업).

**전환 설치본(0.2.4)**
1. `npm run release:staging` — 0.2.3 → 0.2.4, 노트는 `release-notes/0.2.4.md`. 출력에 `업데이트 확인: …/staging/latest.json` 이 보여야 한다.
2. `npm run publish:staging -- --dry-run` 으로 대상을 본 뒤 `npm run publish:staging` — 0.2.4 게시. `npm run release:verify:staging` 으로 확인한다.
3. 설정 → Backup 을 한 번 만들어 둔다(선택 — 설치는 메모를 건드리지 않는다).
4. 앱을 닫고 `release/staging/0.2.4/PLAN-A-Memo-Staging_0.2.4_x64-setup.exe` 를 0.2.3 위에 실행한다. 식별자(`com.plana.memo.staging`)·설치 폴더가 같아 그 자리에서 바뀐다.
5. 확인: 설정 → 앱 정보 → 현재 버전 0.2.4, [업데이트 확인] → "최신 버전을 사용 중입니다". 메모·저장 위치·계정 연결 상태가 그대로인지 본다.

**유지되는 것** — 설치·업데이트는 설치 폴더(`%LOCALAPPDATA%\PLAN-A Memo Staging`)의 프로그램 파일만 바꾼다.
메모 SQLite·이미지·History·Backup(`%USERPROFILE%\PLAN-A Memo Staging` 또는 고른 저장 위치), 저장 위치 기록·로그(`%APPDATA%\com.plana.memo.staging`),
계정 연결 credential(Windows 자격 증명 `PLAN-A Memo (staging)`)과 동기화 상태(메모 DB 안)는 설치 폴더 밖이라 그대로다.
앱 안 업데이트는 여기에 더해 설치 직전 `pre-update` Backup 을 만들고, 진행 중인 Sync 를 최대 10초 기다린다(끝나지 않은 요청은 Outbox 에 남아 다시 보낸다). 운영 앱(`com.plana.memo`)과는 서로 건드리지 않는다.

**첫 앱 안 업데이트 시험(0.2.4 → 0.2.5)** — 실제 Staging 앱에서 한다. 표의 ☐ 를 모두 확인해야 완료다.

준비
1. 0.2.4 앱에서 시험용 메모를 쓴다: 체크리스트 메모 하나 · 이미지 붙여넣은 메모 하나 · 내용을 두 번 고친 메모 하나(History). 메모 내용과 History 개수, 이미지가 보이는지 적어 둔다.
2. `npm run release:staging`(0.2.5, 노트 초안을 고친다) → `npm run publish:staging` → `npm run release:verify:staging`.
3. 앱을 닫고 `npm run update:data-check -- snapshot` — 저장 위치와 개수가 맞는지 본다. 앱을 다시 연다.

| | 하는 일 | 확인 |
|---|---|---|
| ☐ | 입력칸에 글을 쓰다가 바로 설정을 누른다 | 쓰던 글이 메모로 저장되고 입력칸이 빈다(바깥을 누르면 자동 저장). 저장에 실패해 글이 입력칸에 남아 있으면 [업데이트]가 설치를 멈춘다 |
| ☐ | 설정 → **[업데이트 확인] 클릭** | 창 제목 "새로운 버전이 있습니다 — v0.2.5" · 변경 사항 · [나중에] [업데이트] |
| ☐ | [나중에] | 앱 그대로, 버전 0.2.4 |
| ☐ | 다시 [업데이트 확인] → **[업데이트] 클릭** | 저장·Backup 준비 → 내려받는 중 % → 서명 확인 → 설치 프로그램 |
| ☐ | 설치 | 앱이 닫혔다가 저절로 다시 열림. 관리자 권한 요청 없음 |
| ☐ | 설정 → 앱 정보 | 현재 버전 0.2.5, [업데이트 확인] → "최신 버전을 사용 중입니다"(같은 번호는 새 업데이트가 아니다) |
| ☐ | 메모 | 준비 1의 메모·체크 상태·이미지·History 그대로, 저장 위치 그대로 |
| ☐ | 앱을 닫고 `npm run update:data-check -- compare` | "보존 확인" · pre-update Backup 있음 |
| ☐ | 계정 연결·Sync | 다시 로그인 없이 연결 유지, Sync 정상, 설치 전 대기 건 전송 |
| ☐ | 알림 | 작업 스케줄러 항목 유지(`schtasks /Query /FO LIST \| findstr /i "PLAN-A"`), 설정의 알림 값 그대로 |
| ☐ | 운영 앱(설치돼 있다면) | 버전·메모 변화 없음 |

실패 시: 앱은 0.2.4 그대로 남는다. 진단 로그(`%APPDATA%\com.plana.memo.staging\logs`)의 `updater … failed: <코드>` 로 원인을 본다
(`update_signature` = 키 불일치, `update_manifest` = latest.json 형식·서버 설정, `update_network` = 서버 접속 불가, `update_channel_mismatch` = 다른 채널 파일, `update_download` = 파일 주소). 설치 프로그램이 뜬 뒤의 실패는 설치 프로그램 화면에 표시되고 기존 버전이 남는다.

**Production 은 따로** — production 키(다른 키쌍)·`production.pub`·`<BASE>/production/` 로 같은 과정을 한 번 거친다. 운영 0.2.2 설치본도
업데이트 설정이 없으므로 전환 설치본을 한 번 직접 설치해야 한다. staging 파일·키는 운영 앱에서 쓰이지 않는다(§1 3중 장치).

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
