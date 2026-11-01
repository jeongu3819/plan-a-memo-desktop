// 긴 텍스트 붙여넣기 E2E — 실제 앱 · 실제 Windows 클립보드 · Ctrl+V · SQLite 직접 확인 · 정상 종료 후 재실행.
//   npm run e2e:build
//   node e2e/long-paste.mjs              (전체)
//   node e2e/long-paste.mjs next-quick   (이름에 맞는 단계만 — 'setup' 은 항상)
//
// 각 원문은 단계마다(클립보드 → Ctrl+V 직후 → 자동 저장 → SQLite → 화면 전환 → 재실행) 글자 수·줄 수·
// 공백을 뺀 글자 열(signature)·비어 있지 않은 줄 목록·첫/중간/마지막 표식을 비교한다. 결과: e2e/output/long-paste-report.json
// 격리: harness 의 임시 설정·임시 저장 위치. 시작 때 클립보드 텍스트를 보관했다가 끝나면 되돌린다.

import assert from 'node:assert/strict';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { App, clearE2eCredential, isMockRun, isolateWindowState } from './harness.mjs';
import { backupClipboard, readClipboardText, restoreClipboard, setClipboard } from './clipboard.mjs';
import { contentLines, END_MARKER, fixtures, metrics, richHtmlOf, signature } from './pasteFixtures.mjs';

const app = new App();
const only = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FX = Object.fromEntries(fixtures().map(f => [f.name, f.text]));
const rows = [];
const items = new Map(); // 재실행 후 확인할 항목: id → { target, expectSig, expectLines }
let today = '';
let dbFile = '';

async function waitFor(fn, message, timeout = 20000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`시간 초과: ${message}`);
}

const plusDays = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

function findDb(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === 'memo.sqlite3') return full;
    if (statSync(full).isDirectory()) {
      const found = findDb(full);
      if (found) return found;
    }
  }
  return '';
}

function sql(query, ...params) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db.prepare(query).all(...params);
  } finally {
    db.close();
  }
}

const dbItem = id => sql('SELECT id, content_html, content_text FROM memo_items WHERE id = ? AND deleted_at IS NULL', id)[0];
/** 아직 기록하지 않은 항목 중 저장 HTML 이 정확히 html 인 것. */
const dbFindNew = html =>
  sql('SELECT id, content_html FROM memo_items WHERE deleted_at IS NULL AND content_html = ?', html).find(r => !items.has(r.id));
/** 아직 기록하지 않은 항목 중 표식이 든 것(정확히 같지 않을 때 원인 확인용). */
const dbFindMarker = marker =>
  sql('SELECT id, content_html FROM memo_items WHERE deleted_at IS NULL AND instr(content_html, ?) > 0', marker).find(r => !items.has(r.id));

/** 저장 HTML → 화면에 보이는 텍스트(줄 구조 포함). */
const htmlToText = html =>
  app.page.evaluate(h => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:-20000px;top:0;width:900px;white-space:pre-wrap';
    d.innerHTML = h;
    document.body.append(d);
    const t = d.innerText;
    d.remove();
    return t;
  }, html);

const escapeHtml = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** QuickInput 이 저장하는 HTML(앞쪽 빈 줄·끝 공백만 다듬고 줄은 <br>). */
const quickHtml = text => text.replace(/^\s*\n/, '').replace(/\s+$/, '').split('\n').map(escapeHtml).join('<br>');

/** 단계별 기록. expected 와 같은 글자·줄을 가졌는지. */
function record(target, fx, stage, text, expected) {
  const m = metrics(text);
  const sigOk = signature(text) === signature(expected);
  const exp = contentLines(expected);
  const got = contentLines(text);
  const linesOk = exp.length === got.length && exp.every((l, i) => l === got[i]);
  let firstDiff = null;
  if (!sigOk) {
    const a = signature(expected);
    const b = signature(text);
    let i = 0;
    while (i < a.length && a[i] === b[i]) i += 1;
    firstDiff = { at: i, expectedLen: a.length, gotLen: b.length, expected: a.slice(i, i + 30), got: b.slice(i, i + 30) };
  }
  const row = { target, case: fx, stage, chars: m.chars, lines: m.lines, nonEmptyLines: m.nonEmptyLines, end: m.hasEnd, sigOk, linesOk, firstDiff };
  rows.push(row);
  console.log(
    `   · ${target} / ${fx} / ${stage}: ${m.chars}자 ${m.lines}줄(내용 ${m.nonEmptyLines}) END=${m.hasEnd ? 'O' : 'X'} 글자=${sigOk ? 'O' : 'X'} 줄=${linesOk ? 'O' : 'X'}` +
      (firstDiff ? ` 첫 차이 @${firstDiff.at} (${firstDiff.gotLen}/${firstDiff.expectedLen})` : ''),
  );
  return row;
}

function must(row) {
  assert.ok(row.end, `${row.target}/${row.case}/${row.stage}: 마지막 표식 ${END_MARKER} 이 없다`);
  assert.ok(row.sigOk, `${row.target}/${row.case}/${row.stage}: 글자가 빠졌다 ${JSON.stringify(row.firstDiff)}`);
  assert.ok(row.linesOk, `${row.target}/${row.case}/${row.stage}: 줄(문단) 구조가 다르다`);
}

function clip(text, html = null) {
  // 클립보드는 PC 전체가 함께 쓴다 — 넣은 직후 다른 프로그램이 바꾸면 다시 넣는다
  let back = '';
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    setClipboard(text, html);
    back = readClipboardText();
    if (back === text) break;
    console.log('     (클립보드가 테스트 밖에서 바뀌어 다시 넣음)');
  }
  assert.equal(back, text, '클립보드에 원문 전체가 들어갔다');
  return back;
}

/**
 * 클립보드에 넣고 곧바로 Ctrl+V. 붙여넣은 결과가 원문과 다르고 그 사이 클립보드가 **테스트 밖에서** 바뀌었으면
 * (사용자가 다른 것을 복사 등) 되돌리고(reset) 다시 한다. 클립보드가 그대로인데 다르면 그대로 돌려준다(앱 문제 → 단계 실패).
 */
async function pasteWithRetry(text, html, paste, read, expected, reset) {
  for (let attempt = 1; ; attempt += 1) {
    const clipText = clip(text, html);
    const started = Date.now();
    await paste();
    const value = await settled(read);
    const ms = Date.now() - started;
    if (signature(value) === signature(expected) || attempt === 3 || readClipboardText() === text) return { clipText, value, ms };
    console.log('     (클립보드가 테스트 밖에서 바뀌어 다시 붙여넣음)');
    await reset();
  }
}

// ── 화면 이동 ──
async function toWeek() {
  const back = app.page.locator('[data-testid="memo-back-to-week"]');
  if (await back.count()) await back.click();
  await app.page.waitForSelector('[data-testid="personal-memo-week"]');
}
async function openNext() {
  await toWeek();
  await app.page.click('[data-testid="memo-cell-next"]', { position: { x: 24, y: 12 } });
  await app.page.waitForSelector('[data-testid="memo-section-next"]');
}
async function openToday() {
  await toWeek();
  await app.page.click('[data-testid="memo-today"]');
  await app.page.waitForSelector('[data-testid="memo-section-main"]');
  await app.page.mouse.move(5, 300);
}
/** 편집·입력을 끝낸다(바깥 누르기 — 자동 저장 경로). */
const clickOutside = () => app.page.locator('[data-testid="memo-header-date"]').click();

/** 붙여넣기가 끝날 때까지(값이 더 이상 늘지 않을 때까지). */
async function settled(read) {
  let prev = -1;
  let same = 0;
  for (let i = 0; i < 200 && same < 3; i += 1) {
    const n = (await read()).length;
    same = n === prev && n > 0 ? same + 1 : 0;
    prev = n;
    await sleep(150);
  }
  return read();
}

/** 텍스트 노드에서 표식을 찾아 화면 가운데로 스크롤 → 실제로 보이는지(가려지지 않았는지). */
async function markerReachable(container, marker) {
  return container.evaluate((root, mk) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.data.indexOf(mk);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + mk.length);
      const rect = () => range.getClientRects()[0] || range.getBoundingClientRect();
      // 안쪽(편집기 내부 스크롤)부터 바깥(페이지 스크롤) 순서로 표식을 가운데로 — 사용자가 스크롤하는 것과 같다
      for (let el = node.parentElement; el; el = el.parentElement) {
        const st = getComputedStyle(el);
        if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight) {
          const box = el.getBoundingClientRect();
          el.scrollTop += rect().top - box.top - el.clientHeight / 2;
        }
      }
      const r = rect();
      let clippedBy = null;
      for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
        const st = getComputedStyle(el);
        if (st.overflowY === 'visible' && st.overflowX === 'visible') continue;
        const box = el.getBoundingClientRect();
        if (r.top < box.top - 1 || r.bottom > box.bottom + 1) {
          clippedBy = `${el.tagName}.${el.className}`.slice(0, 80);
          break;
        }
      }
      const x = r.left + Math.min(r.width / 2, 10);
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        inViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0 && !clippedBy,
        hitInside: !!hit && root.contains(hit),
        clippedBy,
      };
    }
    return { inViewport: false, hitInside: false, missing: true };
  }, marker);
}

// ── QuickInput(새 메모 입력칸) 에 붙여넣기 ──
async function quickPaste(target, input, fx, shot) {
  const text = FX[fx];
  const { clipText, value, ms: pasteMs } = await pasteWithRetry(
    text,
    null,
    async () => {
      await input.click();
      await app.page.keyboard.press('Control+V');
    },
    () => input.inputValue(),
    text,
    async () => {
      await input.click();
      await app.page.keyboard.press('Control+A');
      await app.page.keyboard.press('Delete');
    },
  );
  record(target, fx, 'clipboard', clipText, text);
  must(record(target, fx, 'Ctrl+V 직후(입력칸)', value, text));
  assert.equal(value, text, `${target}/${fx}: 입력칸 값이 원문과 정확히 같다`);
  // 커서가 끝에 있고, 끝까지 스크롤된다
  const caret = await input.evaluate(el => ({ at: el.selectionStart, len: el.value.length }));
  assert.equal(caret.at, caret.len, '붙여넣은 뒤 커서는 끝');
  const reach = await input.evaluate(el => {
    el.scrollIntoView({ block: 'end' });
    const r = el.getBoundingClientRect();
    return { bottomVisible: r.bottom <= window.innerHeight + 1, height: r.height, scrollH: el.scrollHeight, clientH: el.clientHeight };
  });
  assert.ok(reach.bottomVisible, '입력칸 끝(마지막 줄)까지 스크롤할 수 있다');
  assert.ok(reach.scrollH <= reach.clientH + 2, '입력칸 안에 숨은 내용 없음(높이가 내용만큼)');
  if (shot) await app.shot(shot);
  await clickOutside();
  const saved = await waitFor(() => dbFindNew(quickHtml(text)), `${target}/${fx} SQLite 저장`, 8000).catch(async error => {
    const other = dbFindMarker(`[FIRST-${fx}]`);
    if (other) must(record(target, fx, 'SQLite(원문과 다름)', await htmlToText(other.content_html), text));
    throw error;
  });
  must(record(target, fx, 'SQLite', await htmlToText(saved.content_html), text));
  items.set(saved.id, { target, fx, expect: text });
  console.log(`     (Ctrl+V → 입력칸 반영 ${pasteMs}ms)`);
  return saved.id;
}

// ── 기존 메모를 Rich Editor 로 열어 끝에 붙여넣기 ──
async function editorPaste(target, rowSel, itemId, base, fx, { html = false, shot } = {}) {
  const text = FX[fx];
  const row = app.page.locator(`${rowSel}[data-memo-id="${itemId}"]`);
  await row.locator('[aria-label="메모 편집"]').click();
  const editable = row.locator('[contenteditable="true"]');
  await editable.waitFor();
  await app.page.keyboard.press('Control+End');
  await app.page.keyboard.press('Enter');
  const expected = `${base}\n${text}`;
  const { value: shown, ms: pasteMs } = await pasteWithRetry(
    text,
    html ? richHtmlOf(text) : null,
    () => app.page.keyboard.press('Control+V'),
    () => editable.innerText(),
    expected,
    async () => {
      await app.page.keyboard.press('Control+Z'); // 엉뚱하게 붙은 것만 되돌린다
      await sleep(300);
    },
  );
  must(record(target, fx + (html ? '(HTML)' : ''), 'Ctrl+V 직후(편집기)', shown, expected));
  // 편집기 안 스크롤: 커서(끝)가 보이고, 마지막 줄까지 갈 수 있다
  const view = await editable.evaluate(el => {
    const sel = window.getSelection();
    const r = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    const box = el.getBoundingClientRect();
    return {
      scrolls: el.scrollHeight > el.clientHeight,
      atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 40,
      caretInside: !!r && r.bottom <= box.bottom + 2 && r.top >= box.top - 2,
      focused: document.activeElement === el,
    };
  });
  assert.ok(view.focused, '붙여넣은 뒤에도 편집기 포커스 유지');
  assert.ok(!view.scrolls || view.atBottom, '붙여넣은 뒤 편집기가 끝(커서 위치)까지 스크롤됨');
  const endReach = await markerReachable(editable, END_MARKER);
  assert.ok(endReach.inViewport && endReach.hitInside, `편집기에서 마지막 문장이 보인다 ${JSON.stringify(endReach)}`);
  if (shot) await app.shot(shot);
  // 편집 중 자동 저장(바깥을 누르지 않고 기다리기만)
  const auto = await waitFor(() => {
    const r = dbItem(itemId);
    return r && r.content_html.includes(END_MARKER) ? r : null;
  }, `${target}/${fx} 자동 저장`);
  must(record(target, fx + (html ? '(HTML)' : ''), '자동 저장(SQLite)', await htmlToText(auto.content_html), expected));
  await clickOutside();
  await sleep(400);
  const saved = dbItem(itemId);
  must(record(target, fx + (html ? '(HTML)' : ''), 'SQLite(편집 종료)', await htmlToText(saved.content_html), expected));
  items.set(itemId, { target, fx, expect: expected });
  console.log(`     (Ctrl+V → 편집기 반영 ${pasteMs}ms)`);
  return expected;
}

const create = (location, section, html) =>
  app.invoke('item_create', { input: { id: crypto.randomUUID(), location, section, kind: 'checklist', contentHtml: html } });

// ────────────────────────────────────────────────────────────────────
const steps = [];
const step = (name, fn) => steps.push({ name, fn });

step('setup', async () => {
  const ready = await app.invoke('storage_initialize', { path: app.storeDir, createNew: true });
  assert.equal(ready.state, 'ready');
  today = (await app.invoke('app_info')).today;
  dbFile = findDb(app.workDir);
  assert.ok(dbFile, 'SQLite 파일');
  await app.page.reload();
  await app.page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
});

step('next-quick', async () => {
  await openNext();
  const input = app.page.locator('[data-testid="memo-section-next"] [data-testid="personal-memo-quick-input"]');
  for (const fx of ['ko-S', 'ko-M', 'ko-L', 'mixed-L', 'blank-M', 'oneline-L', 'structured-M', 'ko-XL']) {
    await quickPaste('Next 입력칸', input, fx, fx === 'ko-L' ? 'lp-01-next-quick-ko-L' : null);
  }
});

step('next-editor', async () => {
  await openNext();
  const a = await create({ kind: 'next', listId: null }, 'next', '기존 Next 항목 A');
  const b = await create({ kind: 'next', listId: null }, 'next', '기존 Next 항목 B');
  const c = await create({ kind: 'next', listId: null }, 'next', '기존 Next 항목 C');
  await app.page.reload();
  await openNext();
  const rowSel = '[data-testid="memo-section-next"] [data-testid="personal-memo-row"]';
  await editorPaste('Next 편집기', rowSel, a.id, '기존 Next 항목 A', 'ko-L', { shot: 'lp-02-next-editor-ko-L' });
  await editorPaste('Next 편집기', rowSel, b.id, '기존 Next 항목 B', 'mixed-L', { html: true });
  await editorPaste('Next 편집기', rowSel, c.id, '기존 Next 항목 C', 'structured-M');

  // 이어서 편집: 끝에 문장 추가 · 가운데 수정 · Undo/Redo
  const row = app.page.locator(`${rowSel}[data-memo-id="${a.id}"]`);
  await row.locator('[aria-label="메모 편집"]').click();
  const editable = row.locator('[contenteditable="true"]');
  await editable.waitFor();
  await app.page.keyboard.press('Control+End');
  await app.page.keyboard.type(' 끝에 추가한 문장 [APPEND-1]');
  await editable.evaluate(el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.data.indexOf('[MID-ko-L]');
      if (at >= 0) {
        const range = document.createRange();
        range.setStart(node, at + '[MID-ko-L]'.length);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        node.parentElement.scrollIntoView({ block: 'center' });
        return;
      }
    }
    throw new Error('MID 표식 없음');
  });
  await app.page.keyboard.type(' [MID-EDIT]');
  let shown = await editable.innerText();
  assert.ok(shown.includes('[MID-ko-L] [MID-EDIT]') && shown.includes('[APPEND-1]'), '가운데 수정·끝 추가가 편집기에');
  await app.page.keyboard.press('Control+Z');
  await sleep(200);
  shown = await editable.innerText();
  assert.ok(!shown.includes('[MID-EDIT]'), 'Undo → 가운데 수정 취소');
  assert.ok(shown.includes('[APPEND-1]') && shown.includes(END_MARKER), 'Undo 후에도 나머지 그대로');
  await app.page.keyboard.press('Control+Y');
  await sleep(200);
  shown = await editable.innerText();
  assert.ok(shown.includes('[MID-ko-L] [MID-EDIT]'), 'Redo → 가운데 수정 다시');
  await app.shot('lp-03-next-mid-edit');
  await clickOutside();
  const saved = await waitFor(() => {
    const r = dbItem(a.id);
    return r && r.content_html.includes('[MID-EDIT]') && r.content_html.includes('[APPEND-1]') ? r : null;
  }, '이어서 편집 저장');
  const expected = items
    .get(a.id)
    .expect.replace('[MID-ko-L]', '[MID-ko-L] [MID-EDIT]')
    .replace(END_MARKER, `${END_MARKER} 끝에 추가한 문장 [APPEND-1]`);
  must(record('Next 편집기', 'ko-L+수정', 'SQLite(이어서 편집)', await htmlToText(saved.content_html), expected));
  items.set(a.id, { target: 'Next 편집기', fx: 'ko-L+수정', expect: expected });

  // 붙여넣기 전체를 한 번에 Undo / Redo
  const d = await create({ kind: 'next', listId: null }, 'next', '붙여넣기 Undo 시험');
  await app.page.reload();
  await openNext();
  clip(FX['ko-M']);
  const rowD = app.page.locator(`${rowSel}[data-memo-id="${d.id}"]`);
  await rowD.locator('[aria-label="메모 편집"]').click();
  const edD = rowD.locator('[contenteditable="true"]');
  await edD.waitFor();
  await app.page.keyboard.press('Control+End');
  await app.page.keyboard.press('Control+V');
  await settled(() => edD.innerText());
  assert.ok((await edD.innerText()).includes(END_MARKER));
  await app.page.keyboard.press('Control+Z');
  await sleep(300);
  assert.equal((await edD.innerText()).trim(), '붙여넣기 Undo 시험', 'Ctrl+Z 한 번 → 붙여넣기 전체 취소');
  await app.page.keyboard.press('Control+Y');
  await sleep(300);
  must(record('Next 편집기', 'ko-M', 'Redo 후', await edD.innerText(), `붙여넣기 Undo 시험${FX['ko-M']}`));
  await clickOutside();
  await sleep(800);
});

step('day-sections', async () => {
  await openToday();
  const input = s => app.page.locator(`[data-testid="memo-section-${s}"] [data-testid="personal-memo-quick-input"]`);
  await quickPaste('DAY 메인 입력칸', input('main'), 'ko-L', 'lp-04-day-main-ko-L');
  await quickPaste('DAY 오전 입력칸', input('am'), 'mixed-L');
  await quickPaste('DAY 오후 입력칸', input('pm'), 'blank-M');
  const base = { kind: 'day', date: today };
  const m = await create(base, 'main', '기존 메인 항목');
  const am = await create(base, 'am', '기존 오전 항목');
  const pm = await create(base, 'pm', '기존 오후 항목');
  await app.page.reload();
  await openToday();
  const rowSel = s => `[data-testid="memo-section-${s}"] [data-testid="personal-memo-row"]`;
  await editorPaste('DAY 메인 편집기', rowSel('main'), m.id, '기존 메인 항목', 'ko-M', { html: true, shot: 'lp-05-day-main-editor' });
  await editorPaste('DAY 오전 편집기', rowSel('am'), am.id, '기존 오전 항목', 'oneline-L');
  await editorPaste('DAY 오후 편집기', rowSel('pm'), pm.id, '기존 오후 항목', 'ko-XL', { shot: 'lp-06-day-pm-editor-XL' });
});

step('upcoming', async () => {
  const d7 = plusDays(today, 7);
  const u = await create({ kind: 'day', date: d7 }, 'main', '다가오는 날 기존 항목');
  await app.page.reload();
  await openToday();
  const card = app.page.locator(`[data-testid="upcoming-card-${d7}"]`);
  await card.waitFor();
  const input = card.locator('[data-testid="upcoming-group-am"] [data-testid="personal-memo-quick-input"]');
  await quickPaste('다가오는 같은 요일 입력칸', input, 'structured-M', 'lp-07-upcoming-quick');
  await editorPaste(
    '다가오는 같은 요일 편집기',
    `[data-testid="upcoming-card-${d7}"] [data-testid="personal-memo-row"]`,
    u.id,
    '다가오는 날 기존 항목',
    'ko-M',
    { shot: 'lp-08-upcoming-editor' },
  );
});

step('screen-switch', async () => {
  // 다른 화면에 갔다가 돌아와 읽기 화면에서 전체 내용·마지막 문장 확인
  await toWeek();
  await openNext();
  for (const [id, info] of items) {
    if (!info.target.startsWith('Next') || info.target.startsWith('Next List')) continue;
    const row = app.page.locator(`[data-testid="memo-section-next"] [data-testid="personal-memo-row"][data-memo-id="${id}"]`);
    must(record(info.target, info.fx, '화면 전환 후(읽기 화면)', await row.innerText(), info.expect));
    const reach = await markerReachable(row, END_MARKER);
    assert.ok(reach.inViewport && reach.hitInside, `읽기 화면에서 마지막 문장까지 스크롤해 볼 수 있다 ${JSON.stringify(reach)}`);
  }
  await app.shot('lp-09-next-after-switch-end');
});

step('save-failure', async () => {
  await openNext();
  const rowSel = '[data-testid="memo-section-next"] [data-testid="personal-memo-row"]';
  const [id, info] = [...items].find(([, v]) => v.fx === 'ko-L+수정');
  // 실제 저장 실패: 다른 프로세스(이 테스트)가 DB 쓰기 잠금을 쥐고 있다 → 앱의 쓰기는 5초 기다린 뒤 'database is locked'
  const lock = new DatabaseSync(dbFile);
  lock.exec('BEGIN EXCLUSIVE');
  const row = app.page.locator(`${rowSel}[data-memo-id="${id}"]`);
  await row.locator('[aria-label="메모 편집"]').click();
  await row.locator('[contenteditable="true"]').waitFor();
  await app.page.keyboard.press('Control+End');
  await app.page.keyboard.type(' [FAIL-THEN-RETRY]');
  await row.locator('[data-testid="personal-memo-save-status"]').waitFor({ timeout: 20000 });
  const failText = await row.locator('[data-testid="personal-memo-save-status"]').innerText();
  assert.match(failText, /다시 시도/);
  console.log(`   (저장 실패 표시: ${failText.replace(/\s+/g, ' ')})`);
  await clickOutside();
  // 화면을 바꿔도 미저장 초안이 남는다
  await toWeek();
  await openNext();
  const again = app.page.locator(`${rowSel}[data-memo-id="${id}"]`);
  const kept = await again.innerText();
  assert.ok(kept.includes('[FAIL-THEN-RETRY]') && kept.includes(END_MARKER), '저장 실패 초안이 화면 전환 뒤에도 그대로');
  assert.ok(!dbItem(id).content_html.includes('[FAIL-THEN-RETRY]'), 'DB 에는 아직 없다(실패)');
  // QuickInput: 새 메모 저장 실패 → 입력칸에 그대로 되돌아온다
  const input = app.page.locator('[data-testid="memo-section-next"] [data-testid="personal-memo-quick-input"]');
  clip(FX['ko-M']);
  await input.click();
  await app.page.keyboard.press('Control+V');
  await settled(() => input.inputValue());
  await clickOutside();
  const restored = await waitFor(async () => ((await input.inputValue()).length ? input.inputValue() : null), '실패한 새 메모가 입력칸에 되돌아옴');
  assert.equal(restored, FX['ko-M'].replace(/\s+$/, ''), '실패해도 입력한 장문을 잃지 않는다');
  await app.shot('lp-10-save-failure');
  // 복구(잠금 해제) → 다시 시도
  lock.exec('ROLLBACK');
  lock.close();
  await again.locator('[data-testid="personal-memo-save-status"] button').click();
  await waitFor(() => dbItem(id).content_html.includes('[FAIL-THEN-RETRY]'), '다시 시도 → 저장');
  const expected = info.expect.replace(/$/, ' [FAIL-THEN-RETRY]');
  must(record('Next 편집기', 'ko-L+재시도', 'SQLite(다시 시도)', await htmlToText(dbItem(id).content_html), expected));
  items.set(id, { ...info, fx: 'ko-L+재시도', expect: expected });
  await input.click();
  await clickOutside();
  const retried = await waitFor(() => dbFindNew(quickHtml(FX['ko-M'])), '실패했던 새 메모를 다시 저장');
  must(record('Next 입력칸', 'ko-M(실패 후)', 'SQLite(다시 저장)', await htmlToText(retried.content_html), FX['ko-M']));
  items.set(retried.id, { target: 'Next 입력칸', fx: 'ko-M(실패 후)', expect: FX['ko-M'] });

  // 저장 한도(2MB)를 넘는 장문: 잘라 저장하지 않고 분명히 안내 + 입력칸에 전부 남긴다
  const huge = `[FIRST-huge] ${'가나다라마바사아자차 '.repeat(80000)}${END_MARKER}`;
  clip(huge);
  await input.click();
  await app.page.keyboard.press('Control+V');
  assert.equal(await settled(() => input.inputValue()), huge, '2MB 넘는 장문도 입력칸에는 전부 들어간다');
  await clickOutside();
  const notice = app.page.locator('.MuiSnackbar-root', { hasText: '2MB' });
  await notice.waitFor({ timeout: 20000 });
  const noticeText = await notice.innerText();
  assert.match(noticeText, /2MB/, '한도 초과를 분명히 안내');
  const back = await waitFor(async () => ((await input.inputValue()).length ? input.inputValue() : null), '한도 초과 장문이 입력칸에 되돌아옴');
  assert.equal(back, huge, '한도를 넘어도 한 글자도 버리지 않는다');
  assert.equal(dbFindMarker('[FIRST-huge]'), undefined, '잘린 채로 저장된 것이 없다');
  console.log(`   (2MB 초과 ${[...huge].length}자 / ${Buffer.byteLength(huge)}바이트 → 안내: ${noticeText.replace(/\s+/g, ' ')})`);
  await app.shot('lp-10b-over-limit');
  await input.click();
  await app.page.keyboard.press('Control+A');
  await app.page.keyboard.press('Delete');
  await clickOutside();
});

step('sync-mock', async () => {
  if (!isMockRun()) return console.log('   (실제 서버 모드 — 건너뜀)');
  await openNext();
  await app.page.click('[data-testid="sync-link-button"]');
  await app.page.waitForSelector('[data-testid="account-dialog"]');
  await app.page.click('[data-testid="account-connect"]');
  await waitFor(async () => (await app.invoke('auth_status')).loggedIn, '로그인(Mock)');
  // (a) 기본 Next 는 이 시험의 장문들로 문서 전체가 2MB(계약 한도)를 넘는다 → 잘라 보내지 않고 분명한 오류, 로컬 그대로
  const nextBytes = sql("SELECT SUM(length(CAST(i.content_html AS BLOB))) n FROM memo_items i JOIN documents d ON d.id = i.document_id WHERE d.kind = 'NEXT_LIST' AND i.deleted_at IS NULL")[0].n;
  const big = await waitFor(async () => {
    const l = await app.invoke('memo_list', { listId: null });
    return l.list.document?.syncError || l.list.document?.syncStatus === 'synced' ? l.list.document : null;
  }, '기본 Next 연결 후 첫 Sync 결과', 40000);
  console.log(`   (기본 Next ${nextBytes}바이트 → ${big.syncStatus}: ${big.syncError ?? '오류 없음'})`);
  if (nextBytes > 2_000_000) assert.match(big.syncError ?? '', /최대 크기|2MB/, '2MB 를 넘는 문서는 분명한 오류(잘라 보내지 않음)');
  for (const [id, info] of items) {
    if (!info.target.startsWith('Next') || info.target.startsWith('Next List')) continue;
    must(record(info.target, info.fx, 'Sync 한도 초과 후 SQLite', await htmlToText(dbItem(id).content_html), info.expect));
  }
  // (b) 한도 안의 장문 List: Ctrl+V → 연결 → 서버까지 → Web 변경을 받아도 장문 그대로
  const list = await app.invoke('list_create', { id: crypto.randomUUID(), name: '장문 Sync' });
  await app.page.reload();
  await openNext();
  await app.page.locator('[data-testid="memo-next-list-tab"]', { hasText: '장문 Sync' }).click();
  await app.page.waitForSelector('[data-testid="memo-section-next"]');
  const input = app.page.locator('[data-testid="memo-section-next"] [data-testid="personal-memo-quick-input"]');
  const id = await quickPaste('Next List(연결)', input, 'ko-L');
  await app.invoke('sync_link', { location: { kind: 'next', listId: list.id } });
  await app.invoke('sync_now');
  const synced = await waitFor(async () => {
    const l = await app.invoke('memo_list', { listId: list.id });
    return l.list.document?.syncStatus === 'synced' || l.list.document?.syncError ? l.list.document : null;
  }, '장문 List Sync', 40000);
  assert.equal(synced.syncStatus, 'synced', `장문 List synced (오류: ${synced.syncError ?? '없음'})`);
  await app.invoke('mock_remote_edit', { location: { kind: 'next', listId: list.id }, text: 'Web 에서 추가' });
  await app.invoke('sync_now');
  const after = await waitFor(async () => {
    const l = await app.invoke('memo_list', { listId: list.id });
    return l.items.length === 2 ? l : null;
  }, 'Web 변경 받기');
  must(record('Next List(연결)', 'ko-L', 'Sync(Mock) 왕복 후 SQLite', await htmlToText(dbItem(id).content_html), FX['ko-L']));
  assert.ok(after.items.some(i => i.contentHtml.includes('Web 에서 추가')));
});

step('restart', async () => {
  // 정상 종료(창 닫기 → 남은 입력 저장 → 종료) 후 재실행
  await app.page.locator('[data-testid="window-title-bar"] [aria-label="닫기"]').click();
  await waitFor(() => app.proc.exitCode !== null || null, '앱 종료', 20000);
  try {
    await app.browser?.close();
  } catch {
    /* 이미 끊김 */
  }
  app.page = undefined;
  await sleep(1000);
  await app.start();
  await app.page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  for (const [id, info] of items) {
    const r = dbItem(id);
    assert.ok(r, `${info.target}/${info.fx}: 재실행 후 항목이 있다`);
    must(record(info.target, info.fx, '재실행 후 SQLite', await htmlToText(r.content_html), info.expect));
  }
  await openNext();
  for (const [id, info] of items) {
    if (!info.target.startsWith('Next') || info.target.startsWith('Next List')) continue;
    const row = app.page.locator(`[data-testid="memo-section-next"] [data-testid="personal-memo-row"][data-memo-id="${id}"]`);
    must(record(info.target, info.fx, '재실행 후 화면', await row.innerText(), info.expect));
  }
  const [lastId] = [...items].find(([, v]) => v.fx === 'ko-XL');
  const last = app.page.locator(`[data-testid="personal-memo-row"][data-memo-id="${lastId}"]`);
  const reach = await markerReachable(last, END_MARKER);
  assert.ok(reach.inViewport && reach.hitInside, '재실행 후에도 마지막 문장까지 스크롤');
  await app.shot('lp-11-after-restart-end');
});

// ────────────────────────────────────────────────────────────────────
let failed = 0;
const restoreWindowState = isolateWindowState();
backupClipboard();
clearE2eCredential();
try {
  await app.start();
  for (const s of steps) {
    if (s.name !== 'setup' && only.length && !only.some(o => s.name.includes(o))) continue;
    const started = Date.now();
    console.log(`▶ ${s.name}`);
    try {
      await s.fn();
      console.log(`✔ ${s.name} (${Date.now() - started}ms)`);
    } catch (error) {
      failed++;
      console.log(`✘ ${s.name}: ${error.message}`);
      if (app.consoleErrors.length) console.log(`  console.error:\n  ${app.consoleErrors.slice(-5).join('\n  ')}`);
      await app.shot(`FAILED-lp-${s.name}`).catch(() => undefined);
      break;
    }
  }
} finally {
  writeFileSync(path.join(app.shotDir, 'long-paste-report.json'), JSON.stringify({ today, rows }, null, 2));
  await app.kill();
  app.cleanup();
  clearE2eCredential();
  restoreWindowState();
  restoreClipboard();
}
console.log(failed ? `긴 붙여넣기 E2E 실패 ${failed}` : '긴 붙여넣기 E2E 통과');
process.exit(failed ? 1 : 0);
