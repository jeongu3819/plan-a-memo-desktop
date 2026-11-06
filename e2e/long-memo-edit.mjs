// 긴 메모 표시·제자리 편집 E2E — 실제 앱에서 카드가 본문 끝까지 감싸는지, 누른 자리에서 바로 편집되는지 잰다.
//   npm run e2e:build
//   node e2e/long-memo-edit.mjs              (측정 + 판정)
//   node e2e/long-memo-edit.mjs --baseline   (판정 없이 측정만 — 변경 전 기록용, 스크린샷 앞에 before-)
// 결과: e2e/output/long-memo-edit-report.json, e2e/output/long-edit-*.png
// 격리: harness 의 임시 설정·임시 저장 위치, Mock 서버. 메모는 모두 더미 글이다.
//
// 확인하는 것(Next 기본 · 이름 있는 List · DAY 메인/오전/오후 · 다가오는 요일 카드):
//   · 카드(배경·테두리)가 마지막 줄·입력칸까지 감싼다 — 글만 카드 밖으로 나오지 않는다.
//   · 본문 중간·마지막 문장을 누르면 그 글자 자리에 커서, 스크롤·카드 높이·글 위치가 그대로(읽기 = 편집 배치).
//   · 편집기 안에 따로 스크롤이 생기지 않는다(max-height 없음) — 휠은 화면 스크롤로 간다.
//   · 편집 시작·끝을 반복해도 높이·스크롤이 흔들리지 않는다. 편집만 열고 닫으면 저장되지 않는다.
//   · 끝에 긴 글 넣기·창 크기 변경·재실행 후 내용.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { App, clearE2eCredential, isolateWindowState } from './harness.mjs';

const baseline = process.argv.includes('--baseline');
const prefix = baseline ? 'long-edit-before' : 'long-edit';
const app = new App();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = [];
const failures = [];
const TOL = 1.5;

const plusDays = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** 여러 문단·굵게·색·목록이 섞인 더미 긴 글. 가운데에 MID 표식, 끝에 END 표식. */
function longHtml(chars, tag) {
  const parts = [];
  let size = 0;
  let n = 0;
  const midAt = Math.floor(chars / 2);
  let midDone = false;
  while (size < chars) {
    n += 1;
    let block;
    if (!midDone && size >= midAt) {
      block = `<p>${tag}MID 가운데 문장입니다. 이 줄을 눌러 바로 고칠 수 있어야 합니다.</p>`;
      midDone = true;
    } else if (n % 9 === 0) {
      block = `<ul><li>${tag} 목록 ${n}-1 항목입니다</li><li>${tag} 목록 ${n}-2 <b>굵은 글</b> 항목</li></ul>`;
    } else if (n % 5 === 0) {
      block = `<p><span style="color: rgb(220, 38, 38);">${tag} 색 문단 ${n}</span> — 긴 메모 본문입니다. 내용이 많아도 카드가 끝까지 감싸야 합니다.</p>`;
    } else {
      block = `<p>${tag} 문단 ${n}: 긴 메모 본문입니다. <b>굵게</b>와 <u>밑줄</u>이 섞인 줄이 계속 이어집니다.</p>`;
    }
    parts.push(block);
    size += block.replace(/<[^>]+>/g, '').length;
  }
  parts.push(`<p>${tag}END 마지막 문장입니다.</p>`);
  return parts.join('');
}

const check = (condition, label, detail) => {
  const ok = !!condition;
  report.push({ check: label, ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(label);
};
const near = (a, b, tol = TOL) => Math.abs(a - b) <= tol;

function setWindow(pid, size) {
  const call = size
    ? `[void][PlanaE2e.Win]::ShowWindow($h, 9); [void][PlanaE2e.Win]::SetWindowPos($h, [IntPtr]::Zero, 40, 40, ${size.width}, ${size.height}, 0x0014)`
    : '[void][PlanaE2e.Win]::ShowWindow($h, 3)';
  const script =
    "Add-Type -Namespace PlanaE2e -Name Win -MemberDefinition '" +
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); ' +
    '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int t, uint f);' +
    "'; " +
    `$h = (Get-Process -Id ${pid}).MainWindowHandle; if ($h -eq [IntPtr]::Zero) { throw 'no window' }; ${call}`;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe' });
}
async function resizeWindow(size) {
  const page = app.page;
  const before = await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`);
  setWindow(app.proc.pid, size);
  for (let i = 0; i < 12 && (await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)) === before; i++) await sleep(150);
  await sleep(400);
}

async function toWeek() {
  await app.page.reload();
  await app.page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
}
async function openNext(listId = null) {
  await toWeek();
  await app.page.click('[data-testid="memo-cell-next"] button[aria-label$="메모 쓰기"]');
  await app.page.waitForSelector('[data-testid="memo-section-next"]');
  if (listId) {
    await app.page.locator(`[data-testid="memo-next-list-tab"][data-list-id="${listId}"]`).click();
    await sleep(300);
  }
  await app.page.locator('[data-testid="memo-header-date"]').click(); // 입력칸 자동 포커스를 푼다
  await sleep(300);
}
async function openDate(date) {
  await toWeek();
  execFileSync('cmd', ['/c', 'start', '', `plana-memo-dev://open?date=${date}`], { stdio: 'ignore' });
  await app.page.locator(`[data-testid="upcoming-card-${plusDays(date, 7)}"]`).waitFor({ timeout: 20000 });
  await sleep(300);
}
const endEditing = async ({ escape = false } = {}) => {
  if (escape) await app.page.keyboard.press('Escape');
  else await app.page.locator('[data-testid="memo-header-date"]').click();
  await app.page.waitForFunction(() => !document.querySelector('[data-testid="personal-memo-row"] [contenteditable="true"]'));
  await sleep(250);
};

/** 화면 상태 — 스크롤 위치, 그 메모·카드의 위치·높이, 표식 글자의 화면 위치, 편집기 안 스크롤 여부. */
const state = (itemId, cardSel, marker) =>
  app.page.evaluate(
    ([id, sel, mark]) => {
      const row = document.querySelector(`[data-testid="personal-memo-row"][data-memo-id="${id}"]`);
      const card = sel ? row.closest(sel) : row;
      let scroller = row.parentElement;
      while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      let markTop = null;
      if (mark) {
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.data.indexOf(mark);
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + 1);
          markTop = range.getBoundingClientRect().top;
          break;
        }
      }
      const editable = row.querySelector('[contenteditable="true"]');
      const rowRect = row.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      // 카드 안의 모든 메모 줄·입력칸이 카드 테두리 안에 있는가(글만 밖으로 나오지 않는가)
      let overflowBottom = 0;
      card.querySelectorAll('[data-testid="personal-memo-row"], [data-drop-input]').forEach(el => {
        overflowBottom = Math.max(overflowBottom, el.getBoundingClientRect().bottom - cardRect.bottom);
      });
      const selection = getSelection();
      let caret = null;
      if (editable && selection.rangeCount && editable.contains(selection.anchorNode)) {
        const anchor = selection.anchorNode;
        const before = document.createRange();
        before.selectNodeContents(editable);
        before.setEnd(anchor, selection.anchorOffset);
        const text = before.toString();
        const rect = selection.getRangeAt(0).getClientRects()[0] || null;
        caret = { tail: text.slice(-12), length: text.length, top: rect ? rect.top : null };
      }
      return {
        scrollTop: scroller ? scroller.scrollTop : null,
        scrollerTop: scroller ? scroller.getBoundingClientRect().top : null,
        scrollerBottom: scroller ? scroller.getBoundingClientRect().bottom : null,
        rowTop: rowRect.top,
        rowHeight: rowRect.height,
        cardHeight: cardRect.height,
        overflowBottom,
        markTop,
        editing: !!editable,
        editorInnerScroll: editable ? editable.scrollHeight - editable.clientHeight : null,
        editorMaxHeight: editable ? getComputedStyle(editable).maxHeight : null,
        focused: !!editable && document.activeElement === editable,
        caret,
      };
    },
    [itemId, cardSel, marker],
  );

/** 읽기 화면의 표식 글자(mark 의 k 번째 글자) 왼쪽 가장자리를 화면 가운데로 옮기고 그 좌표를 돌려준다. */
const placeMark = (itemId, mark, k, block = 'center') =>
  app.page.evaluate(
    ([id, m, offset, where]) => {
      const row = document.querySelector(`[data-testid="personal-memo-row"][data-memo-id="${id}"]`);
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.data.indexOf(m);
        if (at < 0) continue;
        node.parentElement.scrollIntoView({ block: where });
        const range = document.createRange();
        range.setStart(node, at + offset);
        range.setEnd(node, at + offset + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + 1, y: rect.top + rect.height / 2 };
      }
      return null;
    },
    [itemId, mark, k, block],
  );

/**
 * 한 메모에서: 표식 자리를 눌러 편집 → 배치·스크롤·커서 확인 → 한 글자 입력 → 확인 → 편집 끝.
 * 반환: 편집 전후 상태(보고서용).
 */
async function clickEditAt(label, itemId, cardSel, mark, k, { block = 'center', type = '★' } = {}) {
  const page = app.page;
  const point = await placeMark(itemId, mark, k, block);
  await sleep(200);
  const before = await state(itemId, cardSel, mark);
  await page.mouse.click(point.x, point.y);
  await page.locator(`[data-testid="personal-memo-row"][data-memo-id="${itemId}"] [contenteditable="true"]`).waitFor();
  await sleep(350);
  const after = await state(itemId, cardSel, mark);
  const expectTail = mark.slice(0, k).slice(-12);
  check(near(after.scrollTop, before.scrollTop), `${label}: 편집 시작해도 스크롤 그대로`, { before: before.scrollTop, after: after.scrollTop });
  check(near(after.markTop, before.markTop), `${label}: 누른 글이 화면에서 그 자리`, { before: before.markTop, after: after.markTop });
  check(near(after.rowHeight, before.rowHeight, 2), `${label}: 메모 높이 그대로(읽기 = 편집)`, { before: before.rowHeight, after: after.rowHeight });
  check(after.editorInnerScroll !== null && after.editorInnerScroll <= 1, `${label}: 편집기 안 스크롤 없음`, { inner: after.editorInnerScroll, maxHeight: after.editorMaxHeight });
  check(after.focused && after.caret && after.caret.tail.endsWith(expectTail), `${label}: 누른 글자 자리에 커서`, { expect: expectTail, caret: after.caret });
  check(after.overflowBottom <= 1, `${label}: 편집 중에도 카드가 끝까지 감쌈`, { overflow: after.overflowBottom });
  let typed = null;
  if (type) {
    await page.keyboard.type(type);
    await sleep(200);
    typed = await state(itemId, cardSel, mark);
    check(typed.caret && typed.caret.tail.endsWith(type), `${label}: 입력이 그 자리에 들어감`, { caret: typed.caret });
    // 화면 맨 아래 줄에서 입력하면 브라우저가 커서를 다 보이게 몇 px 올릴 수 있다(한 줄 미만).
    const tol = block === 'end' ? 25 : TOL;
    check(near(typed.scrollTop, before.scrollTop, tol), `${label}: 입력해도 스크롤 그대로`, { before: before.scrollTop, after: typed.scrollTop });
  }
  return { before, after, typed };
}

/** 편집을 끝내도(바깥 누르기 또는 Esc) 읽던 위치·높이 그대로. */
async function endAndCheck(label, itemId, cardSel, opts) {
  const before = await state(itemId, cardSel, null);
  await endEditing(opts);
  const after = await state(itemId, cardSel, null);
  check(near(after.scrollTop, before.scrollTop) && near(after.rowHeight, before.rowHeight, 2), `${label}: 편집 끝 — 위치·높이 그대로`, {
    scroll: [before.scrollTop, after.scrollTop],
    height: [before.rowHeight, after.rowHeight],
  });
}

let failed = 0;
const restoreWindowState = isolateWindowState();
clearE2eCredential();
await app.start();
try {
  const page = app.page;
  const ready = await app.invoke('storage_initialize', { path: app.storeDir, createNew: true });
  assert.equal(ready.state, 'ready');
  const today = (await app.invoke('app_info')).today;
  await resizeWindow({ width: 1100, height: 816 });

  const create = (location, section, html) =>
    app.invoke('item_create', { input: { id: crypto.randomUUID(), location, section, kind: 'checklist', contentHtml: html } });
  const nextLoc = { kind: 'next', listId: null };
  // Next 기본: 짧은 메모 · 긴 메모(1.2만 자) · 짧은 메모 — 가운데 메모가 늘어나도 아래 메모·입력칸이 잘리거나 겹치지 않아야 한다
  await create(nextLoc, 'next', '<p>NX 짧은 메모 위</p>');
  const nextLong = await create(nextLoc, 'next', longHtml(12000, 'NX'));
  const nextBelow = await create(nextLoc, 'next', '<p>NXBELOW 아래 짧은 메모</p>');
  const list = await app.invoke('list_create', { id: crypto.randomUUID(), name: '긴 글 List' });
  const listLong = await create({ kind: 'next', listId: list.id }, 'next', longHtml(32000, 'LS'));
  const day = plusDays(today, 500);
  const dayLoc = { kind: 'day', date: day };
  const mainLong = await create(dayLoc, 'main', longHtml(6000, 'MN'));
  const amLong = await create(dayLoc, 'am', longHtml(3000, 'AM'));
  const pmLong = await create(dayLoc, 'pm', longHtml(3000, 'PM'));
  const upcomingLong = await create({ kind: 'day', date: plusDays(day, 7) }, 'main', longHtml(3000, 'UP'));
  const pastDay = plusDays(today, -30);
  const pastLong = await create({ kind: 'day', date: pastDay }, 'pm', longHtml(4000, 'PS'));

  const NEXT_CARD = '[data-testid="memo-section-next"]';
  const sectionCard = s => `[data-testid="memo-section-${s}"]`;

  // ── ① 긴 메모 표시: 카드가 끝까지 감싼다 ───────────────────────────
  console.log('\n[표시] 카드 배경');
  await openNext();
  let s = await state(nextLong.id, NEXT_CARD, null);
  check(s.overflowBottom <= 1, 'Next 기본: 긴 메모·아래 메모·입력칸이 카드 안', { overflow: Math.round(s.overflowBottom) });
  await page.evaluate(() => document.querySelector('[data-testid="memo-section-next"] [data-drop-input]').scrollIntoView({ block: 'end' }));
  await sleep(200);
  await app.shot(`${prefix}-next-bottom`);
  const belowRow = await page.evaluate(
    ([a, b]) => {
      const r = id => document.querySelector(`[data-testid="personal-memo-row"][data-memo-id="${id}"]`).getBoundingClientRect();
      return { longBottom: r(a).bottom, belowTop: r(b).top };
    },
    [nextLong.id, nextBelow.id],
  );
  check(belowRow.belowTop >= belowRow.longBottom - 0.5, 'Next 기본: 아래 메모가 긴 메모와 겹치지 않음', belowRow);

  await openNext(list.id);
  s = await state(listLong.id, NEXT_CARD, null);
  check(s.overflowBottom <= 1, '이름 있는 List(3.2만 자): 카드 안', { overflow: Math.round(s.overflowBottom) });

  await openDate(day);
  for (const [sec, item] of [['main', mainLong], ['am', amLong], ['pm', pmLong]]) {
    s = await state(item.id, sectionCard(sec), null);
    check(s.overflowBottom <= 1, `DAY ${sec}: 카드 안`, { overflow: Math.round(s.overflowBottom) });
  }

  // ── ② 누른 자리에서 바로 편집 ───────────────────────────────────
  console.log('\n[편집] Next 기본 — 가운데 문장');
  await openNext();
  const nxMid = await clickEditAt('Next 가운데', nextLong.id, NEXT_CARD, 'NXMID 가운데 문장', 9);
  await app.shot(`${prefix}-next-mid-editing`);
  report.push({ scenario: 'next-mid', ...nxMid });
  // 휠: 편집기 위에서 굴려도 화면이 내려간다(편집기 안 스크롤과 다투지 않는다)
  {
    const st0 = await state(nextLong.id, NEXT_CARD, null);
    const box = await page.locator(`[data-memo-id="${nextLong.id}"] [contenteditable="true"]`).boundingBox();
    await page.mouse.move(box.x + box.width / 2, Math.min(box.y + box.height - 20, 500));
    await page.mouse.wheel(0, 400);
    await sleep(400);
    const st1 = await state(nextLong.id, NEXT_CARD, null);
    check(st1.scrollTop - st0.scrollTop > 200, 'Next 편집 중 휠 → 화면 스크롤', { before: st0.scrollTop, after: st1.scrollTop });
  }
  // 드래그 선택(편집 중): 두 줄에 걸쳐 끌면 선택된다
  {
    const p1 = await placeMark(nextLong.id, 'NXEND 마지막', 0, 'center');
    await page.mouse.move(p1.x, p1.y);
    await page.mouse.down();
    await page.mouse.move(p1.x + 60, p1.y - 60, { steps: 6 });
    await page.mouse.up();
    const selected = await page.evaluate(() => getSelection().toString().length);
    check(selected > 0, 'Next 편집 중 드래그 선택', { selected });
  }
  const nxBeforeEnd = await state(nextLong.id, NEXT_CARD, null);
  await endEditing();
  const nxAfterEnd = await state(nextLong.id, NEXT_CARD, null);
  check(near(nxAfterEnd.scrollTop, nxBeforeEnd.scrollTop), 'Next 편집 끝: 읽던 위치 그대로', { before: nxBeforeEnd.scrollTop, after: nxAfterEnd.scrollTop });
  check(near(nxAfterEnd.rowHeight, nxBeforeEnd.rowHeight, 2), 'Next 편집 끝: 메모 높이 그대로', { before: nxBeforeEnd.rowHeight, after: nxAfterEnd.rowHeight });

  console.log('\n[편집] Next 기본 — 마지막 문장');
  const nxEnd = await clickEditAt('Next 마지막', nextLong.id, NEXT_CARD, 'NXEND 마지막 문장', 6, { block: 'end' });
  // 끝에 긴 글 넣기 — 카드가 따라 늘고 커서가 화면 안에 보인다
  await page.keyboard.press('Control+End');
  const pasted = Array.from({ length: 120 }, (_, n) => `붙여넣은 줄 ${n + 1} — 긴 글 넣기 시험`).join(' ') + ' PASTE-끝';
  await page.keyboard.insertText(pasted);
  await sleep(400);
  const afterPaste = await state(nextLong.id, NEXT_CARD, null);
  check(afterPaste.overflowBottom <= 1, 'Next 긴 글 넣기: 카드가 따라 늚', { overflow: afterPaste.overflowBottom });
  check(afterPaste.editorInnerScroll <= 1, 'Next 긴 글 넣기: 편집기 안 스크롤 없음', { inner: afterPaste.editorInnerScroll });
  check(
    afterPaste.caret && afterPaste.caret.top !== null && afterPaste.caret.top >= afterPaste.scrollerTop - 1 && afterPaste.caret.top <= afterPaste.scrollerBottom + 1,
    'Next 긴 글 넣기: 커서가 화면 안',
    { caretTop: afterPaste.caret?.top, view: [afterPaste.scrollerTop, afterPaste.scrollerBottom] },
  );
  report.push({ scenario: 'next-end', ...nxEnd, afterPaste });
  await endEditing();
  await sleep(1500); // 자동 저장
  const savedNext = (await app.invoke('memo_list', { listId: null })).items.find(i => i.id === nextLong.id);
  check(savedNext.contentHtml.includes('NXMID 가운데★ 문장'), 'Next 가운데 입력 저장', savedNext.contentHtml.match(/NXMID.{0,8}/)?.[0]);
  check(savedNext.contentHtml.includes('PASTE-끝'), 'Next 긴 글 저장(끝 표식)');

  // 편집 열고 닫기만 반복 — 높이·스크롤이 흔들리지 않고 저장되지 않는다
  console.log('\n[반복] 편집 시작·끝 10회(바깥 누르기 · Esc)');
  {
    const p = await placeMark(nextLong.id, 'NXMID', 2, 'center');
    await sleep(200);
    const first = await state(nextLong.id, NEXT_CARD, null);
    const stamp = savedNext.updatedAt;
    const heights = [];
    for (let i = 0; i < 10; i++) {
      await page.mouse.click(p.x, p.y);
      await page.locator(`[data-memo-id="${nextLong.id}"] [contenteditable="true"]`).waitFor();
      await sleep(120);
      const e = await state(nextLong.id, NEXT_CARD, null);
      await endEditing({ escape: i % 2 === 1 }); // 바깥 누르기 · Esc 번갈아
      const r = await state(nextLong.id, NEXT_CARD, null);
      heights.push([Math.round(e.rowHeight * 10) / 10, Math.round(r.rowHeight * 10) / 10, r.scrollTop]);
    }
    await sleep(1500);
    const last = await state(nextLong.id, NEXT_CARD, null);
    check(heights.every(([e, r, top]) => near(e, first.rowHeight, 2) && near(r, first.rowHeight, 2) && near(top, first.scrollTop)), '반복해도 높이·스크롤 그대로', { first: [first.rowHeight, first.scrollTop], heights });
    check(near(last.scrollTop, first.scrollTop), '반복 후 읽던 위치 그대로');
    const again = (await app.invoke('memo_list', { listId: null })).items.find(i => i.id === nextLong.id);
    check(again.updatedAt === stamp && again.contentHtml === savedNext.contentHtml, '편집 열고 닫기만 하면 저장 없음', { before: stamp, after: again.updatedAt });
  }

  console.log('\n[편집] 이름 있는 List — 3.2만 자');
  await openNext(list.id);
  const t0 = Date.now();
  const lsMid = await clickEditAt('List 가운데(3.2만 자)', listLong.id, NEXT_CARD, 'LSMID 가운데 문장', 5, { type: null });
  const enterMs = Date.now() - t0;
  const typeStart = Date.now();
  await page.keyboard.type('빠르게입력');
  const typeMs = Date.now() - typeStart;
  check(true, 'List 3.2만 자 편집 반응', { clickToEditMs: enterMs, type5CharsMs: typeMs });
  report.push({ scenario: 'list-mid', ...lsMid, enterMs, typeMs });
  await endEditing();

  console.log('\n[편집] DAY 메인·오전·오후');
  await openDate(day);
  for (const [sec, item, tag] of [['main', mainLong, 'MN'], ['am', amLong, 'AM'], ['pm', pmLong, 'PM']]) {
    const r = await clickEditAt(`DAY ${sec} 가운데`, item.id, sectionCard(sec), `${tag}MID 가운데 문장`, 7);
    report.push({ scenario: `day-${sec}-mid`, ...r });
    if (sec === 'am') await app.shot(`${prefix}-day-am-editing`);
    await endAndCheck(`DAY ${sec} 가운데`, item.id, sectionCard(sec));
    const r2 = await clickEditAt(`DAY ${sec} 마지막`, item.id, sectionCard(sec), `${tag}END 마지막 문장`, 4, { block: 'end' });
    report.push({ scenario: `day-${sec}-end`, ...r2 });
    await endAndCheck(`DAY ${sec} 마지막(Esc)`, item.id, sectionCard(sec), { escape: true });
  }

  console.log('\n[편집] 지난 날짜 · 다가오는 요일 카드');
  await openDate(pastDay);
  const ps = await clickEditAt('지난 날짜 오후 가운데', pastLong.id, sectionCard('pm'), 'PSMID 가운데 문장', 3);
  report.push({ scenario: 'past-pm-mid', ...ps });
  await endAndCheck('지난 날짜 오후', pastLong.id, sectionCard('pm'), { escape: true });
  await openDate(day);
  {
    const cardSel = `[data-testid="upcoming-card-${plusDays(day, 7)}"]`;
    const row = page.locator(`${cardSel} [data-testid="personal-memo-row"][data-memo-id="${upcomingLong.id}"]`);
    await row.scrollIntoViewIfNeeded();
    await row.locator('[aria-label="메모 편집"]').click();
    await row.locator('[contenteditable="true"]').waitFor();
    await sleep(300);
    const up = await state(upcomingLong.id, cardSel, null);
    check(up.editorInnerScroll <= 1, '다가오는 요일 카드 편집: 편집기 안 스크롤 없음', { inner: up.editorInnerScroll, maxHeight: up.editorMaxHeight });
    check(up.overflowBottom <= 1, '다가오는 요일 카드 편집: 카드가 끝까지 감쌈', { overflow: up.overflowBottom });
    await app.shot(`${prefix}-upcoming-editing`);
    await endEditing();
  }

  // ── 창 크기 변경(편집 중) ────────────────────────────────────────
  console.log('\n[창 크기]');
  await openNext();
  await clickEditAt('창 크기 전 Next 가운데', nextLong.id, NEXT_CARD, 'NXMID', 1, { type: null });
  for (const size of [{ width: 850, height: 656 }, null, { width: 1100, height: 816 }]) {
    await resizeWindow(size);
    const w = await state(nextLong.id, NEXT_CARD, null);
    const name = size ? `${size.width}x${size.height}` : 'maximized';
    check(w.overflowBottom <= 1 && w.editorInnerScroll <= 1 && w.editing, `창 ${name}: 편집 유지·카드 안·안쪽 스크롤 없음`, { overflow: w.overflowBottom, inner: w.editorInnerScroll });
    if (size?.width === 850) await app.shot(`${prefix}-min-window-editing`);
  }
  await endEditing();

  // ── 재실행 ────────────────────────────────────────────────────
  console.log('\n[재실행]');
  await sleep(1200);
  await app.restart();
  await app.page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  const reopened = (await app.invoke('memo_list', { listId: null })).items.find(i => i.id === nextLong.id);
  check(reopened.contentHtml === savedNext.contentHtml, '재실행 후 내용·서식 그대로');
  await openNext();
  s = await state(nextLong.id, NEXT_CARD, null);
  check(s.overflowBottom <= 1, '재실행 후 Next 카드 안', { overflow: s.overflowBottom });

  check(!app.consoleErrors.length, '콘솔 오류 없음', app.consoleErrors.slice(-3));
  console.log(baseline ? `\n측정 완료(판정 없음) — 기준 위반 ${failures.length}건` : failures.length ? `\n✘ 실패 ${failures.length}건` : '\nE2E 통과');
  if (!baseline && failures.length) failed = 1;
} catch (error) {
  failed = 1;
  console.log(`✘ ${error.stack || error.message}`);
  await app.shot(`${prefix}-FAILED`).catch(() => undefined);
} finally {
  writeFileSync(path.join(app.shotDir, baseline ? 'long-memo-edit-before.json' : 'long-memo-edit-report.json'), JSON.stringify(report, null, 2));
  await app.kill();
  app.cleanup();
  clearE2eCredential();
  restoreWindowState();
}
process.exit(failed);
