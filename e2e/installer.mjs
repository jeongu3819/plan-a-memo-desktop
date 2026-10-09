// PLAN-A Memo 설치·업데이트·제거 E2E — 실제 NSIS Installer 와 Tauri Updater 를 이 PC 에서 돌린다.
//
//   node e2e/installer.mjs            (테스트용 Installer 2개 빌드 포함 — 10분 이상)
//   node e2e/installer.mjs --no-build (이미 빌드한 테스트 Installer 재사용)
//
// * 사용자의 실제 설치본(PLAN-A Memo)·메모와 섞이지 않게 **별도 앱**으로 빌드한다:
//   이름 'PLAN-A Memo InstTest', 식별자 com.plana.memo.insttest, 버전 9.0.0 → 9.0.1, development 빌드(Mock 서버).
// * 업데이트 서명키는 이번 실행에서 임시로 만들고 끝나면 지운다(저장소·운영 키와 무관).
// * 업데이트 서버는 127.0.0.1 의 작은 HTTP 서버(development 빌드에서만 http 허용).
// * 끝나면 테스트 앱을 제거하고 레지스트리·앱 데이터·임시 폴더를 정리한다.

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'PLAN-A Memo InstTest';
const ID = 'com.plana.memo.insttest';
const V1 = '9.0.0';
const V2 = '9.0.1';
const UPDATE_PORT = 8765;
const CDP_PORT = 9334;
const LOCAL = process.env.LOCALAPPDATA;
const ROAMING = process.env.APPDATA;
const DEFAULT_DIR = path.join(LOCAL, NAME);
const UNINST_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${NAME}`;
const bundleDir = path.join(repo, 'src-tauri', 'target', 'debug', 'bundle', 'nsis');
const work = mkdtempSync(path.join(tmpdir(), 'plana-inst-'));
const artifacts = path.join(repo, 'e2e', 'output', 'installer');
mkdirSync(artifacts, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const exeName = `${NAME}.exe`;

function log(message) {
  console.log(`  ${message}`);
}

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✔ ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`✖ ${name}\n    ${String(error?.stack || error).split('\n').slice(0, 4).join('\n    ')}`);
  }
}

/** 레지스트리 값 — reg.exe 출력은 시스템 코드 페이지(CP949)라 한글 경로가 깨진다. PowerShell 로 UTF-8 로 읽는다. */
function reg(key, value) {
  const psKey = key.replace(/^HKCU\\/, 'HKCU:\\');
  const script = value
    ? `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $v=(Get-ItemProperty -LiteralPath '${psKey}' -ErrorAction SilentlyContinue).'${value}'; if ($null -ne $v) { Write-Output $v }`
    : `if (Test-Path -LiteralPath '${psKey}') { Write-Output 'present' }`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  return out ? out : null;
}

function fileVersion(file) {
  return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${file.replace(/'/g, "''")}').VersionInfo.FileVersion`], {
    encoding: 'utf8',
  }).trim();
}

function killApp() {
  spawnSync('taskkill', ['/IM', exeName, '/F', '/T'], { stdio: 'ignore' });
}

async function waitFor(fn, message, timeout = 60000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await sleep(500);
  }
  throw new Error(`시간 초과: ${message}`);
}

function runInstaller(setup, args) {
  const r = spawnSync(setup, args, { stdio: 'ignore', windowsVerbatimArguments: true });
  return r.status;
}

/** uninstall.exe 는 자신을 임시 폴더에 복사해 실행하고 바로 끝난다 — 결과(레지스트리·파일)를 기다린다. */
async function uninstall(dir, { expectRemoved = true } = {}) {
  const u = path.join(dir, 'uninstall.exe');
  spawnSync(u, ['/S'], { stdio: 'ignore' });
  if (expectRemoved) {
    await waitFor(() => !reg(UNINST_KEY) && !existsSync(path.join(dir, exeName)), '제거 완료', 60000);
  } else {
    await sleep(12000);
  }
}

// ── 앱 조작(CDP) ───────────────────────────────────────────────────────
class InstalledApp {
  constructor(exe) {
    this.exe = exe;
  }
  async start() {
    this.proc = spawn(this.exe, [], {
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
      stdio: 'ignore',
      detached: false,
    });
    this.proc.on('error', error => console.log(`    앱 실행 실패: ${error.message}`));
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok;
      } catch {
        return false;
      }
    }, 'WebView 디버깅 포트', 60000);
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    this.page = await waitFor(() => this.browser.contexts()[0]?.pages()[0], 'WebView 페이지', 20000);
    await this.page.waitForFunction(() => '__TAURI_INTERNALS__' in window, null, { timeout: 30000 });
    return this;
  }
  invoke(command, args = {}) {
    return this.page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
  }
  invokeError(command, args = {}) {
    return this.page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a).then(() => null, e => e), [command, args]);
  }
  async close() {
    try {
      await this.browser?.close();
    } catch {
      /* 이미 닫힘 */
    }
    killApp();
    await sleep(1500);
  }
}

// ── 업데이트 서버(127.0.0.1) ───────────────────────────────────────────
let manifest = null;
const served = new Map();
const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/latest.json') {
    if (!manifest) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(manifest));
    return;
  }
  const file = served.get(url);
  if (!file) {
    res.writeHead(404).end('not found');
    return;
  }
  const bytes = readFileSync(file);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length }).end(bytes);
});

// ── 빌드 ────────────────────────────────────────────────────────────────
const keyDir = path.join(work, 'keys');
mkdirSync(keyDir, { recursive: true });
function genKey(name) {
  const file = path.join(keyDir, `${name}.key`);
  const r = spawnSync('npx', ['tauri', 'signer', 'generate', '--ci', '-p', '""', '-w', `"${file}"`, '-f'], { cwd: repo, shell: true, stdio: 'ignore' });
  assert.equal(r.status, 0, 'signer generate');
  return { key: readFileSync(file, 'utf8').trim(), pub: readFileSync(`${file}.pub`, 'utf8').trim(), file };
}

function buildInstaller(version, keys) {
  const overlay = {
    version,
    productName: NAME,
    mainBinaryName: NAME,
    identifier: ID,
    bundle: { createUpdaterArtifacts: true },
    plugins: { 'deep-link': { desktop: { schemes: ['plana-memo-insttest'] } }, updater: { pubkey: keys.pub } },
  };
  const overlayFile = path.join(work, `overlay-${version}.json`);
  writeFileSync(overlayFile, JSON.stringify(overlay));
  const env = {
    ...process.env,
    PLANA_ENV: 'development',
    PLANA_UPDATE_ENDPOINT: `http://127.0.0.1:${UPDATE_PORT}/latest.json`,
    PLANA_UPDATER_PUBKEY: keys.pub,
    TAURI_SIGNING_PRIVATE_KEY: keys.key,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
  };
  delete env.PLAN_A_ENV;
  const r = spawnSync('npx', ['tauri', 'build', '--debug', '--config', `"${overlayFile}"`], { cwd: repo, env, shell: true, stdio: 'inherit' });
  assert.equal(r.status, 0, `tauri build ${version}`);
  const setup = path.join(bundleDir, `${NAME}_${version}_x64-setup.exe`);
  assert.ok(existsSync(setup) && existsSync(`${setup}.sig`), `설치 파일·서명 ${version}`);
  const dest = path.join(artifacts, path.basename(setup));
  copyFileSync(setup, dest);
  copyFileSync(`${setup}.sig`, `${dest}.sig`);
  return dest;
}

function cleanupAll() {
  killApp();
  for (const dir of [DEFAULT_DIR, path.join(work, 'custom', NAME)]) {
    if (existsSync(path.join(dir, 'uninstall.exe'))) spawnSync(path.join(dir, 'uninstall.exe'), ['/S'], { stdio: 'ignore' });
  }
  spawnSync('reg', ['delete', UNINST_KEY, '/f'], { stdio: 'ignore' });
  spawnSync('reg', ['delete', `HKCU\\Software\\PLAN-A\\${NAME}`, '/f'], { stdio: 'ignore' });
  spawnSync('reg', ['delete', 'HKCU\\Software\\Classes\\plana-memo-insttest', '/f'], { stdio: 'ignore' });
  for (const dir of [path.join(ROAMING, ID), path.join(LOCAL, ID)]) rmSync(dir, { recursive: true, force: true });
}

// ── 시나리오 ───────────────────────────────────────────────────────────
const noBuild = process.argv.includes('--no-build');
let keys;
let setupA;
let setupB;
const storeDir = path.join(work, 'store');
const today = new Date().toISOString().slice(0, 10);
let app;

try {
  cleanupAll();
  await new Promise(r => server.listen(UPDATE_PORT, '127.0.0.1', r));

  await step('테스트 Installer 빌드(9.0.0 · 9.0.1, 임시 서명키)', async () => {
    // 실패하면 이후 단계는 의미가 없다 — 아래 fatal 검사로 멈춘다.
    const keyCache = path.join(artifacts, 'keys.json');
    if (noBuild && existsSync(keyCache)) {
      keys = JSON.parse(readFileSync(keyCache, 'utf8'));
      setupA = path.join(artifacts, `${NAME}_${V1}_x64-setup.exe`);
      setupB = path.join(artifacts, `${NAME}_${V2}_x64-setup.exe`);
      assert.ok(existsSync(setupA) && existsSync(setupB), '--no-build: 이전에 빌드한 Installer 가 없습니다');
      return;
    }
    keys = genKey('test');
    setupA = buildInstaller(V1, keys);
    setupB = buildInstaller(V2, keys);
    // 테스트 키는 테스트 앱 전용이다(운영과 무관) — --no-build 재실행을 위해 e2e/output 에만 둔다(저장소 밖, .gitignore).
    writeFileSync(keyCache, JSON.stringify({ pub: keys.pub, key: keys.key }));
  });
  if (!results.at(-1).ok) throw new Error('테스트 Installer 를 만들지 못해 중단합니다.');
  const other = genKey('other'); // 다른 키 — '서명 검증 실패' 재현용

  await step('권한 없는 폴더(C:\\plan_a_work) 설치 → 안내 후 중단, 파일·등록 정보 없음', async () => {
    const adminOnly = 'C:\\plan_a_work';
    if (!existsSync(adminOnly)) {
      log('C:\\plan_a_work 가 없어 이 PC 에서는 건너뜀');
      return;
    }
    const target = `${adminOnly}\\${NAME}`;
    const code = runInstaller(setupA, ['/S', '/NS', `/D=${target}`]);
    assert.notEqual(code, 0, '실패 코드로 끝나야 한다');
    assert.ok(!existsSync(path.join(target, exeName)), '실행 파일이 생기지 않는다');
    assert.equal(reg(UNINST_KEY), null, '제거 등록 정보가 생기지 않는다');
    log(`설치 프로그램 종료 코드 ${code}`);
  });

  await step('기본 위치 설치(관리자 권한 없이) — 사용자 폴더 · 등록 정보 일치', async () => {
    const code = runInstaller(setupA, ['/S', '/NS']);
    assert.equal(code, 0);
    assert.ok(existsSync(path.join(DEFAULT_DIR, exeName)));
    assert.equal(reg(UNINST_KEY, 'DisplayVersion'), V1);
    assert.equal(reg(UNINST_KEY, 'InstallLocation')?.replace(/"/g, ''), DEFAULT_DIR);
    assert.equal(fileVersion(path.join(DEFAULT_DIR, exeName)), V1);
  });

  await step('설치한 앱 실행 · 메모 작성(저장 위치는 설치 폴더 밖)', async () => {
    app = await new InstalledApp(path.join(DEFAULT_DIR, exeName)).start();
    const info = await app.invoke('app_info');
    assert.equal(info.version, V1, '설정의 현재 버전 = 실행 중인 앱 버전');
    await app.invoke('storage_initialize', { path: storeDir, createNew: true });
    for (const text of ['업데이트 전 메모 1', '업데이트 전 메모 2']) {
      await app.invoke('item_create', {
        input: { id: crypto.randomUUID(), location: { kind: 'day', date: today }, section: 'main', kind: 'checklist', contentHtml: text },
      });
    }
    // 설치 폴더 안은 저장 위치로 고를 수 없다
    const inside = await app.invoke('storage_inspect', { path: path.join(DEFAULT_DIR, 'memo') });
    assert.ok(inside.problem, '설치 폴더 안 거절');
    const appData = await app.invoke('storage_inspect', { path: path.join(ROAMING, ID, 'memo') });
    assert.ok(appData.problem, '앱 설정 폴더 안 거절');
    const status = await app.invoke('update_status');
    assert.equal(status.enabled, true);
    assert.equal(status.currentVersion, V1);
  });

  const sigB = () => readFileSync(`${setupB}.sig`, 'utf8').trim();
  const base = `http://127.0.0.1:${UPDATE_PORT}`;
  served.set('/v2.exe', setupB);
  const manifestFor = over => ({
    version: V2,
    channel: 'development',
    notes: '- 메모 UI 개선\n- 버그 수정\n- 안정성 향상',
    pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    platforms: { 'windows-x86_64': { signature: sigB(), url: `${base}/v2.exe` } },
    ...over,
  });
  const recheck = async () => {
    await sleep(5500); // 수동 확인 최소 간격
    return app.invoke('update_check');
  };

  await step('최신 버전 확인 → "최신 버전" (업데이트 정보 없음/같은 버전)', async () => {
    manifest = null; // 204
    assert.equal(await app.invoke('update_check'), null);
    manifest = manifestFor({ version: V1 });
    assert.equal(await recheck(), null);
  });

  await step('다른 채널의 업데이트 정보 → 설치 제안 안 함', async () => {
    manifest = manifestFor({ channel: 'production' });
    await sleep(5500);
    const error = await app.invokeError('update_check');
    assert.equal(error?.code, 'update_channel_mismatch');
  });

  await step('새 버전 발견 → 버전·릴리스 노트', async () => {
    manifest = manifestFor({});
    const found = await recheck();
    assert.equal(found.version, V2);
    assert.equal(found.currentVersion, V1);
    assert.match(found.notes, /메모 UI 개선/);
  });

  await step('다운로드 실패 → 안내, 지금 버전 유지', async () => {
    manifest = manifestFor({ platforms: { 'windows-x86_64': { signature: sigB(), url: `${base}/missing.exe` } } });
    await recheck();
    const error = await app.invokeError('update_install');
    assert.equal(error?.code, 'update_download');
    assert.equal((await app.invoke('app_info')).version, V1);
  });

  await step('서명 검증 실패(다른 키로 서명) → 설치 안 함', async () => {
    const forged = path.join(work, 'forged', path.basename(setupB));
    mkdirSync(path.dirname(forged), { recursive: true });
    copyFileSync(setupB, forged);
    const r = spawnSync('npx', ['tauri', 'signer', 'sign', '-f', `"${other.file}"`, '-p', '""', `"${forged}"`], { cwd: repo, shell: true, stdio: 'ignore' });
    assert.equal(r.status, 0, 'signer sign');
    served.set('/forged.exe', forged);
    manifest = manifestFor({ platforms: { 'windows-x86_64': { signature: readFileSync(`${forged}.sig`, 'utf8').trim(), url: `${base}/forged.exe` } } });
    await recheck();
    const error = await app.invokeError('update_install');
    assert.equal(error?.code, 'update_signature');
    assert.equal((await app.invoke('app_info')).version, V1, '앱이 그대로 실행 중이고 버전도 그대로');
  });

  await step('서명된 버전과 공지된 버전이 다름(바꿔치기) → 설치 안 함', async () => {
    manifest = manifestFor({ version: '9.0.5' }); // 9.0.1 로 서명된 파일을 9.0.5 라고 공지
    const found = await recheck();
    assert.equal(found.version, '9.0.5');
    const error = await app.invokeError('update_install');
    assert.equal(error?.code, 'update_signature');
  });

  await step('정상 업데이트 → 설치 전 Backup · 앱 종료 · 설치 · 다시 실행 · 버전 9.0.1', async () => {
    manifest = manifestFor({});
    await recheck();
    const pid = app.proc.pid;
    await app.invokeError('update_install').catch(() => null); // 성공하면 앱이 종료되어 연결이 끊긴다
    await waitFor(() => reg(UNINST_KEY, 'DisplayVersion') === V2, '등록 정보 9.0.1', 120000);
    await waitFor(() => fileVersion(path.join(DEFAULT_DIR, exeName)) === V2, '실행 파일 9.0.1', 60000);
    // 설치 프로그램이 앱을 다시 실행한다
    const relaunched = await waitFor(() => {
      const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      const pids = r.stdout.split(/\r?\n/).filter(l => l.includes(exeName)).map(l => Number(l.split('","')[1]));
      return pids.find(p => p !== pid);
    }, '업데이트 후 다시 실행', 60000);
    log(`다시 실행된 앱 pid ${relaunched}`);
    try {
      await app.browser.close();
    } catch {
      /* 끊김 */
    }
    killApp();
    await sleep(2000);
  });

  await step('업데이트 후 재실행 — 버전 9.0.1 · 메모·저장 위치 유지 · pre-update Backup', async () => {
    app = await new InstalledApp(path.join(DEFAULT_DIR, exeName)).start();
    const info = await app.invoke('app_info');
    assert.equal(info.version, V2);
    assert.equal(info.storage.state, 'ready');
    assert.equal(info.storage.path, storeDir);
    const day = await app.invoke('memo_day', { date: today });
    assert.deepEqual(day.items.map(i => i.contentHtml), ['업데이트 전 메모 1', '업데이트 전 메모 2']);
    const backups = await app.invoke('backup_list');
    assert.ok(backups.some(b => b.fileName.includes('pre-update')), 'pre-update Backup');
    await app.close();
  });

  await step('제거 → 실행 파일·uninstall.exe·등록 정보 삭제, 메모 데이터 보존', async () => {
    await uninstall(DEFAULT_DIR);
    assert.ok(!existsSync(path.join(DEFAULT_DIR, exeName)));
    assert.ok(!existsSync(path.join(DEFAULT_DIR, 'uninstall.exe')));
    const files = execFileSync('cmd', ['/c', 'dir', '/b', storeDir], { encoding: 'utf8' });
    log(`메모 폴더 유지: ${files.split(/\r?\n/).filter(Boolean).join(', ')}`);
    assert.ok(files.trim().length > 0);
  });

  const customDir = path.join(work, 'custom', NAME);
  await step('사용자 지정 폴더 설치(쓰기 가능) → 관리자 권한 없이 설치', async () => {
    mkdirSync(path.dirname(customDir), { recursive: true });
    const code = runInstaller(setupA, ['/S', '/NS', `/D=${customDir}`]);
    assert.equal(code, 0);
    assert.ok(existsSync(path.join(customDir, exeName)));
    assert.equal(reg(UNINST_KEY, 'InstallLocation')?.replace(/"/g, ''), customDir);
  });

  await step('기존 버전 위에 새 Installer 실행 → 같은 폴더에서 9.0.1 로 업데이트', async () => {
    const code = runInstaller(setupB, ['/S', '/NS']);
    assert.equal(code, 0);
    assert.equal(fileVersion(path.join(customDir, exeName)), V2, '이전 설치 위치를 그대로 쓴다');
    assert.equal(reg(UNINST_KEY, 'DisplayVersion'), V2);
    assert.ok(!existsSync(path.join(DEFAULT_DIR, exeName)), '기본 위치에 두 번째 설치가 생기지 않는다');
  });

  await step('지울 권한이 없는 설치 폴더 제거 → 중단(파일·등록 정보 그대로, 불일치 없음)', async () => {
    const user = execFileSync('whoami', { encoding: 'utf8' }).trim();
    const deny = spawnSync('icacls', [customDir, '/deny', `${user}:(OI)(CI)(DE,DC,WD,AD)`], { encoding: 'utf8' });
    assert.equal(deny.status, 0, `icacls deny: ${deny.stdout}${deny.stderr}`);
    try {
      await uninstall(customDir, { expectRemoved: false });
      assert.ok(existsSync(path.join(customDir, exeName)), '실행 파일 그대로');
      assert.ok(reg(UNINST_KEY), '등록 정보도 그대로(파일과 일치)');
    } finally {
      spawnSync('icacls', [customDir, '/remove:d', user], { stdio: 'ignore' });
    }
  });

  await step('권한이 돌아오면 정상 제거', async () => {
    await uninstall(customDir);
    assert.ok(!existsSync(path.join(customDir, exeName)));
    assert.equal(reg(UNINST_KEY), null);
  });
} finally {
  try {
    await app?.close();
  } catch {
    /* 무시 */
  }
  server.close();
  cleanupAll();
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과${failed.length ? ` — 실패: ${failed.map(f => f.name).join(' / ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
