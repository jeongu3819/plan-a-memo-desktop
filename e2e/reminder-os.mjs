// 날짜 알림 OS 검증 — 실제 NSIS Installer 로 설치한 **별도 테스트 앱**에서 작업 스케줄러 · Windows 알림(Toast)을 확인한다.
//
//   node e2e/reminder-os.mjs             (테스트용 Installer 를 release 로 빌드 — 수 분)
//   node e2e/reminder-os.mjs --no-build  (이미 빌드한 Installer 재사용)
//   node e2e/reminder-os.mjs --skip-missed  (놓친 알림 시나리오(약 17분 대기) 건너뜀)
//
// * 사용자의 설치본(PLAN-A Memo · Staging)·메모와 섞이지 않게 이름 'PLAN-A Memo RemindTest', 식별자 com.plana.memo.remindtest,
//   development 환경(Mock 서버)으로 빌드한다. 창 열기 scheme 은 development 와 같은 plana-memo-dev.
// * 시나리오
//   A. 앱 완전 종료 상태 — 작업 스케줄러가 창 없이 실행 → Windows 알림(내용·누르면 열 주소) · DB delivered · 앱 프로세스 없음
//   B. 알림 클릭(=protocol 실행)으로 꺼진 앱이 열림 → 그 날짜 상세
//   C. 앱 실행 중 + 최소화 상태 — 같은 알림이 한 번만(작업이 처리, 앱은 겹쳐 띄우지 않음)
//   D. Windows 알림 끔(이 앱) → 앱이 상태를 읽어 안내
//   E. 놓친 알림(PC 꺼짐 흉내: 작업 비활성 + 앱 종료 상태로 15분 넘게 지남) → 앱을 다시 열 때 한 번 안내, 다시 열면 없음, Toast 를 몰아서 띄우지 않음
//   F. 제거 → 작업 스케줄러 작업도 삭제
// * 화면 전체를 캡처하지 않는다(다른 창이 함께 찍힌다) — 알림은 Windows 알림 기록(ToastNotificationHistory)으로 확인한다.
// * 끝나면 테스트 앱을 제거하고 앱 설정·저장소·알림 기록·레지스트리를 정리한다.

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'PLAN-A Memo RemindTest';
const ID = 'com.plana.memo.remindtest';
const SCHEME = 'plana-memo-dev';
const TASK = `PLAN-A Memo Reminders (${ID})`;
const CDP_PORT = 9335;
const LOCAL = process.env.LOCALAPPDATA;
const ROAMING = process.env.APPDATA;
const INSTALL_DIR = path.join(LOCAL, NAME);
const EXE = path.join(INSTALL_DIR, `${NAME}.exe`);
const work = mkdtempSync(path.join(tmpdir(), 'plana-remind-'));
const store = path.join(work, 'store');
const out = path.join(repo, 'e2e', 'output', 'reminder-os');
mkdirSync(out, { recursive: true });
const args = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const evidence = [];
const log = m => console.log(`  ${m}`);
const note = (k, v) => {
  evidence.push({ k, v });
  log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
};

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✔ ${name} (${Math.round((Date.now() - started) / 1000)}s)`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message || error) });
    console.log(`✖ ${name}\n    ${String(error?.stack || error).split('\n').slice(0, 5).join('\n    ')}`);
  }
}

function ps(script) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`], {
    encoding: 'utf8',
  });
  return (r.stdout || '').trim();
}

const plusDays = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const pad = n => String(n).padStart(2, '0');
/** 지금부터 `minutes` 분 뒤의 정각 분(로컬) — [Date, 'HH:MM'] */
function minuteAhead(minutes) {
  const t = new Date(Date.now() + minutes * 60_000);
  t.setSeconds(0, 0);
  return [t, `${pad(t.getHours())}:${pad(t.getMinutes())}`];
}
async function waitUntil(date, extraMs = 0) {
  const ms = date.getTime() + extraMs - Date.now();
  if (ms > 0) {
    log(`… ${Math.round(ms / 1000)}초 대기 (${date.toLocaleTimeString()} + ${extraMs / 1000}s)`);
    await sleep(ms);
  }
}
async function waitFor(fn, message, timeout = 30000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await sleep(500);
  }
  throw new Error(`시간 초과: ${message}`);
}

// ── Windows 확인 도구 ─────────────────────────────────────────────────────

const WINRT = '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;';
function toastHistory() {
  const raw = ps(
    `${WINRT} $h = [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('${ID}'); ` +
      `@($h | ForEach-Object { [pscustomobject]@{ tag = $_.Tag; group = $_.Group; xml = $_.Content.GetXml() } }) | ConvertTo-Json -Compress -Depth 3`,
  );
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}
const clearToasts = () => ps(`${WINRT} [Windows.UI.Notifications.ToastNotificationManager]::History.Clear('${ID}')`);
function taskInfo() {
  const raw = ps(
    `$i = Get-ScheduledTaskInfo -TaskName '${TASK}' -ErrorAction SilentlyContinue; if ($i) { [pscustomobject]@{ last = $i.LastRunTime.ToString('s'); result = $i.LastTaskResult; next = $i.NextRunTime.ToString('s') } | ConvertTo-Json -Compress }`,
  );
  return raw ? JSON.parse(raw) : null;
}
const taskExists = () => spawnSync('schtasks', ['/Query', '/TN', TASK], { stdio: 'ignore' }).status === 0;
// 표 형식은 이미지 이름을 25자로 자른다('PLAN-A Memo RemindTest.exe' 는 26자) — CSV 로 센다.
const running = () =>
  execFileSync('tasklist', ['/FI', `IMAGENAME eq ${NAME}.exe`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    .split('\n')
    .filter(l => l.includes(`"${NAME}.exe"`)).length;
const reminderLog = () => {
  const f = path.join(LOCAL, ID, 'logs', 'reminder.log');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split(/\r?\n/) : [];
};
const notifKey = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${ID}`;

// ── 앱 조작(CDP) ─────────────────────────────────────────────────────────

let browser;
let page;
async function connect() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) break;
    } catch {
      /* 아직 */
    }
    await sleep(500);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts()[0]?.pages()[0];
    if (!page) await sleep(250);
  }
  await page.waitForFunction(() => '__TAURI_INTERNALS__' in window, null, { timeout: 30000 });
}
const cdpEnv = () => ({ ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` });
async function launch() {
  spawn(EXE, [], { env: cdpEnv(), stdio: 'ignore', detached: true }).unref();
  await connect();
}
/** 알림을 누른 것과 같은 실행 — Windows 가 protocol 주소로 앱을 연다. */
async function launchUri(uri) {
  spawnSync('cmd', ['/c', 'start', '', uri], { env: cdpEnv(), stdio: 'ignore' });
  await connect();
}
async function close() {
  try {
    await browser?.close();
  } catch {
    /* 끊김 */
  }
  browser = undefined;
  page = undefined;
  spawnSync('taskkill', ['/IM', `${NAME}.exe`, '/F', '/T'], { stdio: 'ignore' });
  await waitFor(async () => running() === 0, '앱 종료', 15000);
}
const invoke = (c, a = {}) => page.evaluate(([cmd, arg]) => window.__TAURI_INTERNALS__.invoke(cmd, arg), [c, a]);
const addItem = (date, section, html) =>
  invoke('item_create', { input: { id: crypto.randomUUID(), location: { kind: 'day', date }, section, kind: 'checklist', contentHtml: html } });

// ── 빌드 · 설치 · 정리 ─────────────────────────────────────────────────────

function build() {
  const overlay = {
    productName: NAME,
    mainBinaryName: NAME,
    identifier: ID,
    plugins: { 'deep-link': { desktop: { schemes: [SCHEME] } } },
  };
  const file = path.join(work, 'overlay.json');
  writeFileSync(file, JSON.stringify(overlay));
  const env = { ...process.env, PLANA_ENV: 'development' };
  delete env.PLAN_A_ENV;
  delete env.PLANA_UPDATE_ENDPOINT;
  const r = spawnSync('npx', ['tauri', 'build', '--config', `"${file}"`], { cwd: repo, env, shell: true, stdio: 'inherit' });
  assert.equal(r.status, 0, 'tauri build');
  const version = JSON.parse(readFileSync(path.join(repo, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
  const setup = path.join(repo, 'src-tauri', 'target', 'release', 'bundle', 'nsis', `${NAME}_${version}_x64-setup.exe`);
  assert.ok(existsSync(setup), setup);
  const dest = path.join(out, 'RemindTest-setup.exe');
  copyFileSync(setup, dest);
  return dest;
}

function uninstall() {
  const u = path.join(INSTALL_DIR, 'uninstall.exe');
  if (existsSync(u)) spawnSync(u, ['/S'], { stdio: 'ignore' });
}

function cleanupAll() {
  spawnSync('taskkill', ['/IM', `${NAME}.exe`, '/F', '/T'], { stdio: 'ignore' });
  uninstall();
  spawnSync('schtasks', ['/Delete', '/TN', TASK, '/F'], { stdio: 'ignore' });
  clearToasts();
  ps(`Remove-Item -LiteralPath '${notifKey}' -Recurse -ErrorAction SilentlyContinue`);
  spawnSync('reg', ['delete', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${NAME}`, '/f'], { stdio: 'ignore' });
  spawnSync('reg', ['delete', `HKCU\\Software\\PLAN-A\\${NAME}`, '/f'], { stdio: 'ignore' });
  for (const dir of [path.join(ROAMING, ID), path.join(LOCAL, ID)]) rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

// ── 실행 ────────────────────────────────────────────────────────────────

let today = '';
let T = '';
try {
  let setup = path.join(out, 'RemindTest-setup.exe');
  if (!args.includes('--no-build')) setup = build();
  assert.ok(existsSync(setup), '--no-build: 이전에 빌드한 Installer 가 없습니다');
  cleanupAll();
  mkdirSync(store, { recursive: true });

  await step('install', async () => {
    const r = spawnSync(setup, ['/S'], { stdio: 'ignore' });
    assert.equal(r.status, 0, 'setup /S');
    await waitFor(async () => existsSync(EXE), '설치된 실행 파일', 60000);
    // 조용한 설치 직후에는 시작 메뉴 목록에 늦게 나타난다(Windows 색인).
    const aumid = await waitFor(async () => ps(`(Get-StartApps | Where-Object AppID -eq '${ID}').AppID`) === ID, '시작 메뉴 바로가기에 AppUserModelID 등록(알림 주인)', 90000);
    assert.ok(aumid);
    note('installed', EXE);
  });

  await step('first-run + reminders', async () => {
    await launch();
    const ready = await invoke('storage_initialize', { path: store, createNew: true });
    assert.equal(ready.state, 'ready');
    today = (await invoke('app_info')).today;
    T = plusDays(today, 2);
    await addItem(T, 'main', '월말 자료 정리');
    await addItem(T, 'pm', '다음 달 계획 검토');
    const done = await addItem(T, 'am', '이미 한 일');
    await invoke('item_set_completed', { id: done.id, completed: true });
    // 먼 미래 알림 하나 — 작업이 남아 있어 실행 기록(LastRunTime)을 읽을 수 있게
    await addItem(plusDays(today, 40), 'main', '먼 미래');
    await invoke('reminder_set', { date: plusDays(today, 40), offsets: [7], time: '09:00' });
    const status = await invoke('reminder_status');
    note('notifications', status.notifications);
    assert.equal(status.notifications, 'enabled', 'Windows 알림 켜짐(설치본은 AppUserModelID 로 확인)');
  });

  await step('A. 앱 완전 종료 상태에서 알림', async () => {
    clearToasts();
    const [at, hhmm] = minuteAhead(2);
    const saved = await invoke('reminder_set', { date: T, offsets: [2], time: hhmm });
    assert.equal(saved.status.task?.error ?? null, null, `작업 등록: ${saved.status.task?.error}`);
    assert.ok(saved.status.task.triggers.includes(`${today}T${hhmm}`), '예약 시각 등록');
    assert.ok(taskExists(), '작업 스케줄러 작업');
    await close();
    assert.equal(running(), 0, '앱 프로세스 없음(완전 종료)');
    await waitUntil(at, 40000);
    const toasts = toastHistory();
    note('toasts', toasts.map(t => ({ tag: t.tag, xml: t.xml.slice(0, 400) })));
    const mine = toasts.find(t => t.tag === T);
    assert.ok(mine, 'Windows 알림이 알림 센터에 있다');
    assert.match(mine.xml, /요일에 할 일이 있어요/);
    assert.match(mine.xml, /완료하지 않은 체크리스트 2개/, '알릴 때 센 미완료 수(완료 1개 제외)');
    assert.ok(mine.xml.includes(`launch="${SCHEME}://open?date=${T}"`), '누르면 그 날짜 상세');
    const info = taskInfo();
    note('task', info);
    assert.equal(info.result, 0, '작업 실행 결과 0');
    assert.equal(running(), 0, '알림 처리 프로세스는 창 없이 끝났다');
    note('reminder.log', reminderLog().slice(-3));
    assert.ok(reminderLog().some(l => l.includes(`${T}:2`)), 'reminder.log 기록');
  });

  await step('B. 알림 클릭 → 꺼진 앱이 그 날짜 상세로 열림', async () => {
    await launchUri(`${SCHEME}://open?date=${T}`);
    await page.waitForSelector('[data-testid="upcoming-weekday"]', { timeout: 30000 });
    const [, m, d] = T.split('-').map(Number);
    const label = await page.locator('[data-testid="personal-memo-view-label"]').innerText();
    assert.ok(label.includes(`${m}/${d}`), `날짜 상세 ${label}`);
    const r = await invoke('reminder_get', { date: T });
    assert.equal(r.fires[0].status, 'delivered');
    await page.screenshot({ path: path.join(out, 'B-opened-from-toast.png') });
  });

  await step('C. 앱 실행 중 + 최소화 상태에서 한 번만', async () => {
    clearToasts();
    const D7 = plusDays(today, 7);
    await addItem(D7, 'main', '정기 점검');
    const [at, hhmm] = minuteAhead(2);
    await invoke('reminder_set', { date: D7, offsets: [7], time: hhmm });
    await invoke('plugin:window|minimize', { label: 'main' });
    await waitUntil(at, 3 * 60_000); // 앱의 대신 처리(2분 유예)까지 지나도 겹쳐 띄우지 않는다
    const toasts = toastHistory().filter(t => t.tag === D7);
    assert.equal(toasts.length, 1, '같은 알림은 하나');
    // 같은 태그는 서로 덮으므로 기록 개수만으로는 중복을 알 수 없다 — 처리(선점) 기록도 한 번인지 본다.
    note('reminder.log', reminderLog().slice(-3));
    assert.equal(reminderLog().filter(l => l.includes(`${D7}:1`)).length, 1, '작업 스케줄러가 한 번 처리(앱이 겹쳐 처리하지 않음)');
    assert.match(toasts[0].xml, /완료하지 않은 체크리스트 1개/);
    const r = await invoke('reminder_get', { date: D7 });
    assert.equal(r.fires[0].status, 'delivered');
    assert.equal(running() >= 1, true, '앱은 계속 실행 중');
    assert.ok(await invoke('app_info'), '앱 응답');
  });

  await step('D. Windows 알림 꺼짐 안내', async () => {
    ps(`New-Item -Path '${notifKey}' -Force | Out-Null; New-ItemProperty -Path '${notifKey}' -Name Enabled -Value 0 -PropertyType DWord -Force | Out-Null`);
    const status = await invoke('reminder_status');
    note('notifications(off)', status.notifications);
    assert.equal(status.notifications, 'disabled_app');
    ps(`Remove-ItemProperty -Path '${notifKey}' -Name Enabled -ErrorAction SilentlyContinue`);
    assert.equal((await invoke('reminder_status')).notifications, 'enabled', '다시 켜짐');
  });

  if (!args.includes('--skip-missed')) {
    await step('E. 놓친 알림(PC 꺼짐 흉내) → 다시 열 때 한 번', async () => {
      clearToasts();
      const [at, hhmm] = minuteAhead(2);
      await invoke('reminder_set', { date: T, offsets: [2], time: hhmm });
      await close();
      spawnSync('schtasks', ['/Change', '/TN', TASK, '/DISABLE'], { stdio: 'ignore' });
      await waitUntil(at, 16 * 60_000);
      assert.equal(toastHistory().filter(t => t.tag === T).length, 0, '꺼져 있던 동안 알림 없음');
      await launch();
      await page.waitForSelector('[data-testid="missed-reminders"]', { timeout: 30000 });
      const text = await page.locator('[data-testid="missed-reminders"]').innerText();
      note('missed banner', text);
      assert.match(text, /완료하지 않은 체크리스트 2개/);
      await page.screenshot({ path: path.join(out, 'E-missed-banner.png') });
      const r = await invoke('reminder_get', { date: T });
      assert.equal(r.fires[0].status, 'missed');
      assert.equal(toastHistory().filter(t => t.tag === T || t.tag === 'summary').length, 0, '놓친 알림을 Toast 로 몰아서 띄우지 않는다');
      assert.ok(taskExists(), '앱을 열면 작업을 다시 등록(활성)');
      await close();
      await launch();
      await sleep(5000);
      assert.equal(await page.locator('[data-testid="missed-reminders"]').count(), 0, '다시 열면 안내하지 않는다(한 번만)');
    });
  }

  await step('F. 제거 → 알림 작업 삭제', async () => {
    await close();
    assert.ok(taskExists(), '제거 전에는 작업이 있다');
    uninstall();
    await waitFor(async () => !existsSync(EXE), '제거', 60000);
    await waitFor(async () => !taskExists(), '작업 스케줄러 작업 삭제', 30000);
  });
} finally {
  writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ results, evidence }, null, 2));
  cleanupAll();
}
const failed = results.filter(r => !r.ok);
console.log(failed.length ? `\n실패 ${failed.length}: ${failed.map(f => f.name).join(', ')}` : '\n날짜 알림 OS 검증 통과');
process.exit(failed.length ? 1 : 0);
