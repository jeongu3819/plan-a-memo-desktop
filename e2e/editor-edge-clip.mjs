// 편집기 가장자리 잘림 E2E — 메모를 편집할 때 커서·글자·한글 조합 밑줄이 편집기 경계에서 잘리지 않는지 픽셀로 잰다.
//   npm run e2e:build
//   node e2e/editor-edge-clip.mjs            (CDP 로 한글 조합)
//   node e2e/editor-edge-clip.mjs --os-ime   (실제 Windows 한국어 IME 로 조합 — 실행 중(약 20초) 키보드·앞 창을 쓴다)
// 결과: e2e/output/editor-edge-clip-report.json, e2e/output/edge-clip-*.png(6배 확대, 빨간 점선 = 편집기 아래 경계)
// 격리: harness 의 임시 설정·임시 저장 위치, Mock 서버. 메모는 모두 더미 글이다.
//
// 판정 방법: 같은 순간을 편집기 overflow 그대로(auto) / visible(아무것도 자르지 않음) 두 가지로 찍어 비교한다.
//   · 글자·밑줄(커서 숨김)의 픽셀이 하나라도 다르면 = 편집기가 무언가를 잘랐다.
//   · 커서(커서 보임 − 커서 숨김의 차이 상자)의 위·아래·위치가 다르면 = 커서가 잘렸다.
//   overflow 만 바꾸므로 배치(높이)는 같아야 하고, 그것도 확인한다.
// 위치: 첫 줄 맨 앞 · 마지막 줄 맨 앞/끝 · 줄바꿈 끝(오른쪽 경계) · Enter 로 만든 빈 새 줄 · 새 줄 한글 조합 중/완료 · 영문·숫자.
// 함께 확인: 읽기 = 편집 높이, 편집기 안 스크롤 없음, 편집만 열고 닫으면 저장 없음, 작은 창.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { App, clearE2eCredential, isolateWindowState, repoRoot } from './harness.mjs';

const osIme = process.argv.includes('--os-ime');
const app = new App();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = [];
const failures = [];

const plusDays = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const check = (condition, label, detail) => {
  const ok = !!condition;
  report.push({ check: label, ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(label);
};
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

function setWindow(pid, size) {
  const script =
    "Add-Type -Namespace PlanaE2e -Name Win -MemberDefinition '" +
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); ' +
    '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int t, uint f);' +
    "'; " +
    `$h = (Get-Process -Id ${pid}).MainWindowHandle; if ($h -eq [IntPtr]::Zero) { throw 'no window' }; ` +
    `[void][PlanaE2e.Win]::ShowWindow($h, 9); [void][PlanaE2e.Win]::SetWindowPos($h, [IntPtr]::Zero, 40, 40, ${size.width}, ${size.height}, 0x0014)`;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe' });
}
async function resizeWindow(size) {
  const before = await app.page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`);
  setWindow(app.proc.pid, size);
  for (let i = 0; i < 12 && (await app.page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)) === before; i++) await sleep(150);
  await sleep(400);
}
/** 실제 키 입력(OS → IME). 테스트 창이 앞이 아니면 멈춘다. */
const osKeys = keys =>
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'e2e', 'os-keys.ps1'), '-AppPid', String(app.proc.pid), '-Keys', keys], { encoding: 'utf8' }).trim();

async function toWeek() {
  await app.page.reload();
  await app.page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  await app.page.evaluate(() => {
    window.__composition = [];
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
      document.addEventListener(type, event => window.__composition.push(`${type.slice(11)}:${event.data}`), true);
    }
  });
}
async function openNext() {
  await toWeek();
  await app.page.click('[data-testid="memo-cell-next"] button[aria-label$="메모 쓰기"]');
  await app.page.waitForSelector('[data-testid="memo-section-next"]');
  await app.page.locator('[data-testid="memo-header-date"]').click(); // 입력칸 자동 포커스를 푼다
  await sleep(300);
}
async function openDate(date) {
  await toWeek();
  execFileSync('cmd', ['/c', 'start', '', `plana-memo-dev://open?date=${date}`], { stdio: 'ignore' });
  await app.page.locator(`[data-testid="upcoming-card-${plusDays(date, 7)}"]`).waitFor({ timeout: 20000 });
  await sleep(300);
}

const rowSel = id => `[data-testid="personal-memo-row"][data-memo-id="${id}"]`;
const editorSel = id => `${rowSel(id)} [contenteditable="true"]`;

/** 메모 줄·편집기 상태 */
const rowState = id =>
  app.page.evaluate(sel => {
    const row = document.querySelector(sel);
    const ed = row.querySelector('[contenteditable="true"]');
    const cs = ed ? getComputedStyle(ed) : null;
    return {
      rowHeight: row.getBoundingClientRect().height,
      editing: !!ed,
      innerScroll: ed ? ed.scrollHeight - ed.clientHeight : null,
      editor: ed ? { overflow: `${cs.overflowX}/${cs.overflowY}`, radius: cs.borderBottomLeftRadius, padding: cs.padding } : null,
    };
  }, rowSel(id));

/** 편집기 안 커서를 옮긴다 — where: first-start | last-start | last-end | wrap-end(첫 줄의 줄바꿈 끝 = 오른쪽 경계) */
async function placeCaret(id, where) {
  await app.page.evaluate(
    ([sel, w]) => {
      const ed = document.querySelector(sel);
      ed.focus();
      const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
      const nodes = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.trim()) nodes.push(n);
      const range = document.createRange();
      const node = w === 'first-start' || w === 'wrap-end' ? nodes[0] : nodes[nodes.length - 1];
      range.setStart(node, w === 'last-end' ? node.data.length : 0);
      range.collapse(true);
      const sel2 = getSelection();
      sel2.removeAllRanges();
      sel2.addRange(range);
    },
    [editorSel(id), where],
  );
  if (where === 'wrap-end') await app.page.keyboard.press('End'); // 첫 화면 줄의 끝(줄바꿈 자리) — 오른쪽 경계
  await sleep(250);
}

/** 화면 조각 두 장을 페이지에서 비교(브라우저가 PNG 를 읽는다): 다른 픽셀 수·상자. zoom 이면 6배 확대 PNG 도. */
const comparePngs = (a, b, zoom, markY) =>
  app.page.evaluate(
    async ([a64, b64, z, mark]) => {
      const load = async b64s => {
        // 앱 CSP 가 data: fetch 를 막는다 — 직접 바이트로.
        const bin = atob(b64s);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d');
        g.drawImage(bmp, 0, 0);
        return { bmp, data: g.getImageData(0, 0, bmp.width, bmp.height) };
      };
      const A = await load(a64);
      const B = await load(b64);
      const w = A.data.width;
      let count = 0, top = 1e9, bottom = -1, left = 1e9, right = -1;
      for (let i = 0; i < A.data.data.length; i += 4) {
        const d = Math.abs(A.data.data[i] - B.data.data[i]) + Math.abs(A.data.data[i + 1] - B.data.data[i + 1]) + Math.abs(A.data.data[i + 2] - B.data.data[i + 2]);
        if (d <= 30) continue;
        const x = (i / 4) % w, y = Math.floor(i / 4 / w);
        count++; top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x);
      }
      let png = null;
      if (z) {
        const c = new OffscreenCanvas(w * 6, A.data.height * 6);
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = false;
        g.drawImage(A.bmp, 0, 0, w * 6, A.data.height * 6);
        g.fillStyle = 'rgba(255,0,0,0.9)';
        for (let x = 0; x < w * 6; x += 4) g.fillRect(x, Math.round(mark * 6), 2, 1);
        const blob = await c.convertToBlob({ type: 'image/png' });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        png = btoa(s);
      }
      return { count, box: count ? { top, bottom: bottom + 1, left, right: right + 1 } : null, png };
    },
    [a.toString('base64'), b.toString('base64'), zoom, markY],
  );

const VISIBLE_STYLE = '__edge_clip_visible';
const setVisible = on =>
  app.page.evaluate(
    ([id, enable]) => {
      document.getElementById(id)?.remove();
      if (!enable) return;
      const style = document.createElement('style');
      style.id = id;
      style.textContent = '[data-testid="personal-memo-row"] [contenteditable="true"] { overflow: visible !important; }';
      document.head.appendChild(style);
    },
    [VISIBLE_STYLE, on],
  );

/** 커서 픽셀 상자(커서 보임 − 숨김). 깜빡임 때문에 보일 때까지 몇 번 찍는다. */
async function caretBox(clip) {
  const hidden = await app.page.screenshot({ clip, caret: 'hide' });
  for (let i = 0; i < 8; i++) {
    const on = await app.page.screenshot({ clip, caret: 'initial' });
    const diff = await comparePngs(on, hidden, false, 0);
    if (diff.box) return { top: clip.y + diff.box.top, bottom: clip.y + diff.box.bottom, left: clip.x + diff.box.left, right: clip.x + diff.box.right, on };
    await sleep(140);
  }
  return null;
}

/** 지금 상태에서 편집기가 무엇을 자르는지 — auto 와 visible 비교. */
async function edgeCheck(label, id, name) {
  const page = app.page;
  const geo = await page.evaluate(sel => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, editorSel(id));
  const vw = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const clip = {
    x: Math.max(0, Math.floor(geo.left - 6)),
    y: Math.max(0, Math.floor(geo.top - 6)),
  };
  clip.width = Math.min(vw.w, Math.ceil(geo.right + 6)) - clip.x;
  clip.height = Math.min(vw.h, Math.ceil(geo.bottom + 6)) - clip.y;
  const textAuto = await page.screenshot({ clip, caret: 'hide' });
  const caretAuto = await caretBox(clip);
  await setVisible(true);
  await sleep(120);
  const geoVisible = await page.evaluate(sel => document.querySelector(sel).getBoundingClientRect().bottom, editorSel(id));
  const textVisible = await page.screenshot({ clip, caret: 'hide' });
  const caretVisible = await caretBox(clip);
  await setVisible(false);
  await sleep(120);
  const text = await comparePngs(textAuto, textVisible, false, 0);
  const shot = await comparePngs(caretAuto?.on ?? textAuto, textVisible, true, geo.bottom - clip.y);
  writeFileSync(path.join(app.shotDir, `edge-clip-${name}.png`), Buffer.from(shot.png, 'base64'));
  const box = c => (c ? { top: c.top, bottom: c.bottom, x: c.left } : null);
  const sameCaret = !!caretAuto && !!caretVisible && caretAuto.top === caretVisible.top && caretAuto.bottom === caretVisible.bottom && caretAuto.left === caretVisible.left;
  const detail = {
    editorBottom: Math.round(geo.bottom * 100) / 100,
    caret: box(caretAuto),
    caretUnclipped: box(caretVisible),
    clippedPixels: text.count,
    ...(text.box ? { clippedAt: { x: clip.x + text.box.left, y: clip.y + text.box.top, w: text.box.right - text.box.left, h: text.box.bottom - text.box.top } } : {}),
  };
  check(near(geoVisible, geo.bottom, 0.01), `${label}: 비교 조건(overflow 만 바꿔도 높이 그대로)`, { auto: geo.bottom, visible: geoVisible });
  check(text.count === 0 && sameCaret, `${label}: 잘림 없음`, detail);
  return detail;
}

/** 읽기 화면의 마지막 줄 가운데를 눌러 편집을 시작한다. */
async function startEditing(id) {
  const page = app.page;
  await page.evaluate(sel => document.querySelector(sel).scrollIntoView({ block: 'center' }), rowSel(id));
  await sleep(200);
  const point = await page.evaluate(sel => {
    const content = document.querySelector(`${sel} [data-testid="personal-memo-content"]`);
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let last = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.trim()) last = n;
    const range = document.createRange();
    range.setStart(last, Math.floor(last.data.length / 2));
    range.setEnd(last, Math.floor(last.data.length / 2) + 1);
    const r = range.getBoundingClientRect();
    return { x: r.left + 1, y: r.top + r.height / 2 };
  }, rowSel(id));
  await page.mouse.click(point.x, point.y);
  await page.locator(editorSel(id)).waitFor();
  await sleep(400);
}
const endEditing = async () => {
  await app.page.keyboard.press('Escape');
  await app.page.waitForFunction(() => !document.querySelector('[data-testid="personal-memo-row"] [contenteditable="true"]'));
  await sleep(250);
};

/** 한글 'ㅇ' 조합 시작. CDP(기본) 또는 실제 IME(--os-ime). 조합 중이면 true. */
async function composeIeung(id) {
  if (!osIme) {
    await app.cdp.send('Input.imeSetComposition', { text: 'ㅇ', selectionStart: 1, selectionEnd: 1 });
    await sleep(250);
    return true;
  }
  await app.page.evaluate(() => { window.__composition = []; });
  osKeys('44'); // D → 한글 모드면 'ㅇ'
  await sleep(250);
  let log = await app.page.evaluate(() => window.__composition);
  if (!log.includes('update:ㅇ')) {
    osKeys('08,15,44'); // 영문 'd' 를 지우고 한/영 전환 후 다시
    await sleep(250);
    log = await app.page.evaluate(() => window.__composition);
  }
  const ok = log.includes('update:ㅇ');
  check(ok, `실제 IME 조합 시작(${id.slice(0, 8)})`, log);
  return ok;
}
async function commitIeung() {
  if (!osIme) await app.cdp.send('Input.insertText', { text: 'ㅇ' });
  else osKeys('4B,20'); // ㅏ → '아', Space 로 조합 완료
  await sleep(250);
}

/** 메모 하나: 읽기 = 편집 높이 → 가장자리 위치마다 잘림 비교 → Enter·한글·영문 → 편집 끝 높이. */
async function scenario(label, id, { wrap = false, prefix } = {}) {
  console.log(`\n[${label}]`);
  const read = await rowState(id);
  await startEditing(id);
  const edit = await rowState(id);
  check(near(edit.rowHeight, read.rowHeight, 2), `${label}: 읽기 = 편집 높이`, { read: read.rowHeight, edit: edit.rowHeight });
  check(edit.innerScroll !== null && edit.innerScroll <= 1, `${label}: 편집기 안 스크롤 없음`, { inner: edit.innerScroll, editor: edit.editor });
  const results = { label, editor: edit.editor };
  for (const where of ['first-start', 'last-start', 'last-end', ...(wrap ? ['wrap-end'] : [])]) {
    await placeCaret(id, where);
    results[where] = await edgeCheck(`${label} · ${where}`, id, `${prefix}-${where}`);
  }
  await placeCaret(id, 'last-end');
  await app.page.keyboard.press('Enter');
  await sleep(250);
  results.newLine = await edgeCheck(`${label} · Enter 빈 새 줄`, id, `${prefix}-newline`);
  if (await composeIeung(id)) {
    results.composing = await edgeCheck(`${label} · 새 줄 한글 조합 중`, id, `${prefix}-composing`);
    await commitIeung();
    results.committed = await edgeCheck(`${label} · 한글 조합 완료`, id, `${prefix}-committed`);
  }
  await app.page.keyboard.type(' abc 123');
  await sleep(200);
  results.latin = await edgeCheck(`${label} · 영문·숫자`, id, `${prefix}-latin`);
  const typed = await rowState(id);
  await endEditing();
  const after = await rowState(id);
  check(near(after.rowHeight, typed.rowHeight, 2), `${label}: 편집 끝 — 높이 그대로`, { edit: typed.rowHeight, read: after.rowHeight });
  report.push({ scenario: label, ...results });
}

const restoreWindowState = isolateWindowState();
clearE2eCredential();
await app.start();
try {
  const page = app.page;
  app.cdp = await page.context().newCDPSession(page);
  const ready = await app.invoke('storage_initialize', { path: app.storeDir, createNew: true });
  assert.equal(ready.state, 'ready');
  const today = (await app.invoke('app_info')).today;
  await resizeWindow({ width: 1100, height: 816 });

  const create = (location, section, html, kind = 'checklist') =>
    app.invoke('item_create', { input: { id: crypto.randomUUID(), location, section, kind, contentHtml: html } });
  const day = plusDays(today, 400);
  const dayLoc = { kind: 'day', date: day };
  // 첫·마지막 줄이 'ㄱ'·'ㄴ' 으로 시작 — 글자 획이 편집기 왼쪽 위·아래 모서리에 닿는다.
  const mainCheck = await create(dayLoc, 'main', '<p>ㄱ메인 할 일 첫 줄</p><ol><li>하나 항목</li><li>둘 항목</li></ol><p>ㄴ마지막 줄 ㅇ</p>');
  const mainWrap = await create(dayLoc, 'main', `<p>${'ㄱ긴 줄이 편집기 오른쪽 경계에서 접힙니다 '.repeat(4)}</p><p><span data-text-size="xlarge">ㄴ큰 글자 마지막 줄</span></p>`);
  const amText = await create(dayLoc, 'am', '<p>ㄴ오전 한 줄 메모</p>', 'text');
  const pmList = await create(dayLoc, 'pm', '<ol><li>ㄱ첫 번째</li><li>ㄴ마지막 목록 줄</li></ol>');
  const next = await create({ kind: 'next', listId: null }, 'next', '<p>ㄱ넥스트 첫 줄</p><p><b><u>ㄴ굵은 밑줄 마지막 줄</u></b></p>');

  // 편집만 열고 닫으면 저장되지 않는다(가장자리 수정이 내용·저장을 건드리지 않음).
  await openNext();
  {
    const before = (await app.invoke('memo_list', { listId: null })).items.find(i => i.id === next.id);
    for (let i = 0; i < 3; i++) {
      await startEditing(next.id);
      await endEditing();
    }
    await sleep(1500);
    const after = (await app.invoke('memo_list', { listId: null })).items.find(i => i.id === next.id);
    check(after.updatedAt === before.updatedAt && after.contentHtml === before.contentHtml, 'NEXT: 편집 열고 닫기만 하면 저장 없음', { before: before.updatedAt, after: after.updatedAt });
  }
  await scenario('NEXT 기본 · 굵은 밑줄 마지막 줄', next.id, { prefix: 'next' });

  await openDate(day);
  await scenario('DAY 메인 · 체크 + 번호 목록', mainCheck.id, { prefix: 'day-main' });
  await scenario('DAY 메인 · 줄바꿈 + 큰 글자', mainWrap.id, { wrap: true, prefix: 'day-main-wrap' });
  await scenario('DAY 오전 · 텍스트 한 줄', amText.id, { prefix: 'day-am' });
  await scenario('DAY 오후 · 번호 목록 마지막 줄', pmList.id, { prefix: 'day-pm' });

  console.log('\n[작은 창 800×600]');
  await resizeWindow({ width: 800, height: 600 });
  await openDate(day);
  await scenario('작은 창 · DAY 메인 줄바꿈', mainWrap.id, { wrap: true, prefix: 'small-wrap' });

  const saved = (await app.invoke('memo_list', { listId: null })).items.find(i => i.id === next.id);
  check(saved.contentHtml.includes('abc 123'), 'NEXT: 입력 저장', saved.contentHtml.slice(-80));
} catch (error) {
  failures.push(`예외: ${error.message}`);
  console.error(error);
} finally {
  writeFileSync(path.join(app.shotDir, 'editor-edge-clip-report.json'), JSON.stringify({ osIme, failures, report }, null, 2));
  await app.kill();
  app.cleanup();
  restoreWindowState();
  clearE2eCredential();
}
console.log(failures.length ? `\n실패 ${failures.length}건:\n - ${failures.join('\n - ')}` : '\n모두 통과');
process.exit(failures.length ? 1 : 0);
