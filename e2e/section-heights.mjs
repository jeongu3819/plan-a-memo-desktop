// 날짜 상세 메인·오전·오후 높이 E2E — 실제 앱 · 실제 Windows 창 크기(기본·최소·최대화)에서 입력칸·카드 높이를 잰다.
//   npm run e2e:build
//   node e2e/section-heights.mjs              (측정 + 판정)
//   node e2e/section-heights.mjs --baseline   (판정 없이 측정만 — 변경 전 기록용, 스크린샷 앞에 before-)
// 결과: e2e/output/section-heights-report.json, e2e/output/heights-*.png
// 격리: harness 의 임시 설정·임시 저장 위치, Mock 서버.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { App, clearE2eCredential, isolateWindowState } from './harness.mjs';

const baseline = process.argv.includes('--baseline');
const prefix = baseline ? 'heights-before' : 'heights';
const app = new App();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rows = [];
const SECTIONS = ['main', 'am', 'pm'];
const TOLERANCE = 1.5;

const plusDays = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const addItem = (date, section, html) =>
  app.invoke('item_create', { input: { id: crypto.randomUUID(), location: { kind: 'day', date }, section, kind: 'checklist', contentHtml: html } });
/** 약 chars 자의 여러 줄 글 — 마지막 줄의 표식까지 화면에 있어야 한다. */
const longHtml = (chars, marker) => {
  const line = `${marker} 긴 메모 본문입니다 — 내용이 많아도 이 구역만 자라야 합니다.`;
  const count = Math.ceil(chars / line.length);
  return [...Array.from({ length: count }, (_, n) => `${n + 1}. ${line}`), `${marker}-끝`].join('<br>');
};

/** 실제 창 조작(Win32) — 뷰포트 흉내가 아니라 창 자체의 크기를 바꾼다. size 가 없으면 최대화. */
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

async function applyWindow(win) {
  const page = app.page;
  const before = await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`);
  if (win.os !== undefined) setWindow(app.proc.pid, win.os);
  if (win.os !== undefined) {
    // 이미 그 크기면 바뀌지 않는다 — 잠깐 기다리고 지나간다.
    for (let i = 0; i < 12 && (await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)) === before; i++) await sleep(150);
  }
  await sleep(350);
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
}

async function openDate(date) {
  const page = app.page;
  await page.reload();
  await page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  execFileSync('cmd', ['/c', 'start', '', `plana-memo-dev://open?date=${date}`], { stdio: 'ignore' });
  await page.locator(`[data-testid="upcoming-card-${plusDays(date, 7)}"]`).waitFor({ timeout: 20000 });
  await sleep(250);
}

const measure = () =>
  app.page.evaluate(sections => {
    const out = { viewport: `${window.innerWidth}x${window.innerHeight}` };
    for (const section of sections) {
      const card = document.querySelector(`[data-testid="memo-section-${section}"]`);
      const input = card.querySelector('.MuiInputBase-root');
      out[section] = {
        card: Math.round(card.getBoundingClientRect().height * 10) / 10,
        input: Math.round(input.getBoundingClientRect().height * 10) / 10,
        rows: card.querySelectorAll('[data-testid="personal-memo-row"]').length,
      };
    }
    const upcoming = document.querySelector('[data-testid="upcoming-weekday"]');
    const scroller = (() => {
      let el = upcoming.parentElement;
      while (el && getComputedStyle(el).overflowY !== 'auto') el = el.parentElement;
      return el;
    })();
    out.upcomingTop = Math.round(upcoming.getBoundingClientRect().top);
    out.scrollHeight = scroller.scrollHeight;
    out.clientHeight = scroller.clientHeight;
    return out;
  }, SECTIONS);

const near = (actual, expected, label) => {
  if (!baseline) assert.ok(Math.abs(actual - expected) <= TOLERANCE, `${label}: ${actual} (기대 ${expected})`);
};
const check = (condition, label) => {
  if (!baseline) assert.ok(condition, label);
};

/** 표식이 잘리지 않고 그 구역 안에 끝까지 그려졌는가(스크롤해서 보면 보인다). */
const assertShownToEnd = async (section, marker) => {
  const shown = await app.page.evaluate(
    ([s, m]) => {
      const card = document.querySelector(`[data-testid="memo-section-${s}"]`);
      const cardRect = card.getBoundingClientRect();
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.textContent.includes(m)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        let clipped = false;
        for (let el = node.parentElement; el && el !== card; el = el.parentElement) {
          const style = getComputedStyle(el);
          if (style.overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 1) clipped = true;
        }
        return { inCard: rect.bottom <= cardRect.bottom + 1, clipped };
      }
      return null;
    },
    [section, marker],
  );
  check(shown?.inCard && !shown.clipped, `${section} 구역의 ${marker} 표시: ${JSON.stringify(shown)}`);
};

let failed = 0;
const restoreWindowState = isolateWindowState();
clearE2eCredential();
await app.start();
try {
  const page = app.page;
  const ready = await app.invoke('storage_initialize', { path: app.storeDir, createNew: true });
  assert.equal(ready.state, 'ready');
  const today = (await app.invoke('app_info')).today;
  await page.reload();
  await page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });

  // 시나리오별 날짜(겹치지 않게 먼 날짜)
  const date = n => plusDays(today, 400 + n * 7);
  const dates = { empty: date(0), mainLong: date(1), mainHuge: date(2), amLong: date(3), pmLong: date(4), allShort: date(5), allLong: date(6), oneShort: date(7) };
  await addItem(dates.mainLong, 'main', longHtml(3000, 'MAIN3K'));
  await addItem(dates.mainHuge, 'main', longHtml(30000, 'MAIN30K'));
  await addItem(dates.amLong, 'am', longHtml(6000, 'AM6K'));
  await addItem(dates.pmLong, 'pm', longHtml(6000, 'PM6K'));
  for (const s of SECTIONS) await addItem(dates.allShort, s, `${s} 짧은 메모`);
  await addItem(dates.allLong, 'main', longHtml(3000, 'ALLMAIN'));
  await addItem(dates.allLong, 'am', longHtml(1200, 'ALLAM'));
  await addItem(dates.allLong, 'pm', longHtml(2400, 'ALLPM'));
  await addItem(dates.oneShort, 'main', '메인에 짧은 메모 하나');

  const windows = [
    { name: 'default', os: { width: 1100, height: 816 } },
    { name: 'minimum', os: { width: 850, height: 656 } },
    { name: 'maximized', os: null },
    { name: 'tall', os: { width: 1100, height: 1000 } },
    { name: 'default-again', os: { width: 1100, height: 816 } },
  ];

  const scenarios = [
    ['A-empty', dates.empty],
    ['B-main-3k', dates.mainLong],
    ['B-main-30k', dates.mainHuge],
    ['C-am-long', dates.amLong],
    ['D-pm-long', dates.pmLong],
    ['E-all-short', dates.allShort],
    ['E-all-long', dates.allLong],
    ['main-one-short', dates.oneShort],
  ];

  // ── 창 크기 × 시나리오 ────────────────────────────────────────────
  const emptyBy = {};
  for (const win of windows) {
    const actual = await applyWindow(win);
    console.log(`\n[${win.name}] innerWindow ${actual.width}x${actual.height}`);
    for (const [name, target] of scenarios) {
      await openDate(target);
      const m = await measure();
      rows.push({ window: win.name, scenario: name, ...m });
      console.log(
        `${name.padEnd(15)} main ${String(m.main.input).padStart(7)}/${String(m.main.card).padStart(7)}  am ${String(m.am.input).padStart(7)}/${String(m.am.card).padStart(7)}  pm ${String(m.pm.input).padStart(7)}/${String(m.pm.card).padStart(7)}  (입력칸/카드) upcomingTop ${m.upcomingTop}`,
      );
      if (['default', 'minimum', 'maximized'].includes(win.name)) await app.shot(`${prefix}-${win.name}-${name}`);
      // 장문은 첫 화면에 메인만 보인다 — 오전·오후가 보이게 내려서도 찍는다
      if (win.name === 'default' && name === 'B-main-3k') {
        await page.evaluate(() => document.querySelector('[data-testid="memo-section-am"]').scrollIntoView({ block: 'start' }));
        await sleep(150);
        await app.shot(`${prefix}-default-B-main-3k-am-pm`);
      }

      if (name === 'A-empty') {
        emptyBy[win.name] = m;
        // 비어 있으면 첫 화면에 다음 구역의 시작이 보인다(큰 회색 칸이 화면을 다 차지하지 않는다)
        check(m.upcomingTop < actual.height, `${win.name}: 다가오는 요일이 첫 화면에 보임 (${m.upcomingTop} / ${actual.height})`);
        check(m.main.input > m.am.input, `${win.name}: 메인이 오전·오후보다 넉넉함`);
        near(m.am.input, m.pm.input, `${win.name}: 빈 오전=오후`);
      } else {
        const empty = emptyBy[win.name];
        if (name.startsWith('B-')) {
          near(m.am.input, empty.am.input, `${win.name} ${name}: 메인 장문 → 오전 입력칸 그대로`);
          near(m.pm.input, empty.pm.input, `${win.name} ${name}: 메인 장문 → 오후 입력칸 그대로`);
          near(m.am.card, empty.am.card, `${win.name} ${name}: 메인 장문 → 오전 카드 그대로`);
          near(m.pm.card, empty.pm.card, `${win.name} ${name}: 메인 장문 → 오후 카드 그대로`);
          check(m.main.card > empty.main.card, `${win.name} ${name}: 메인만 자람`);
        }
        if (name === 'C-am-long') {
          near(m.pm.input, empty.pm.input, `${win.name} C: 오전 장문 → 오후 입력칸 그대로`);
          near(m.main.input, empty.main.input, `${win.name} C: 오전 장문 → 메인 입력칸 그대로`);
          near(m.main.card, empty.main.card, `${win.name} C: 오전 장문 → 메인 카드 그대로`);
          check(m.am.card > empty.am.card, `${win.name} C: 오전 카드만 자람`);
          near(m.pm.card, m.am.card, `${win.name} C: 같은 줄 카드 외곽은 긴 쪽에 맞춤`);
        }
        if (name === 'D-pm-long') {
          near(m.am.input, empty.am.input, `${win.name} D: 오후 장문 → 오전 입력칸 그대로`);
          near(m.main.input, empty.main.input, `${win.name} D: 오후 장문 → 메인 입력칸 그대로`);
          near(m.main.card, empty.main.card, `${win.name} D: 오후 장문 → 메인 카드 그대로`);
          check(m.pm.card > empty.pm.card, `${win.name} D: 오후 카드만 자람`);
          near(m.am.card, m.pm.card, `${win.name} D: 같은 줄 카드 외곽은 긴 쪽에 맞춤`);
        }
        if (name === 'E-all-short' || name === 'main-one-short') {
          // 짧은 메모 한두 개로는 카드가 흔들리지 않는다(입력칸이 줄어 자리를 내준다)
          near(m.main.card, empty.main.card, `${win.name} ${name}: 메인 카드 그대로`);
          near(m.am.card, empty.am.card, `${win.name} ${name}: 오전 카드 그대로`);
          check(m.main.input < empty.main.input, `${win.name} ${name}: 메인 입력칸이 자리를 내줌`);
        }
        if (name === 'main-one-short') near(m.am.input, empty.am.input, `${win.name} ${name}: 오전 입력칸 그대로`);
        if (name === 'B-main-3k') await assertShownToEnd('main', 'MAIN3K-끝');
        if (name === 'B-main-30k') await assertShownToEnd('main', 'MAIN30K-끝');
        if (name === 'C-am-long') await assertShownToEnd('am', 'AM6K-끝');
        if (name === 'D-pm-long') await assertShownToEnd('pm', 'PM6K-끝');
        if (name === 'E-all-long') {
          await assertShownToEnd('main', 'ALLMAIN-끝');
          await assertShownToEnd('am', 'ALLAM-끝');
          await assertShownToEnd('pm', 'ALLPM-끝');
          near(m.am.input, m.pm.input, `${win.name} E: 짧은 쪽 입력칸이 카드에 끌려 늘지 않음`);
        }
      }
    }
  }
  // 창 크기를 오가도 값이 돌아온다(높이가 창 높이에 묶이지 않는다)
  if (!baseline) {
    for (const s of SECTIONS) {
      near(emptyBy.maximized[s].input, emptyBy.default[s].input, `최대화에서도 ${s} 입력칸 그대로`);
      near(emptyBy.tall[s].input, emptyBy.default[s].input, `키운 창에서도 ${s} 입력칸 그대로`);
      near(emptyBy['default-again'][s].input, emptyBy.default[s].input, `되돌린 창에서 ${s} 입력칸 복귀`);
    }
  }

  // ── 좁은 화면(최소 폭보다 좁은 WebView — 뷰포트 지정) ──────────────
  await page.setViewportSize({ width: 620, height: 560 });
  await openDate(dates.empty);
  const narrow = await measure();
  rows.push({ window: 'narrow-620(viewport)', scenario: 'A-empty', ...narrow });
  await app.shot(`${prefix}-narrow-A-empty`);
  await openDate(dates.mainHuge);
  const narrowLong = await measure();
  rows.push({ window: 'narrow-620(viewport)', scenario: 'B-main-30k', ...narrowLong });
  console.log(`\n[narrow-620] 빈 날짜 main/am/pm 입력칸 ${narrow.main.input}/${narrow.am.input}/${narrow.pm.input} · 메인 3만 자 am/pm ${narrowLong.am.input}/${narrowLong.pm.input}`);
  near(narrowLong.am.input, narrow.am.input, '좁은 창 메인 장문 → 오전 그대로');
  near(narrowLong.pm.input, narrow.pm.input, '좁은 창 메인 장문 → 오후 그대로');
  await page.setViewportSize({ width: 1084, height: 777 });

  // ── 입력 중: 입력칸에 긴 글(아직 저장 전) ──────────────────────────
  const typing = plusDays(today, 900);
  await openDate(typing);
  const base = await measure();
  const quick = s => page.locator(`[data-testid="memo-section-${s}"] [data-testid="personal-memo-quick-input"]`);
  const typedLong = Array.from({ length: 80 }, (_, n) => `입력 중 ${n}`).join('\n');

  // 메인 입력칸에 긴 글 → 메인만 자람
  await quick('main').fill(typedLong);
  await sleep(250);
  const mainTyped = await measure();
  rows.push({ window: 'default', scenario: 'typing-main', ...mainTyped });
  near(mainTyped.am.input, base.am.input, '메인 입력 중 → 오전 입력칸 그대로');
  near(mainTyped.pm.input, base.pm.input, '메인 입력 중 → 오후 입력칸 그대로');
  check(mainTyped.main.input > base.main.input, '메인 입력칸이 글만큼 자람');
  await quick('main').fill('');
  await sleep(250);
  const mainCleared = await measure();
  near(mainCleared.main.input, base.main.input, '글을 지우면 메인 입력칸 복귀');
  await quick('main').blur();

  // 오전 입력칸에 긴 글 → 오후 입력칸은 그대로, 외곽만 맞춤
  await quick('am').fill(typedLong);
  await sleep(250);
  const amTyped = await measure();
  rows.push({ window: 'default', scenario: 'typing-am', ...amTyped });
  near(amTyped.pm.input, base.pm.input, '오전 입력 중 → 오후 입력칸 그대로');
  near(amTyped.main.input, base.main.input, '오전 입력 중 → 메인 입력칸 그대로');
  near(amTyped.pm.card, amTyped.am.card, '오전 입력 중 → 카드 외곽 맞춤');
  await quick('am').fill('');
  await quick('am').blur();
  await sleep(250);

  // ── 커서·스크롤 ────────────────────────────────────────────────
  // 짧은 글을 쓰다가 같은 입력칸의 빈 회색 자리를 눌러도 저장(blur)되지 않고 계속 쓴다
  await quick('main').click();
  await page.keyboard.type('첫 줄');
  const box = await page.locator('[data-testid="memo-section-main"] .MuiInputBase-root').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 8);
  await page.keyboard.type(' 이어서');
  check((await quick('main').inputValue()) === '첫 줄 이어서', `빈 자리를 눌러도 이어 쓰기: ${await quick('main').inputValue()}`);
  check((await app.invoke('memo_day', { date: typing })).items.length === 0, '입력칸 안을 눌렀을 뿐이므로 저장되지 않음');
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="memo-section-main"] [data-testid="personal-memo-row"]').first().waitFor();
  const composed = (await app.invoke('memo_day', { date: typing })).items;
  check(composed.length === 1 && composed[0].contentHtml === '첫 줄 이어서', '한 메모로 저장');
  // 첫 메모가 생겨도 구역 높이가 그대로라 아래 구역이 튀지 않는다
  const afterFirst = await measure();
  near(afterFirst.main.card, base.main.card, '첫 메모 저장 후 메인 카드 그대로');

  // 빈 오후 입력칸의 아래쪽을 눌러도 입력된다
  const pmBox = await page.locator('[data-testid="memo-section-pm"] .MuiInputBase-root').boundingBox();
  await page.mouse.click(pmBox.x + pmBox.width / 2, pmBox.y + pmBox.height - 6);
  check(await quick('pm').evaluate(el => document.activeElement === el), '빈 입력칸 아래쪽을 눌러도 포커스');
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="memo-header-date"]').click();

  // 긴 메인 메모 편집: 스크롤을 내린 자리에서 입력해도 스크롤이 초기화되지 않고 커서가 유지된다
  await openDate(dates.mainLong);
  const row = page.locator('[data-testid="memo-section-main"] [data-testid="personal-memo-row"]').first();
  await row.locator('[aria-label="메모 편집"]').click();
  const editable = row.locator('[contenteditable="true"]');
  await editable.waitFor();
  const emptyDefault = emptyBy['default-again'];
  const editing = await measure();
  near(editing.am.input, emptyDefault.am.input, '메인 편집 중 오전 입력칸 그대로');
  near(editing.pm.input, emptyDefault.pm.input, '메인 편집 중 오후 입력칸 그대로');
  await editable.evaluate(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    // 편집기는 안쪽 스크롤 없이 다 펼쳐진다 — 화면(바깥 스크롤)을 끝으로 내린다.
    el.scrollIntoView({ block: 'end' });
  });
  const outerScrollTop = el => {
    let scroller = el.parentElement;
    while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement;
    return scroller.scrollTop;
  };
  const scrolledTo = await editable.evaluate(outerScrollTop);
  await page.keyboard.type('끝에 입력');
  await sleep(1200); // 자동 저장 반영까지
  const caret = await editable.evaluate(el => {
    const selection = getSelection();
    const anchor = selection.anchorNode;
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(selection.anchorNode, selection.anchorOffset);
    return { inside: el.contains(anchor), atEnd: before.toString().endsWith('끝에 입력'), innerScroll: el.scrollHeight - el.clientHeight };
  });
  caret.scrollTop = await editable.evaluate(outerScrollTop);
  check(caret.inside && caret.atEnd, `자동 저장 뒤 커서 유지: ${JSON.stringify(caret)}`);
  check(caret.innerScroll <= 1, `편집기 안 스크롤 없음: ${caret.innerScroll}`);
  check(caret.scrollTop > 0 && Math.abs(caret.scrollTop - scrolledTo) <= 1, `자동 저장 뒤 화면 스크롤 유지: ${scrolledTo} → ${caret.scrollTop}`);
  await page.locator('[data-testid="memo-header-date"]').click();
  rows.push({ window: 'default', scenario: 'caret-scroll', caret });
  console.log(`\n커서·스크롤: ${JSON.stringify(caret)}`);

  check(!app.consoleErrors.length, `콘솔 오류 없음: ${app.consoleErrors.slice(-3).join(' | ')}`);
  console.log(baseline ? '\n측정 완료(판정 없음)' : '\nE2E 통과');
} catch (error) {
  failed = 1;
  console.log(`✘ ${error.message}`);
  await app.shot(`${prefix}-FAILED`).catch(() => undefined);
} finally {
  writeFileSync(path.join(app.shotDir, baseline ? 'section-heights-before.json' : 'section-heights-report.json'), JSON.stringify(rows, null, 2));
  await app.kill();
  app.cleanup();
  clearE2eCredential();
  restoreWindowState();
}
process.exit(failed);
