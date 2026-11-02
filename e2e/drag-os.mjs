// 메모 끌어 놓기 — 실제 Windows 마우스 입력으로 반복 확인한다(CDP 입력은 렌더러로 바로 들어가 OS 입력 경로를 거치지 않는다).
//   node e2e/drag-os.mjs            (npm run e2e:build 뒤)
// **PC 의 실제 커서를 약 1~2분 쓴다.** 그동안 마우스를 움직이면 안전하게 멈추고 '외부 입력' 으로 보고한다(실패가 아니라 다시 실행).
// 격리: 임시 저장소·임시 설정(run.mjs 와 같음). 결과: e2e/output/drag-os-report.json · drag-os-*.png

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { App, clearE2eCredential, isolateWindowState, repoRoot } from './harness.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
class ExternalInput extends Error {}

function createRandom(seed) {
  let value = seed;
  return max => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value % max;
  };
}

function openMouse(pid) {
  const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'e2e', 'os-mouse.ps1'), '-AppPid', String(pid)], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: proc.stdout });
  const waiting = [];
  const early = [];
  lines.on('line', line => (waiting.length ? waiting.shift()(line) : early.push(line)));
  const next = () => new Promise(resolve => (early.length ? resolve(early.shift()) : waiting.push(resolve)));
  const send = async command => {
    proc.stdin.write(`${command}\n`);
    const reply = await next();
    if (reply.startsWith('ABORT')) throw new ExternalInput(`${command}: ${reply}`);
    if (reply.startsWith('ERROR')) throw new Error(`${command}: ${reply}`);
    return reply;
  };
  return { ready: next, send, close: () => proc.stdin.end() };
}

const app = new App();
const report = { drags: 0, cancelled: 0, noops: 0, scrolled: 0, wobbleChecks: 0, sizes: [], failures: [] };
clearE2eCredential();
const restoreWindowState = isolateWindowState();
let mouse = null;
let exit = 0;
try {
  await app.start();
  const page = app.page;
  await app.invoke('storage_initialize', { path: app.storeDir, createNew: true });
  await page.reload();
  await page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 30000 });
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const location = { kind: 'day', date: today };
  const names = {};
  const add = async (html, section = 'main') => {
    const item = await app.invoke('item_create', { input: { id: crypto.randomUUID(), location, section, kind: 'checklist', contentHtml: html } });
    names[item.id] = html.slice(0, 12);
    return item.id;
  };
  const model = [];
  for (let n = 0; n < 7; n++) model.push(await add(`메모 ${n}`));
  // 긴 메모(행 높이가 크다). 최소 창에서도 모두 자동 스크롤 구역 밖에 들어오는 길이.
  model.splice(4, 0, await add(Array.from({ length: 4 }, (_, n) => `긴 메모 ${n}번째 줄`).join('<br>')));
  await add('오후 메모', 'pm');
  await app.invoke('items_reorder', { location, section: 'main', ids: model });
  await page.reload();
  await page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 30000 });
  await page.click('[data-testid="memo-today"]');
  await page.waitForSelector('[data-testid="memo-section-main"] [data-testid="personal-memo-row"]');
  await page.evaluate(() => {
    window.__keys = [];
    window.addEventListener('keydown', e => window.__keys.push({ key: e.key, code: e.code, trusted: e.isTrusted }), true);
  });

  mouse = openMouse(app.proc.pid);
  await mouse.ready();
  await mouse.send('hold');
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const [, ox, oy] = (await mouse.send('origin')).split(' ').map(Number);
  const screen = (x, y) => `${Math.round(ox + x * dpr)} ${Math.round(oy + y * dpr)}`;
  const moveTo = async (x, y) => mouse.send(`move ${screen(x, y)}`);
  const glide = async (from, to, steps, delay = 12) => {
    for (let i = 1; i <= steps; i++) {
      await moveTo(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
      await sleep(delay);
    }
  };

  const main = page.locator('[data-testid="memo-section-main"]');
  const shown = () => main.locator('[data-drop-row]').evaluateAll(nodes => nodes.map(n => n.dataset.dropRow));
  const saved = async () => (await app.invoke('memo_day', { date: today })).items.filter(i => i.section === 'main').map(i => i.id);
  const line = page.locator('[data-testid="memo-drop-line"]');
  const boxes = () => main.locator('[data-drop-row]').evaluateAll(nodes => nodes.map(n => {
    const r = n.getBoundingClientRect();
    return { id: n.dataset.dropRow, top: r.top, bottom: r.bottom, left: r.left };
  }));
  const gapY = (rows, gap) => (gap === 0 ? rows[0].top - 1 : gap >= rows.length ? rows[rows.length - 1].bottom + 1 : (rows[gap - 1].bottom + rows[gap].top) / 2);
  const fail = (what, extra) => {
    report.failures.push({ what, ...extra });
    throw new Error(`${what} ${JSON.stringify(extra)}`);
  };
  const expectOrder = async what => {
    const onScreen = await shown();
    if (onScreen.join() !== model.join()) fail(`${what}: 화면 순서`, { onScreen: onScreen.map(id => names[id]), model: model.map(id => names[id]) });
    const until = Date.now() + 5000;
    let db = await saved();
    while (db.join() !== model.join() && Date.now() < until) {
      await sleep(50);
      db = await saved();
    }
    if (db.join() !== model.join()) fail(`${what}: 저장 순서`, { db: db.map(id => names[id]), model: model.map(id => names[id]) });
  };

  // 손잡이를 실제로 눌러 끌기 시작
  const grab = async id => {
    const rows = await boxes();
    const row = rows.find(r => r.id === id);
    const handle = await main.locator(`[data-memo-id="${id}"]`).boundingBox();
    const at = { x: row.left + 6, y: handle.y + 12 };
    await moveTo(at.x, at.y);
    await sleep(60);
    const box = await main.locator(`[data-memo-id="${id}"] [aria-label="끌어서 옮기기"]`).boundingBox();
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await moveTo(start.x, start.y);
    await sleep(40);
    await mouse.send('down');
    await sleep(30);
    await glide(start, { x: start.x, y: start.y + 8 }, 3);
    return { x: start.x, y: start.y + 8 };
  };

  const random = createRandom(20261102);
  const run = async (rounds, label) => {
    for (let round = 0; round < rounds; round++) {
      const from = random(model.length);
      const id = model[from];
      let gap = random(model.length + 1);
      const fast = random(3) === 0;
      const at = await grab(id);
      const rows = await boxes();
      const targetY = gapY(rows, gap);
      await glide(at, { x: at.x, y: targetY }, fast ? 2 : 10, fast ? 2 : 12);
      await sleep(fast ? 30 : 60);
      const noop = gap === from || gap === from + 1;
      if (!noop && (await line.count()) === 0) fail(`${label} #${round}: 삽입선 없음`, { from, gap });
      if (!noop) {
        const top = (await line.boundingBox()).y;
        if (Math.abs(top - targetY) > 4) fail(`${label} #${round}: 삽입선 위치`, { from, gap, top, targetY });
      }
      // 가끔: 그 자리에서 작은 흔들림 — 삽입선이 움직이지 않아야 한다
      if (!noop && random(3) === 0) {
        const tops = new Set();
        for (const wobble of [3, -4, 5, -2, 4, -5]) {
          await moveTo(at.x, targetY + wobble);
          await sleep(35);
          if (await line.count()) tops.add(Math.round((await line.boundingBox()).y));
        }
        report.wobbleChecks += 1;
        if (tops.size > 1) fail(`${label} #${round}: 흔들림에 삽입선이 움직임`, { tops: [...tops], from, gap });
        await moveTo(at.x, targetY);
        await sleep(40);
      }
      // 가끔: Esc 취소
      if (random(6) === 0) {
        await mouse.send('esc');
        await sleep(40);
        const keys = await page.evaluate(() => window.__keys.splice(0));
        if (!keys.some(k => k.code === 'Escape')) fail(`${label} #${round}: Esc 가 앱에 닿지 않음`, { keys, focused: await page.evaluate(() => document.hasFocus()) });
        await mouse.send('up');
        report.cancelled += 1;
        await sleep(120);
        if (await line.count()) fail(`${label} #${round}: 취소 뒤 삽입선`, {});
        await expectOrder(`${label} #${round} 취소`);
        continue;
      }
      await mouse.send('up');
      if (noop) report.noops += 1;
      else {
        model.splice(gap > from ? gap - 1 : gap, 0, model.splice(from, 1)[0]);
        report.drags += 1;
      }
      await sleep(30);
      await expectOrder(`${label} #${round}`);
      gap = 0;
    }
  };

  // ① 기본 창 크기
  report.sizes.push(await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`));
  await run(30, '기본 창');
  await app.shot('drag-os-default');

  // ② 끄는 중 휠 스크롤 — 삽입선이 커서 아래 틈을 따라간다
  {
    const id = model[0];
    const at = await grab(id);
    await glide(at, { x: at.x, y: at.y + 150 }, 8);
    await sleep(60);
    await mouse.send('wheel -120');
    await sleep(350);
    await mouse.send('wheel 120');
    await sleep(350);
    if (await line.count()) {
      const top = (await line.boundingBox()).y;
      if (Math.abs(top - (at.y + 150)) > 80) fail('휠 스크롤 뒤 삽입선', { top, y: at.y + 150 });
    }
    report.scrolled += 1;
    await mouse.send('esc');
    await sleep(40);
    await mouse.send('up');
    await sleep(120);
    await expectOrder('휠 스크롤 취소');
  }

  // ③ 최소 창 크기(tauri minWidth 850 · minHeight 620 — 물리 픽셀로)
  await mouse.send(`size ${Math.round(850 * dpr)} ${Math.round(656 * dpr)}`);
  await sleep(500);
  report.sizes.push(await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`));
  await sleep(200);
  await run(15, '최소 창');
  await app.shot('drag-os-small');

  // ④ 재실행 후 순서 그대로
  mouse.close();
  mouse = null;
  await app.restart();
  assert.equal((await saved()).join(), model.join(), '재실행 후 같은 순서');
  report.restartOrderKept = true;
  console.log(`✔ 실제 마우스 끌어 놓기: ${JSON.stringify(report)}`);
} catch (error) {
  if (error instanceof ExternalInput) {
    report.externalInput = error.message;
    console.log(`⚠ 외부 입력으로 중단(실패 아님, 다시 실행): ${error.message}`);
    exit = 2;
  } else {
    report.error = error.message;
    console.log(`✘ ${error.message}`);
    await app.shot('drag-os-FAILED').catch(() => undefined);
    exit = 1;
  }
} finally {
  mouse?.close();
  await sleep(300);
  await app.kill();
  app.cleanup();
  clearE2eCredential();
  restoreWindowState();
  writeFileSync(path.join(repoRoot, 'e2e', 'output', 'drag-os-report.json'), JSON.stringify(report, null, 2));
}
process.exit(exit);
