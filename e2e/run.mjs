// PLAN-A Memo E2E — 실제 앱을 띄워 핵심 흐름을 순서대로 확인한다.
//   npm run e2e:build   (development debug 빌드 · Mock 서버)
//   npm run e2e         (전체)   /   node e2e/run.mjs memo image   (이름에 맞는 단계만 — 앞 단계 상태가 필요하면 함께)
// 결과 스크린샷: e2e/output/*.png  ·  PLANA_E2E_KEEP=1 이면 임시 저장소를 남긴다.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { App, clearE2eCredential, isMockRun, isolateWindowState } from './harness.mjs';

const app = new App();
const steps = [];
const step = (name, fn, { mockOnly = false } = {}) => steps.push({ name, fn, mockOnly });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let today = '';
let firstItemId = '';

async function waitFor(fn, message, timeout = 15000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`시간 초과: ${message}`);
}

const day = () => app.invoke('memo_day', { date: today });
const loc = () => ({ kind: 'day', date: today });

step('first-run', async () => {
  const status = await app.invoke('storage_status');
  assert.equal(status.state, 'first_run', '설정이 없으면 첫 실행 화면');
  await app.page.waitForSelector('[data-testid="storage-setup"]', { timeout: 15000 }).catch(() => undefined);
  await app.shot('01-first-run');
  const ready = await app.invoke('storage_initialize', { path: app.storeDir, createNew: true });
  assert.equal(ready.state, 'ready');
  today = (await app.invoke('app_info')).today;
  await app.page.reload();
  await app.page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
});

step('memo-create', async () => {
  const page = app.page;
  await page.click(`[data-testid="memo-cell-${today}"]`, { position: { x: 300, y: 100 } });
  await page.waitForSelector('[data-testid="memo-section-main"]');
  const write = async (section, lines) => {
    const input = page.locator(`[data-testid="memo-section-${section}"] [data-testid="personal-memo-quick-input"]`);
    await input.click();
    for (const line of lines) {
      await input.type(line);
      await page.keyboard.press('Control+Enter');
      await sleep(200);
    }
  };
  await write('main', ['AWS 확인', '메일 확인']);
  await write('am', ['회의 준비']);
  await write('pm', ['보고서 작성']);
  await page.locator('[data-testid="memo-header-date"]').click();
  const saved = await waitFor(async () => ((await day()).items.length === 4 ? await day() : null), '메모 4건 저장');
  assert.deepEqual(saved.items.map(i => i.section), ['main', 'main', 'am', 'pm']);
  firstItemId = saved.items[0].id;
  await app.shot('02-day-written');
});

step('image', async () => {
  const page = app.page;
  const row = page.locator('[data-testid="memo-section-pm"] [data-testid="personal-memo-row"]').first();
  await row.locator('[aria-label="메모 편집"]').click();
  const editable = row.locator('[contenteditable="true"]');
  await editable.waitFor();
  await page.keyboard.press('End');
  await page.keyboard.type(' ');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('(초안)');
  await page.keyboard.press('Control+b');
  await editable.evaluate(async el => {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 24;
    const g = c.getContext('2d');
    g.fillStyle = '#e11d48';
    g.fillRect(0, 0, 32, 24);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'capture.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await sleep(1500);
  await page.locator('[data-testid="memo-header-date"]').click();
  const pm = await waitFor(async () => (await day()).items.find(i => i.section === 'pm' && i.contentHtml.includes('attachment://')), '이미지 저장');
  assert.match(pm.contentHtml, /<(b|strong)>\(초안\)/, '굵게 서식');
  assert.doesNotMatch(pm.contentHtml, /file:|[A-Za-z]:\\|localhost/, '본문에는 attachment://<id> 만');
  // 편집을 다시 열어도(attachment:// 를 DOM 에 넣는 순간) 콘솔 오류가 없어야 한다(§34-1)
  await row.locator('[aria-label="메모 편집"]').click();
  await sleep(800);
  await page.locator('[data-testid="memo-header-date"]').click();
  await sleep(500);
  const bad = app.consoleErrors.filter(e => /attachment:|ERR_UNKNOWN_URL_SCHEME/i.test(e));
  assert.deepEqual(bad, [], 'attachment:// 로딩 오류 없음');
  await app.shot('03-image');
});

step('search-history', async () => {
  const hits = await app.invoke('memo_search', { query: '초안' });
  assert.ok(hits.items.length >= 1, '서식 태그를 무시하고 찾는다');
  await app.invoke('item_update_content', { id: firstItemId, html: 'AWS 비용 확인' });
  const history = await app.invoke('history_list', { location: loc() });
  assert.ok(history.length >= 1, '수정 전 상태가 History 에');
});

step('restart-persistence', async () => {
  await app.restart();
  await app.page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  const items = (await day()).items;
  assert.equal(items.length, 4, '강제 종료 후에도 메모가 그대로');
  const id = items.find(i => i.section === 'pm').contentHtml.match(/attachment:\/\/([0-9a-f-]{36})/)[1];
  const status = await app.page.evaluate(async i => (await fetch(`http://attachment.localhost/${i}`)).status, id);
  assert.equal(status, 200, '이미지 파일이 저장 폴더에서 열린다');
  await app.shot('04-after-restart');
});

step(
  'login-link',
  async () => {
    const page = app.page;
    await page.click(`[data-testid="memo-cell-${today}"]`, { position: { x: 400, y: 30 } });
    await page.click('[data-testid="sync-link-button"]');
    await page.waitForSelector('[data-testid="account-dialog"]');
    await app.shot('05-account');
    await page.click('[data-testid="account-connect"]'); // Mock: 동의 흉내 → 127.0.0.1 loopback callback → PKCE 교환
    await waitFor(async () => (await app.invoke('auth_status')).loggedIn, '로그인(loopback)');
    const linked = await waitFor(async () => {
      const ov = await app.invoke('sync_overview');
      return ov.linkedDocuments === 1 && ov.outbox === 0 ? ov : null;
    }, '연결 후 첫 Sync', 20000);
    assert.equal(linked.auth.session.isMock, true);
    const doc = (await day()).document;
    assert.equal(doc.syncStatus, 'synced');
    await app.shot('06-linked');
  },
  { mockOnly: true },
);

step(
  'conflict',
  async () => {
    await app.invoke('mock_remote_edit', { location: loc(), text: 'Web 에서 추가한 일' });
    await app.invoke('item_update_content', { id: firstItemId, html: 'AWS 비용 확인 (Desktop 수정)' });
    const report = await app.invoke('sync_now');
    assert.equal(report.conflicts, 1, '양쪽 수정 → 비교');
    await app.page.click('[data-testid="header-sync-problem"]').catch(() => undefined);
    await app.page.waitForSelector('[data-testid="conflict-dialog"]', { timeout: 10000 });
    await sleep(500);
    await app.shot('07-conflict');
    await app.page.locator('[data-testid="conflict-dialog"] button:has-text("이 내용을 최신으로 사용")').first().click(); // Desktop
    await waitFor(async () => (await app.invoke('conflicts_list')).length === 0, '선택 반영');
    const history = await app.invoke('history_list', { location: loc() });
    assert.ok(history.some(v => v.reason === 'conflict_remote'), '선택하지 않은 PLAN-A Work 내용은 History 에');
  },
  { mockOnly: true },
);

step(
  'offline-restart-outbox',
  async () => {
    await app.invoke('mock_set_online', { online: false });
    await app.invoke('item_update_content', { id: firstItemId, html: '오프라인에서 수정' });
    const offline = await app.invoke('sync_now');
    assert.equal(offline.offline, true);
    assert.equal((await app.invoke('sync_overview')).outbox, 1);
    await app.restart();
    await app.page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
    assert.equal((await app.invoke('sync_overview')).outbox, 1, 'Outbox 는 강제 종료 후에도 남는다');
    await app.invoke('mock_set_online', { online: true });
    const report = await app.invoke('sync_now');
    assert.equal(report.pushed, 1);
    assert.equal((await app.invoke('sync_overview')).outbox, 0);
  },
  { mockOnly: true },
);

step(
  'first-link-compare',
  async () => {
    // 같은 날짜에 이 PC 와 'Web' 모두 내용이 있다 → 연결해도 어느 쪽도 덮어쓰지 않고 첫 연결 비교(base_version=0)
    const next = new Date(`${today}T00:00:00`);
    next.setDate(next.getDate() + 1);
    const date = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
    const location = { kind: 'day', date };
    await app.invoke('item_create', {
      input: { id: crypto.randomUUID(), location, section: 'main', kind: 'checklist', contentHtml: 'AWS 확인(Desktop)' },
    });
    await app.invoke('mock_remote_edit', { location, text: 'RDS 확인(Web)' });
    await app.invoke('sync_link', { location });
    const report = await app.invoke('sync_now');
    assert.equal(report.conflicts, 1, '첫 연결 비교');
    const conflict = (await app.invoke('conflicts_list')).find(c => c.location.date === date);
    assert.equal(conflict.firstLink, true);
    assert.deepEqual(
      conflict.local.items.map(i => i.contentHtml),
      ['AWS 확인(Desktop)'],
      '이 PC 내용은 그대로',
    );
    assert.deepEqual(
      conflict.remote.items.map(i => i.contentHtml),
      ['RDS 확인(Web)'],
      'Web 내용도 그대로',
    );
    await app.page.click('[data-testid="header-sync-problem"]').catch(() => undefined);
    await app.page.waitForSelector('[data-testid="conflict-dialog"]', { timeout: 10000 });
    await app.page.waitForSelector('text=처음 연결하는데', { timeout: 5000 });
    await app.shot('07b-first-link-compare');
    await app.page.locator('[data-testid="conflict-dialog"] button:has-text("나중에 선택")').click();
    const items = (await app.invoke('memo_day', { date })).items.map(i => i.contentHtml);
    assert.deepEqual(items, ['AWS 확인(Desktop)'], '고르기 전에는 이 PC 내용을 바꾸지 않는다');
  },
  { mockOnly: true },
);

step(
  'linked-list-rename-notice',
  async () => {
    const list = await app.invoke('list_create', { id: crypto.randomUUID(), name: '앱 개발' });
    await app.invoke('sync_link', { location: { kind: 'next', listId: list.id } });
    await app.invoke('sync_now');
    const before = (await app.invoke('sync_overview')).outbox; // 앞 단계의 '나중에 선택' 비교 1건은 그대로 대기
    const renamed = await app.invoke('list_rename', { id: list.id, name: '앱 개발 2' });
    assert.equal(renamed.name, '앱 개발 2');
    assert.equal(renamed.document.syncStatus, 'synced', '이름 변경으로 보낼 것이 생기지 않는다(서버 API 없음)');
    assert.equal((await app.invoke('sync_overview')).outbox, before);
  },
  { mockOnly: true },
);

step('storage-move', async () => {
  const target = path.join(app.workDir, 'moved', 'My Notes');
  const report = await app.invoke('storage_relocate', { path: target });
  assert.ok(report.newRoot.includes('My Notes'));
  assert.equal((await app.invoke('storage_status')).path, report.newRoot);
  assert.equal((await day()).items.length >= 4, true, '옮긴 뒤에도 같은 메모');
  await app.page.reload();
  await app.page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  await app.shot('08-moved');
});

step('deep-link', async () => {
  const count = () =>
    execFileSync('tasklist', ['/FI', 'IMAGENAME eq PLAN-A Memo.exe', '/NH'], { encoding: 'utf8' })
      .split('\n')
      .filter(l => l.includes('PLAN-A Memo.exe')).length;
  const before = count();
  execFileSync('cmd', ['/c', 'start', '', 'plana-memo-dev://open'], { stdio: 'ignore' });
  await sleep(4000);
  assert.equal(count(), before, '두 번째 창을 띄우지 않고 기존 창으로(single instance)');
  assert.ok(await app.invoke('app_info'), '기존 앱은 계속 응답');
});

step(
  'device-revoke',
  async () => {
    // Web 기기 관리에서 이 PC 해제 → 401. 같은 기기로 다시 연결은 거절(device_revoked) — 자동 재활성화 없음
    const before = await app.invoke('auth_status');
    const oldDevice = before.session.serverDeviceId;
    const outbox = (await app.invoke('sync_overview')).outbox;
    await app.invoke('mock_revoke_device');
    const report = await app.invoke('sync_now');
    assert.equal(report.authRequired, true);
    const err = await app.invokeError('auth_login_begin', { reconnect: true });
    assert.equal(err?.code, 'device_revoked', '폐기된 기기 id 로 다시 연결하지 않는다');
    assert.ok((await day()).items.length >= 4, '로컬 메모 그대로');
    assert.equal((await app.invoke('sync_overview')).outbox, outbox, 'Outbox 그대로');
    // 사용자가 [새 기기로 등록] — 새 기기, 이전 연결은 이어받지 않는다(다시 고른 문서만 연결)
    await app.invoke('auth_login_begin', { reconnect: false });
    const after = await waitFor(async () => {
      const s = await app.invoke('auth_status');
      return s.loggedIn ? s : null;
    }, '새 기기 등록');
    assert.notEqual(after.session.serverDeviceId, oldDevice);
    const sync = await app.invoke('sync_now');
    assert.ok(sync.notices.some(n => n.includes('이전 기기')), '이전 기기 연결 안내');
    assert.equal((await day()).document.syncStatus, 'auth_required', '이전 연결은 멈춤(보존)');
    await app.shot('09-device-revoked');
  },
  { mockOnly: true },
);

step(
  'logout',
  async () => {
    const result = await app.invoke('auth_logout');
    assert.equal(result.serverRevoked, true);
    assert.equal((await day()).document.syncStatus, 'local_only', '로그아웃 → 이 PC 에만');
    assert.ok((await day()).items.length >= 4, '메모는 그대로');
  },
  { mockOnly: true },
);

// ── 날짜 상세 도구: 상단 버튼 · 오늘 · 다가오는 같은 요일 · 지난 미완료 가져오기 · 날짜 알림(작업 스케줄러 등록) ──────

const plusDays = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const weekdayIndex = date => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = 월
const dayOf = date => app.invoke('memo_day', { date });
const addItem = (date, section, html, kind = 'checklist') =>
  app.invoke('item_create', { input: { id: crypto.randomUUID(), location: { kind: 'day', date }, section, kind, contentHtml: html } });
let reminderTask = null;

async function openToday() {
  await app.page.reload();
  await app.page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  await app.page.click('[data-testid="memo-today"]');
  await app.page.waitForSelector('[data-testid="upcoming-weekday"]', { timeout: 15000 });
  await app.page.mouse.move(5, 300); // 머리 버튼 툴팁을 닫는다
}

async function openDate(date) {
  await app.page.reload();
  await app.page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  execFileSync('cmd', ['/c', 'start', '', `plana-memo-dev://open?date=${date}`], { stdio: 'ignore' });
  await waitFor(
    async () => (await app.page.locator('[data-testid="upcoming-weekday"]').count()) > 0 && (await app.page.locator(`[data-testid="upcoming-card-${plusDays(date, 7)}"]`).count()) > 0,
    `${date} 상세(링크)`,
  );
}

step('header-today', async () => {
  const page = app.page;
  await page.reload();
  await page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  const order = async () =>
    page.$$eval('[data-testid="memo-header-tools"] > *', nodes =>
      nodes.map(n => n.getAttribute('data-testid') || n.querySelector('[data-testid]')?.getAttribute('data-testid')),
    );
  assert.deepEqual(await order(), ['memo-search-open', 'memo-today', 'open-settings'], '주간: 검색 → 오늘 → 설정');
  assert.equal(await page.locator('[data-testid="open-settings"]').count(), 1, '설정 입구는 하나');
  const headerText = await page.locator('[data-testid="memo-dialog-header"]').innerText();
  assert.ok(!headerText.includes('이번 주'), "'이번 주' 버튼 없음");
  // 같은 높이·세로 정렬
  const boxes = await page.$$eval('[data-testid="memo-header-tools"] > *', nodes => nodes.map(n => n.getBoundingClientRect()).map(r => [Math.round(r.top), Math.round(r.height)]));
  assert.ok(boxes.every(([top, h]) => h === boxes[0][1] && Math.abs(top - boxes[0][0]) <= 1), `도구 높이·정렬 ${JSON.stringify(boxes)}`);
  await app.shot('20-header-week');
  // [오늘] → 오늘 날짜 상세(메인·오전·오후 + 다가오는 같은 요일)
  await page.click('[data-testid="memo-today"]');
  await page.waitForSelector('[data-testid="memo-section-main"]');
  await page.waitForSelector('[data-testid="upcoming-weekday"]');
  assert.equal(await page.getAttribute('[data-testid="memo-today"]', 'aria-pressed'), 'true');
  assert.deepEqual(await order(), ['memo-search-open', 'memo-today', 'open-settings'], '날짜 상세: 같은 순서');
  assert.ok(await page.locator('[data-testid="memo-back-to-week"]').isVisible(), '← 주간 유지');
  const names = ['월', '화', '수', '목', '금', '토', '일'];
  assert.match(await page.locator('[data-testid="upcoming-weekday"] h2').innerText(), new RegExp(`다가오는 ${names[weekdayIndex(today)]}요일`));
  // 이미 오늘이면 다시 눌러도 화면을 다시 만들지 않는다 — 쓰던 글은 기존 규칙대로(바깥을 누르면) 저장된다
  await page.$eval('[data-testid="personal-memo-day"]', el => (el.dataset.e2eMark = 'same'));
  const input = page.locator('[data-testid="memo-section-am"] [data-testid="personal-memo-quick-input"]');
  await input.click();
  await input.type('쓰는 중');
  await page.click('[data-testid="memo-today"]');
  assert.equal(await page.getAttribute('[data-testid="personal-memo-day"]', 'data-e2e-mark'), 'same', '같은 화면 유지(다시 만들지 않음)');
  const typed = await waitFor(async () => (await day()).items.find(i => i.contentHtml === '쓰는 중'), '쓰던 글 저장(잃지 않음)');
  await app.invoke('item_delete', { id: typed.id });
  // 작은 창에서도 겹치지 않는다
  const original = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  await page.setViewportSize({ width: 850, height: 620 }); // 창 최소 폭(tauri.conf minWidth 850)
  const rects = await page.$$eval('[data-testid="personal-memo-view-header"] button', nodes => nodes.map(n => n.getBoundingClientRect().toJSON()));
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const overlap = a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      assert.ok(!overlap, '머리 버튼끼리 겹치지 않는다');
    }
  await app.shot('21-today-detail-small');
  await page.setViewportSize(original);
  await app.shot('21-today-detail');
  // [← 주간] → 오늘이 든 주
  await page.click('[data-testid="memo-back-to-week"]');
  await page.waitForSelector(`[data-testid="memo-cell-${today}"]`);
});

step('upcoming-weekday', async () => {
  const page = app.page;
  const d7 = plusDays(today, 7);
  const d14 = plusDays(today, 14);
  const d28 = plusDays(today, 28);
  const a = await addItem(d7, 'main', '정기 점검');
  await addItem(d7, 'am', '예약한 일정 확인');
  await addItem(d7, 'pm', '준비물 미리 챙기기', 'text');
  for (const n of [1, 2, 3, 4, 5]) await addItem(d7, 'pm', `추가 항목 ${n}`);
  await addItem(d28, 'main', '4주 뒤 일정');
  const todayRev = (await day()).document.localRevision;
  await openToday();
  const card7 = page.locator(`[data-testid="upcoming-card-${d7}"]`);
  await card7.waitFor();
  const text7 = await card7.innerText();
  assert.ok(text7.includes('다음 주') && text7.includes('정기 점검') && text7.includes('예약한 일정 확인'), '다음 주 카드에 실제 내용');
  assert.ok(text7.includes('나머지') && text7.includes('펼치기'), '많으면 일부만 + 펼치기');
  await card7.locator('button:has-text("펼치기")').click();
  assert.ok((await card7.innerText()).includes('추가 항목 5'), '펼치면 모두');
  // 빈 다다음 주 — 작은 한 줄 + [미리 작성]
  const card14 = page.locator(`[data-testid="upcoming-card-${d14}"]`);
  assert.equal(await card14.getAttribute('data-empty'), 'true');
  const h14 = (await card14.boundingBox()).height;
  assert.ok(h14 < 60, `빈 날짜는 작게(${h14}px)`);
  assert.equal(await page.locator(`[data-testid="upcoming-card-${d28}"]`).count(), 0, '더 먼 날짜는 [더 보기] 전에는 없다');
  await card14.locator('[data-testid="upcoming-write"]').click();
  const input14 = card14.locator('[data-testid="personal-memo-quick-input"]');
  await input14.type('다음 달 계획 검토');
  await page.keyboard.press('Control+Enter');
  await waitFor(async () => (await dayOf(d14)).items.some(i => i.contentHtml === '다음 달 계획 검토'), '미리 작성 → 그 날짜 문서');
  await page.locator('[data-testid="memo-header-date"]').click();
  // 더 보기
  await page.click('[data-testid="upcoming-more"]');
  await page.locator(`[data-testid="upcoming-card-${d28}"]`).waitFor();
  // 카드에서 체크 → 그 날짜 원본만 바뀐다
  const row = card7.locator(`[data-testid="personal-memo-row"][data-memo-id="${a.id}"]`);
  await row.locator('input[type="checkbox"]').click();
  await waitFor(async () => (await dayOf(d7)).items.find(i => i.id === a.id)?.completed, '다음 주 항목 완료');
  // 카드에서 그 자리 편집(기존 Rich Editor)
  await row.locator('[aria-label="메모 편집"]').click();
  await row.locator('[contenteditable="true"]').waitFor();
  await page.keyboard.press('End');
  await page.keyboard.type(' (수정)');
  await page.locator('[data-testid="memo-header-date"]').click();
  await waitFor(async () => (await dayOf(d7)).items.find(i => i.id === a.id)?.contentHtml.includes('(수정)'), '다음 주 항목 수정');
  const nowDay = await day();
  assert.equal(nowDay.document.localRevision, todayRev, '보고 있는 오늘 문서는 바뀌지 않는다');
  assert.ok(!nowDay.items.some(i => i.contentHtml.includes('정기 점검')), '오늘로 복사하지 않는다');
  // 카드에서 삭제(메뉴)
  const extra = card7.locator('[data-testid="personal-memo-row"]').filter({ hasText: '추가 항목 5' });
  await extra.hover();
  await extra.locator('[aria-label="메모 메뉴"]').click();
  await page.locator('[role="menuitem"]:has-text("삭제")').click();
  await waitFor(async () => !(await dayOf(d7)).items.some(i => i.contentHtml === '추가 항목 5'), '다음 주 항목 삭제');
  assert.equal((await dayOf(d7)).document.syncEnabled, false, '표시·편집만으로 연결하지 않는다');
  await app.shot('22-upcoming');
  // 카드 제목 → 그 날짜 상세
  await card7.locator(`[aria-label="${d7} 날짜 상세로"]`).click();
  await page.locator(`[data-testid="upcoming-card-${plusDays(d7, 7)}"]`).waitFor();
});

step('carryover', async () => {
  const src = plusDays(today, -7);
  const a = await addItem(src, 'main', '<b>보고서</b> 작성');
  const b = await addItem(src, 'am', '자료 정리');
  const done = await addItem(src, 'pm', '완료한 일');
  await app.invoke('item_set_completed', { id: done.id, completed: true });
  await addItem(src, 'pm', '그냥 메모', 'text');
  const before = await dayOf(src);
  await openToday();
  const notice = app.page.locator('[data-testid="carryover-notice"]');
  await notice.waitFor();
  assert.match(await notice.innerText(), /완료하지 않은 체크리스트가 2개/);
  await app.shot('23-carryover-notice');
  await app.page.click('[data-testid="carryover-pick"]');
  const options = app.page.locator('[data-testid="carryover-option"]');
  assert.equal(await options.count(), 2, '완료·텍스트 제외');
  await options.nth(1).locator('input').click(); // '자료 정리' 고르지 않음
  await app.shot('24-carryover-pick');
  await app.page.click('[data-testid="carryover-import"]');
  await waitFor(async () => (await day()).items.some(i => i.contentHtml === '<b>보고서</b> 작성'), '고른 항목만 복사');
  const now = await day();
  const copy = now.items.find(i => i.contentHtml === '<b>보고서</b> 작성');
  assert.notEqual(copy.id, a.id, '새 id');
  assert.equal(copy.section, 'main');
  assert.equal(copy.completed, false);
  assert.ok(!now.items.some(i => i.contentHtml === '자료 정리'), '고르지 않은 항목은 가져오지 않는다');
  const after = await dayOf(src);
  assert.deepEqual(after.items.map(i => [i.id, i.contentHtml, i.completed]), before.items.map(i => [i.id, i.contentHtml, i.completed]), '원본 그대로');
  assert.equal(after.document.localRevision, before.document.localRevision);
  // 같은 요청 다시(재클릭·재시도) → 중복 없음
  const again = await app.invoke('carryover_import', { date: today, itemIds: [a.id] });
  assert.equal(again.created.length, 0);
  // 재실행 후 다시 저절로 안내하지 않는다 · 보조 메뉴로는 남은 항목을 가져올 수 있다
  await app.restart();
  await openToday();
  await sleep(800);
  assert.equal(await app.page.locator('[data-testid="carryover-notice"]').count(), 0, '가져온 뒤에는 저절로 안내하지 않는다');
  await app.page.click('[data-testid="day-tools-menu"]');
  await app.page.click('[data-testid="day-tools-carryover"]');
  await app.page.locator('[data-testid="carryover-picker"]').waitFor();
  assert.equal(await app.page.locator('[data-testid="carryover-option"]').count(), 1, '남은 항목(자료 정리)만');
  await app.page.locator('[data-testid="carryover-picker"] button:has-text("취소")').click();
  assert.equal((await day()).items.filter(i => i.contentHtml === '<b>보고서</b> 작성').length, 1, '재실행 후에도 하나');
  void b;

  // [이번에는 건너뛰기] — 이번 주의 다른 날짜(오늘이 월요일이면 내일)
  const other = weekdayIndex(today) > 0 ? plusDays(today, -1) : plusDays(today, 1);
  await addItem(plusDays(other, -7), 'main', '건너뛸 미완료');
  await openDate(other);
  await app.page.locator('[data-testid="carryover-notice"]').waitFor();
  await app.page.click('[data-testid="carryover-skip"]');
  await waitFor(async () => (await app.invoke('carryover_get', { date: other })).status === 'skipped', '건너뛰기 저장');
  await app.restart();
  await openDate(other);
  await sleep(800);
  assert.equal(await app.page.locator('[data-testid="carryover-notice"]').count(), 0, '건너뛴 안내는 재실행 후에도 다시 보이지 않는다');
});

step('reminder-setup', async () => {
  const page = app.page;
  const d7 = plusDays(today, 7);
  await openToday();
  const card = page.locator(`[data-testid="upcoming-card-${d7}"]`);
  await card.locator('[data-testid="upcoming-reminder-button"]').click();
  const dialog = page.locator('[data-testid="reminder-dialog"]');
  await dialog.waitFor();
  await dialog.locator('input[aria-label="1주 전"]').check();
  await dialog.locator('input[aria-label="2일 전"]').check();
  await dialog.locator('[data-testid="reminder-time"]').fill('21:30');
  const preview = await dialog.locator('[data-testid="reminder-preview"]').innerText();
  assert.match(preview, /오후 9:30/);
  await app.shot('25-reminder-dialog');
  await page.click('[data-testid="reminder-save"]');
  await dialog.waitFor({ state: 'detached' });
  const r = await app.invoke('reminder_get', { date: d7 });
  assert.deepEqual(r.fires.map(f => f.fireAt), [`${today}T21:30`, `${plusDays(d7, -2)}T21:30`]);
  const status = await app.invoke('reminder_status');
  assert.equal(status.task?.error ?? null, null, `작업 등록 오류 없음: ${status.task?.error}`);
  assert.ok(status.task.name.includes('e2e'), 'E2E 는 따로 된 작업 이름');
  reminderTask = status.task.name;
  const pending = r.fires.filter(f => f.status === 'pending').map(f => f.fireAt);
  assert.deepEqual(status.task.triggers, pending, '예약 시각 = 아직 오지 않은 알림 시각');
  const xml = execFileSync('schtasks', ['/Query', '/TN', reminderTask, '/XML'], { encoding: 'utf8' });
  for (const t of pending) assert.ok(xml.includes(`<StartBoundary>${t}:00</StartBoundary>`), `작업 스케줄러 시각 ${t}`);
  assert.ok(xml.includes('--plana-reminder'), '창 없이 알림만 처리하는 실행');
  assert.ok(await card.locator('[data-reminder-on="true"]').count(), '카드에 알림 켜짐 표시');
  // 그 날짜 체크리스트를 모두 완료하면 예약에서 빠진다
  const open = (await dayOf(d7)).items.filter(i => i.kind === 'checklist' && !i.completed);
  for (const item of open) await app.invoke('item_set_completed', { id: item.id, completed: true });
  await waitFor(async () => (await app.invoke('reminder_status')).task?.triggers.length === 0, '모두 완료 → 예약 취소', 20000);
  assert.throws(() => execFileSync('schtasks', ['/Query', '/TN', reminderTask], { stdio: 'ignore' }), '작업 삭제');
  // 다시 미완료가 생기면 다시 예약
  await app.invoke('item_set_completed', { id: open[0].id, completed: false });
  await waitFor(async () => (await app.invoke('reminder_status')).task?.triggers.length === pending.length, '미완료 → 다시 예약', 20000);
  // 알림 끄기
  await app.invoke('reminder_set', { date: d7, offsets: [], time: '21:30' });
  assert.equal((await app.invoke('reminder_status')).task.triggers.length, 0);
  assert.throws(() => execFileSync('schtasks', ['/Query', '/TN', reminderTask], { stdio: 'ignore' }), '알림 끄기 → 작업 삭제');
});

step('reminder-click-opens-day', async () => {
  // 알림을 누르면 Windows 가 <scheme>://open?date=… 로 앱을 연다(실행 중이면 그 창으로) → 그 날짜 상세
  const target = plusDays(today, 21);
  await openDate(target);
  const [, m, d] = target.split('-').map(Number);
  assert.ok((await app.page.locator('[data-testid="personal-memo-view-label"]').innerText()).includes(`${m}/${d}`), '알림의 날짜 상세');
  assert.equal(await app.invoke('app_take_pending_open'), null, '한 번 연 날짜는 비워진다');
});

const only = process.argv.slice(2);
let failed = 0;
clearE2eCredential();
const restoreWindowState = isolateWindowState();
try {
  await app.start();
  for (const s of steps) {
    if (only.length && !only.some(o => s.name.includes(o))) continue;
    if (s.mockOnly && !isMockRun()) {
      console.log(`- ${s.name}: 건너뜀(실제 서버 모드 — 브라우저 동의가 필요한 단계)`);
      continue;
    }
    const started = Date.now();
    try {
      await s.fn();
      console.log(`✔ ${s.name} (${Date.now() - started}ms)`);
    } catch (error) {
      failed++;
      console.log(`✘ ${s.name}: ${error.message}`);
      if (app.consoleErrors.length) console.log(`  console.error:\n  ${app.consoleErrors.slice(-5).join('\n  ')}`);
      await app.shot(`FAILED-${s.name}`).catch(() => undefined);
      break;
    }
  }
} finally {
  await app.kill();
  app.cleanup();
  clearE2eCredential();
  restoreWindowState();
  if (reminderTask) {
    try {
      execFileSync('schtasks', ['/Delete', '/TN', reminderTask, '/F'], { stdio: 'ignore' });
    } catch {
      /* 이미 없음 */
    }
  }
}
console.log(failed ? `E2E 실패 ${failed}` : 'E2E 통과');
process.exit(failed ? 1 : 0);
