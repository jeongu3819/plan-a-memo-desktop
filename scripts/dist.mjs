// PLAN-A Memo 배포 빌드 — 환경(staging · production)을 반드시 정하고, 서버 주소·업데이트 채널·앱 식별자를 한 번에 맞춘다.
//
//   npm run dist:staging       (= node scripts/dist.mjs staging)
//   npm run dist:production    (= node scripts/dist.mjs production)
//
// 하는 일
//   1. 버전 일치 확인(package.json · src-tauri/Cargo.toml · src-tauri/tauri.conf.json)
//   2. 환경 값: PLANA_ENV 설정, staging 은 tauri.staging.conf.json 을 덮어 별도 앱(com.plana.memo.staging)으로
//   3. PLAN-A Work 서버 확인(production 은 주소를 못 찾거나 Desktop 연결 API 가 없으면 멈춘다 — --skip-server-check 로만 건너뜀)
//   4. 업데이트: src-tauri/updater/<채널>.pub(공개키) + PLANA_UPDATE_BASE_URL 이 있으면 앱에 업데이트 확인을 넣는다.
//      TAURI_SIGNING_PRIVATE_KEY(개인키 — 빌드 PC 환경 변수로만, 저장소에 두지 않는다)가 있으면 서명 파일(.sig)과
//      latest.json(릴리스 노트 release-notes/<버전>.md 포함)을 만든다.
//   5. 결과: release/<채널>/ — 설치 파일, (서명 시) 버전 폴더의 업데이트 파일·.sig·latest.json
//
// 이 스크립트는 아무것도 업로드하지 않는다(배포는 docs/release.md 절차대로 사람이 한다).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const channel = args.find(a => !a.startsWith('--')) ?? process.env.PLANA_ENV;

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}
const info = message => console.log(`• ${message}`);
const warn = message => console.warn(`⚠ ${message}`);

if (!channel) {
  fail('배포 환경을 정해주세요: npm run dist:staging  또는  npm run dist:production');
}
if (!['staging', 'production'].includes(channel)) {
  fail(`알 수 없는 환경 '${channel}' — staging 또는 production`);
}
if (process.env.PLAN_A_ENV && process.env.PLAN_A_ENV !== channel) {
  fail(`PLAN_A_ENV=${process.env.PLAN_A_ENV} 가 설정돼 있습니다. 이 이름은 쓰지 않습니다(PLANA_ENV). 환경 변수를 지우고 다시 실행해주세요.`);
}
if (process.env.PLANA_ENV && process.env.PLANA_ENV !== channel) {
  fail(`PLANA_ENV=${process.env.PLANA_ENV} 와 요청한 환경 ${channel} 이 다릅니다.`);
}

// ── 1. 버전 일치 ───────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const conf = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8'))?.[1];
const version = conf.version;
if (pkg.version !== version || cargoVersion !== version) {
  fail(`버전이 서로 다릅니다 — package.json ${pkg.version} · Cargo.toml ${cargoVersion} · tauri.conf.json ${version}. 세 곳을 같은 값으로 맞춰주세요.`);
}

// ── 2. 환경별 앱 정체성 ─────────────────────────────────────────────────
const overlays = [];
let productName = conf.productName;
let identifier = conf.identifier;
if (channel === 'staging') {
  const overlayPath = path.join('src-tauri', 'tauri.staging.conf.json');
  const overlay = JSON.parse(readFileSync(path.join(root, overlayPath), 'utf8'));
  overlays.push(overlayPath);
  productName = overlay.productName;
  identifier = overlay.identifier;
}
const defaultOrigin = { production: 'https://planawork.com', staging: 'https://staging.planawork.com' }[channel];
const origin = (process.env.PLANA_SERVER_ORIGIN || defaultOrigin).replace(/\/+$/, '');

// ── 3. 서버 확인 ───────────────────────────────────────────────────────
async function checkServer() {
  const host = new URL(origin).hostname;
  try {
    await lookup(host);
  } catch {
    return `서버 주소 ${host} 를 DNS 에서 찾을 수 없습니다(설치한 앱의 계정 연결이 'PLAN-A Work 서버를 찾을 수 없습니다' 로 실패합니다).`;
  }
  try {
    const res = await fetch(`${origin}/api/memo-sync/native/changes`, { headers: { Accept: 'application/json' }, redirect: 'manual' });
    const body = await res.text();
    if (res.status === 401) return null; // 경로 있음(인증 필요) — 정상
    if (res.status === 404 && body.includes('Memo sync unavailable')) {
      return `${origin} 에 memo-sync 는 배포됐지만 꺼져 있습니다(MEMO_SYNC_ENABLED).`;
    }
    if (res.status === 404) return `${origin} 에 memo-sync-v1 API 가 없습니다(HTTP 404 — Backend 미배포).`;
    return `${origin} 의 memo-sync 확인 응답이 예상과 다릅니다(HTTP ${res.status}).`;
  } catch (error) {
    return `${origin} 에 HTTPS 로 연결하지 못했습니다(${error.cause?.code || error.message}).`;
  }
}
if (flag('--skip-server-check')) {
  warn('서버 확인을 건너뜁니다(--skip-server-check).');
} else {
  const problem = await checkServer();
  if (problem && channel === 'production') {
    fail(`${problem}\n  운영 Installer 를 만들기 전에 서버를 준비하거나, 알고 있다면 --skip-server-check 로 건너뛰세요.`);
  } else if (problem) {
    warn(problem);
  } else {
    info(`서버 확인: ${origin} 의 memo-sync API 응답 정상(401 = 인증 필요)`);
  }
}

// ── 4. 업데이트 설정 ───────────────────────────────────────────────────
const env = { ...process.env, PLANA_ENV: channel };
delete env.PLAN_A_ENV;
const pubkeyFile = path.join(root, 'src-tauri', 'updater', `${channel}.pub`);
const baseUrl = (process.env.PLANA_UPDATE_BASE_URL || '').replace(/\/+$/, '');
let updatesEnabled = false;
if (existsSync(pubkeyFile) && baseUrl) {
  env.PLANA_UPDATER_PUBKEY = readFileSync(pubkeyFile, 'utf8').trim();
  env.PLANA_UPDATE_ENDPOINT = `${baseUrl}/${channel}/latest.json`;
  updatesEnabled = true;
  info(`업데이트 확인: ${env.PLANA_UPDATE_ENDPOINT}`);
} else {
  warn(
    `업데이트 확인 없이 빌드합니다(${!existsSync(pubkeyFile) ? `공개키 src-tauri/updater/${channel}.pub 없음` : ''}${
      !existsSync(pubkeyFile) && !baseUrl ? ' · ' : ''
    }${!baseUrl ? 'PLANA_UPDATE_BASE_URL 없음' : ''}). 설정 화면의 [업데이트 확인]은 '설정되지 않음' 으로 보입니다.`,
  );
}
const signing = !!process.env.TAURI_SIGNING_PRIVATE_KEY;
if (signing && !updatesEnabled) {
  fail('서명 개인키는 있는데 업데이트 엔드포인트·공개키가 없습니다 — 업데이트를 받을 수 없는 앱에 서명할 이유가 없습니다.');
}
if (updatesEnabled && !signing) {
  warn('TAURI_SIGNING_PRIVATE_KEY 가 없어 업데이트 파일(.sig)·latest.json 은 만들지 않습니다(설치 파일만).');
}
const notesFile = path.join(root, 'release-notes', `${version}.md`);
if (signing && !existsSync(notesFile)) {
  fail(`릴리스 노트가 없습니다: release-notes/${version}.md (업데이트 알림에 그대로 보입니다)`);
}

// ── 5. 빌드 ────────────────────────────────────────────────────────────
info(`환경 ${channel} · ${productName} (${identifier}) · v${version} · 서버 ${origin}`);
const tauriArgs = ['tauri', 'build'];
for (const overlay of overlays) tauriArgs.push('--config', overlay);
if (updatesEnabled) {
  // 공개키는 설정에도 넣는다 — 서명할 때 Tauri CLI 가 개인키와 짝이 맞는지 이 값으로 확인한다(앱은 같은 값을 Rust 에서도 받는다).
  const patch = { plugins: { updater: { pubkey: env.PLANA_UPDATER_PUBKEY } } };
  if (signing) patch.bundle = { createUpdaterArtifacts: true };
  const patchFile = path.join(root, 'src-tauri', 'target', `dist-${channel}.conf.json`);
  mkdirSync(path.dirname(patchFile), { recursive: true });
  writeFileSync(patchFile, JSON.stringify(patch));
  tauriArgs.push('--config', JSON.stringify(path.relative(root, patchFile)));
}
const result = spawnSync('npx', tauriArgs, { cwd: root, env, stdio: 'inherit', shell: true });
if (result.status !== 0) fail('tauri build 실패');

// ── 6. 결과 정리 ───────────────────────────────────────────────────────
const nsisDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const setupName = `${productName}_${version}_x64-setup.exe`;
const setupPath = path.join(nsisDir, setupName);
if (!existsSync(setupPath)) fail(`설치 파일을 찾지 못했습니다: ${setupPath}`);
const outDir = path.join(root, 'release', channel);
mkdirSync(outDir, { recursive: true });
const friendly = channel === 'production' ? 'PLAN-A-Memo-Setup.exe' : 'PLAN-A-Memo-Staging-Setup.exe';
copyFileSync(setupPath, path.join(outDir, friendly));
if (channel === 'production') copyFileSync(setupPath, path.join(root, 'release', 'PLAN-A-Memo-Setup.exe')); // 예전 위치 호환
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
info(`설치 파일: release/${channel}/${friendly} (sha256 ${sha256(setupPath).slice(0, 16)}…)`);

if (signing) {
  const sigPath = `${setupPath}.sig`;
  if (!existsSync(sigPath)) fail(`서명 파일이 없습니다: ${sigPath}`);
  const uploadName = setupName.replace(/\s+/g, '-');
  const versionDir = path.join(outDir, version);
  mkdirSync(versionDir, { recursive: true });
  copyFileSync(setupPath, path.join(versionDir, uploadName));
  copyFileSync(sigPath, path.join(versionDir, `${uploadName}.sig`));
  const manifest = {
    version,
    channel,
    notes: readFileSync(notesFile, 'utf8').trim(),
    pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    platforms: {
      'windows-x86_64': {
        signature: readFileSync(sigPath, 'utf8').trim(),
        url: `${baseUrl}/${channel}/${version}/${encodeURIComponent(uploadName)}`,
      },
    },
  };
  writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  info(`업데이트: release/${channel}/${version}/${uploadName} (+ .sig) · release/${channel}/latest.json`);
  info(`올릴 곳: ${baseUrl}/${channel}/${version}/ 에 두 파일, 그다음 ${baseUrl}/${channel}/latest.json (순서 지킬 것 — docs/release.md)`);
}

const stale = readdirSync(nsisDir).filter(n => n.endsWith('-setup.exe') && n !== setupName);
if (stale.length) info(`(참고) bundle 폴더의 예전 설치 파일: ${stale.map(n => `${n} ${statSync(path.join(nsisDir, n)).mtime.toISOString().slice(0, 10)}`).join(', ')}`);
console.log('\n✔ 완료 — 업로드는 하지 않았습니다.\n');
