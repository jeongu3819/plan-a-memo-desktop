// node e2e/staging/drive.mjs start | init | status | inv <command> [json]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { connect, redact, sleep, CONFIG, STORE, PORT, ORIGIN, EXE } from './lib.mjs';

const [, , cmd, a1, a2] = process.argv;
if (cmd === 'start') {
  mkdirSync(CONFIG, { recursive: true });
  const env = { ...process.env, PLANA_CONFIG_DIR: CONFIG, PLANA_SERVER_ORIGIN: ORIGIN, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` };
  for (const k of ['PLANA_UPDATE_ENDPOINT', 'PLANA_UPDATER_PUBKEY', 'TAURI_SIGNING_PRIVATE_KEY']) delete env[k];
  const p = spawn(EXE, [], { env, stdio: 'ignore', detached: true });
  p.unref();
  console.log('pid', p.pid);
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break;
    } catch {
      // 아직 뜨는 중
    }
    await sleep(500);
  }
  const { browser, page } = await connect({ guard: false });
  await page.waitForFunction(() => '__TAURI_INTERNALS__' in window, null, { timeout: 30000 });
  await browser.close();
  console.log('ready');
} else if (cmd === 'init') {
  // 이미 그려진 첫 실행 화면은 이 호출을 모른다 — 끝나면 시험 앱을 끝내고 start 를 다시 한다
  const { browser, invoke } = await connect();
  console.log(redact(await invoke('storage_initialize', { path: STORE, createNew: true })));
  await browser.close();
} else if (cmd === 'status') {
  const { browser, invoke } = await connect();
  const info = await invoke('app_info');
  const auth = await invoke('auth_status');
  const ov = await invoke('sync_overview');
  console.log(redact({ version: info.version, env: info.env, transport: info.syncTransport, real: info.realSyncConfigured, storage: info.storage.path, webOrigin: auth.webOrigin, provider: auth.provider, loggedIn: auth.loggedIn, loginPending: auth.loginPending, isMock: auth.session?.isMock ?? null, linked: ov.linkedDocuments, outbox: ov.outbox }));
  await browser.close();
} else if (cmd === 'inv') {
  const { browser, invoke } = await connect();
  console.log(redact(await invoke(a1, a2 ? JSON.parse(a2) : {})));
  await browser.close();
} else {
  console.error('사용법: drive.mjs start | init | status | inv <command> [json]');
  process.exitCode = 1;
}
