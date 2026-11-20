// 메모 메뉴 T(오늘로 이동) — 실제 Windows 한국어 IME 입력(OS → IME → WebView2)으로 확인한다.
//   npm run e2e:build
//   node e2e/move-today-ime.mjs     (실행 중(약 40초) 키보드·앞 창을 쓴다 — 그동안 키보드·마우스를 쓰지 말 것)
// 결과: e2e/output/move-today-ime-report.json
// 격리: harness 의 임시 설정·임시 저장 위치, Mock 서버. 메모는 모두 더미 글이다.
// 키는 e2e/os-keys.ps1 -Scan(실제 키보드처럼 스캔 코드 포함 → KeyboardEvent.code 가 채워진다)으로 누른다.
// 처음 입력 모드(한/영)를 기억했다가 끝나면 되돌린다.
//
// 확인:
//   1 한글 모드 + 우클릭 메뉴 → T → 오늘로(본문 그대로)
//   2 메뉴를 연 채 한/영 → T → 오늘로
//   3 편집기에서 한글 조합 중 ⋮ 로 메뉴 → T → 오늘로('ㅅ'·'t' 가 본문에 들어가지 않음)
//   4 메뉴를 연 채 Ctrl+T → 이동 없음(메뉴 그대로)
//   5 메뉴 없이 편집 중 T → 'ㅅ' 조합(글자 입력) · 이동 없음
//   6 서식 메뉴(편집 중 우클릭)에서 T → 이동 없음
//   7 검색창에서 T → 'ㅅ' 입력 · 이동 없음

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { App, clearE2eCredential, isolateWindowState, repoRoot } from './harness.mjs';

const app = new App();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = [];
const failures = [];
const check = (condition, label, detail) => {
  const ok = !!condition;
  report.push({ check: label, ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(label);
};
const plusDays = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
/** 실제 키 입력(스캔 코드 포함). 테스트 창이 앞이 아니면 멈춘다. */
const osKeys = keys =>
  execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'e2e', 'os-keys.ps1'), '-AppPid', String(app.proc.pid), '-Keys', keys, '-Scan'],
    { encoding: 'utf8' },
  ).trim();
const VK = { BACK: '08', SPACE: '20', ESC: '1B', HANGUL: '15', CTRL: '11', D: '44', K: '4B', T: '54' };

let today = '';
let date = '';
const dayItems = async d => (await app.invoke('memo_day', { date: d })).items;
async function where(id) {
  if ((await dayItems(today)).some(i => i.id === id)) return 'today';
  return (await dayItems(date)).some(i => i.id === id) ? 'origin' : 'missing';
}
const textOf = async id => {
  const item = [...(await dayItems(today)), ...(await dayItems(date))].find(i => i.id === id);
  return item ? item.contentHtml.replace(/<[^>]+>/g, '') : null;
};
const menu = () => app.page.locator('[data-testid="personal-memo-menu"]');
const rowOf = id => app.page.locator(`[data-testid="personal-memo-row"][data-memo-id="${id}"]`);
async function waitUntil(fn, timeout = 3000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(150);
  }
  return false;
}

async function toWeek() {
  await app.page.reload();
  await app.page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
}
/** 새 메모 하나를 시험 날짜에 만들고 그 날짜 상세를 연다. keydown·조합 기록을 새로 시작한다. */
async function freshMemo(label) {
  const item = await app.invoke('item_create', { input: { id: crypto.randomUUID(), location: { kind: 'day', date }, section: 'main', kind: 'checklist', contentHtml: `IME 메모 ${label}` } });
  await toWeek();
  execFileSync('cmd', ['/c', 'start', '', `plana-memo-dev://open?date=${date}`], { stdio: 'ignore' });
  await rowOf(item.id).waitFor({ timeout: 20000 });
  await sleep(400);
  await app.page.evaluate(() => {
    window.__keys = [];
    for (const type of ['keydown', 'compositionupdate']) {
      document.addEventListener(type, e => {
        const t = e.target;
        const editable = !!t.closest?.('[contenteditable="true"], input, textarea');
        window.__keys.push(type === 'keydown' ? { key: e.key, code: e.code, keyCode: e.keyCode, composing: e.isComposing, ctrl: e.ctrlKey, editable } : { update: e.data, editable });
      }, true);
    }
  });
  return item.id;
}
const keys = () => app.page.evaluate(() => window.__keys.splice(0));
const tKeys = log => log.filter(k => k.code === 'KeyT');

/** 지금 입력 모드 — 검색창에 D 를 눌러 'ㅇ'(한글) / 'd'(영문). 검색창은 비우고 닫는다. */
async function inputMode() {
  await toWeek();
  await app.page.click('[data-testid="memo-search-open"]');
  const input = app.page.locator('[data-testid="memo-search-input"]');
  await input.waitFor();
  await input.fill('');
  await input.focus();
  await sleep(200);
  osKeys(VK.D);
  await sleep(250);
  const value = await input.inputValue();
  osKeys(VK.BACK);
  await sleep(150);
  await input.fill('');
  await app.page.click('[data-testid="memo-search-close"]');
  if (value.includes('ㅇ')) return 'hangul';
  if (value.toLowerCase().includes('d')) return 'english';
  return `unknown(${value})`;
}
async function ensureHangul() {
  let mode = await inputMode();
  if (mode !== 'hangul') {
    await toWeek();
    await app.page.click('[data-testid="memo-search-open"]');
    await app.page.locator('[data-testid="memo-search-input"]').focus();
    osKeys(VK.HANGUL);
    await sleep(200);
    mode = await inputMode();
  }
  return mode;
}

clearE2eCredential();
const restoreWindowState = isolateWindowState();
let initialMode = null;
try {
  await app.start();
  const ready = await app.invoke('storage_initialize', { path: app.storeDir, createNew: true });
  if (ready.state !== 'ready') throw new Error(`저장 위치 초기화 실패: ${ready.state}`);
  today = (await app.invoke('app_info')).today;
  date = plusDays(today, 5);
  await app.page.setViewportSize({ width: 1180, height: 760 });

  initialMode = await inputMode();
  console.log(`[준비] 처음 입력 모드: ${initialMode}`);
  check((await ensureHangul()) === 'hangul', '한글 입력 모드(한국어 IME)', { initialMode });
  if (failures.length) throw new Error('한국어 IME 를 한글 모드로 둘 수 없다 — 이 PC 에 한국어 입력기가 있어야 한다');

  // 1 한글 모드 + 우클릭 메뉴 → T
  console.log('\n[1 한글 모드 · 우클릭 메뉴 → T]');
  {
    const id = await freshMemo('1');
    const before = await textOf(id);
    await rowOf(id).locator('[aria-label="메모 편집"]').click({ button: 'right' });
    await menu().waitFor();
    await sleep(250);
    osKeys(VK.T);
    const moved = await waitUntil(async () => (await where(id)) === 'today');
    const log = tKeys(await keys());
    check(moved, '오늘로 이동', log);
    check(log.length > 0 && log.every(k => !k.editable), 'T 를 메뉴(편집 불가 요소)가 받음 · code KeyT', log);
    check((await menu().count()) === 0, '메뉴 닫힘');
    check((await textOf(id)) === before, '본문 그대로', await textOf(id));
  }

  // 2 메뉴를 연 채 한/영 → T
  console.log('\n[2 메뉴에서 한/영 → T]');
  {
    const id = await freshMemo('2');
    await rowOf(id).locator('[aria-label="메모 편집"]').click({ button: 'right' });
    await menu().waitFor();
    await sleep(250);
    osKeys(`${VK.HANGUL},${VK.T}`);
    const moved = await waitUntil(async () => (await where(id)) === 'today');
    check(moved, '오늘로 이동', tKeys(await keys()));
    check((await ensureHangul()) === 'hangul', '(다음 확인을 위해) 한글 모드');
  }

  // 3 편집기에서 한글 조합 중 ⋮ 로 메뉴 → T
  console.log('\n[3 한글 조합 중 ⋮ 메뉴 → T]');
  {
    const id = await freshMemo('3');
    await rowOf(id).locator('[aria-label="메모 편집"]').click();
    await rowOf(id).locator('[contenteditable="true"]').waitFor();
    await sleep(300);
    osKeys(VK.D);
    await sleep(250);
    const composing = (await keys()).some(k => k.update === 'ㅇ');
    check(composing, '편집기에서 한글 조합 시작(ㅇ)');
    await rowOf(id).locator('[aria-label="메모 메뉴"]').click();
    await menu().waitFor();
    await sleep(250);
    osKeys(VK.T);
    const moved = await waitUntil(async () => (await where(id)) === 'today');
    const log = await keys();
    check(moved, '오늘로 이동', tKeys(log));
    await sleep(600); // 편집기 저장
    const text = await textOf(id);
    check(!/[ㅅt]/.test(text), "'ㅅ'·'t' 가 본문에 들어가지 않음(메뉴를 열 때 확정된 조합 글자만)", text);
    check(!log.some(k => k.update === 'ㅅ'), 'T 로 새 조합이 시작되지 않음', log);
  }

  // 4 메뉴를 연 채 Ctrl+T → 이동 없음
  console.log('\n[4 메뉴에서 Ctrl+T]');
  {
    const id = await freshMemo('4');
    await rowOf(id).locator('[aria-label="메모 편집"]').click({ button: 'right' });
    await menu().waitFor();
    await sleep(250);
    osKeys(`${VK.CTRL}+${VK.T}`);
    await sleep(800);
    const log = tKeys(await keys());
    check(log.some(k => k.ctrl), 'Ctrl+T 가 실제로 들어옴', log);
    check((await where(id)) === 'origin', '이동 없음');
    check((await menu().count()) === 1, '메뉴 그대로');
    osKeys(VK.ESC);
    await sleep(300);
  }

  // 5 메뉴 없이 편집 중 T → 'ㅅ'
  console.log('\n[5 편집 중 T]');
  {
    const id = await freshMemo('5');
    await rowOf(id).locator('[aria-label="메모 편집"]').click();
    await rowOf(id).locator('[contenteditable="true"]').waitFor();
    await sleep(300);
    osKeys(`${VK.T},${VK.K},${VK.SPACE}`);
    await sleep(300);
    const log = await keys();
    check(log.some(k => k.update === 'ㅅ') && log.some(k => k.update === '사'), "편집기에 'ㅅ' → '사' 조합", log.filter(k => k.update));
    await app.page.locator('[data-testid="memo-header-date"]').click();
    const saved = await waitUntil(async () => (await textOf(id))?.includes('사'));
    check(saved, "'사' 저장", await textOf(id));
    check((await where(id)) === 'origin', '이동 없음');
  }

  // 6 서식 메뉴(편집 중 우클릭)에서 T
  console.log('\n[6 서식 메뉴에서 T]');
  {
    const id = await freshMemo('6');
    await rowOf(id).locator('[aria-label="메모 편집"]').click();
    const editable = rowOf(id).locator('[contenteditable="true"]');
    await editable.waitFor();
    await sleep(300);
    const point = await editable.evaluate(el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      const at = node.data.indexOf('메모');
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 2);
      el.focus();
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await app.page.mouse.click(point.x, point.y, { button: 'right' });
    const formatMenu = app.page.locator('[data-testid="rich-text-context-menu"]');
    await formatMenu.waitFor();
    check((await menu().count()) === 0, '서식 메뉴(메모 메뉴 아님)');
    osKeys(VK.T);
    await sleep(800);
    check((await where(id)) === 'origin', '이동 없음', tKeys(await keys()));
    if (await formatMenu.count()) osKeys(VK.ESC);
    await sleep(200);
    osKeys(VK.BACK);
    await app.page.locator('[data-testid="memo-header-date"]').click();
    await sleep(500);
  }

  // 7 검색창에서 T
  console.log('\n[7 검색창에서 T]');
  {
    const id = await freshMemo('7');
    await app.page.click('[data-testid="memo-search-open"]');
    const input = app.page.locator('[data-testid="memo-search-input"]');
    await input.waitFor();
    await input.focus();
    await sleep(200);
    osKeys(`${VK.T},${VK.K}`);
    await sleep(300);
    const value = await input.inputValue();
    check(value.includes('사'), "검색창에 '사'", value);
    osKeys(`${VK.BACK},${VK.BACK}`);
    await input.fill('');
    await app.page.click('[data-testid="memo-search-close"]');
    check((await where(id)) === 'origin', '이동 없음');
  }
} catch (error) {
  failures.push(`중단: ${error.message}`);
  console.log(`  ✘ 중단: ${error.message}`);
  await app.shot('FAILED-move-today-ime').catch(() => undefined);
} finally {
  // 처음 입력 모드로 되돌린다
  if (initialMode && app.proc) {
    try {
      const now = await inputMode();
      if (initialMode === 'english' && now === 'hangul') {
        await app.page.click('[data-testid="memo-search-open"]');
        await app.page.locator('[data-testid="memo-search-input"]').focus();
        osKeys(VK.HANGUL);
        await sleep(200);
      }
      console.log(`\n[정리] 입력 모드: 처음 ${initialMode} → 지금 ${await inputMode()}`);
    } catch (error) {
      console.log(`[정리] 입력 모드를 되돌리지 못함: ${error.message} — 한/영 키로 직접 확인하세요`);
    }
  }
  writeFileSync(path.join(repoRoot, 'e2e', 'output', 'move-today-ime-report.json'), JSON.stringify({ today, date, initialMode, report }, null, 2));
  await app.kill();
  app.cleanup();
  clearE2eCredential();
  restoreWindowState();
}
console.log(failures.length ? `\n실패 ${failures.length}: ${failures.join(' / ')}` : '\n모두 통과');
process.exit(failures.length ? 1 : 0);
