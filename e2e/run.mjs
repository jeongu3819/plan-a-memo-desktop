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

step('search-no-edit-snapshot', async () => {
  const hits = await app.invoke('memo_search', { query: '초안' });
  assert.ok(hits.items.length >= 1, '서식 태그를 무시하고 찾는다');
  await app.invoke('item_update_content', { id: firstItemId, html: 'AWS 비용 확인' });
  await app.invoke('item_update_content', { id: firstItemId, html: 'AWS 비용 확인 — 다시 고침' });
  await app.invoke('item_update_content', { id: firstItemId, html: 'AWS 비용 확인' });
  const history = await app.invoke('history_list', { location: loc() });
  assert.equal(history.length, 0, '일상 편집은 Snapshot 을 남기지 않는다');
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
    assert.equal(await page.getAttribute('[data-testid="sync-header-button"]', 'data-sync-state'), 'local', '연결 전: 이 PC 에만 저장');
    await page.click('[data-testid="sync-header-button"]');
    assert.ok((await page.locator('[data-testid="sync-status-line"]').innerText()).includes('이 PC에만 저장'), '메뉴에서 상태 확인');
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
    await waitFor(async () => (await page.getAttribute('[data-testid="sync-header-button"]', 'data-sync-state')) === 'linked', '연동 아이콘: 연결됨');
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
    assert.ok(history.some(v => v.reason === 'conflict_remote'), '선택하지 않은 PLAN-A Work 내용을 보존한다');
    // 안내한 대로 설정 > 보존된 내용에서 다시 볼 수 있다
    await app.page.click('[data-testid="open-settings"]');
    await app.page.click('[data-testid="settings-preserved"]');
    await app.page.locator('[data-testid="preserved-entry"][data-reason="conflict_remote"]').first().click();
    await waitFor(async () => (await app.page.locator('[data-testid="preserved-detail"]').innerText()).includes('Web 에서 추가한 일'), '선택하지 않은 내용 보기');
    await app.shot('07a-preserved');
    await app.page.locator('[data-testid="preserved-dialog"] button:has-text("닫기")').click();
    await app.page.locator('[data-testid="settings-dialog"] button:has-text("닫기")').last().click();
    await app.page.locator('[role="dialog"]').waitFor({ state: 'detached' });
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
    await app.page.waitForSelector('text=연결하려는 메모의 내용이', { timeout: 5000 });
    await app.shot('07b-first-link-compare');
    await app.page.locator('[data-testid="conflict-dialog"] button:has-text("나중에 선택")').click();
    const items = (await app.invoke('memo_day', { date })).items.map(i => i.contentHtml);
    assert.deepEqual(items, ['AWS 확인(Desktop)'], '고르기 전에는 이 PC 내용을 바꾸지 않는다');
  },
  { mockOnly: true },
);

step(
  'relink-same-content',
  async () => {
    const page = app.page;
    // Staging 충돌을 만든 그대로 — style 끝 ';' 이 있는 이미지·색 글자. Mock 서버도 ';' 를 지워 저장한다.
    const png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 0, 5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];
    const image = await page.evaluate(bytes => window.__TAURI_INTERNALS__.invoke('attachment_import', new Uint8Array(bytes)), png);
    const styled = `글<div><img src="${image.url}" alt="붙여넣은 이미지" style="width: 572px; height: auto;"><br></div><span style="color: rgb(1, 2, 3);">색</span>`;
    const date = plusDays(today, 170);
    const location = { kind: 'day', date };
    await addItem(date, 'main', styled);
    await addItem(date, 'am', '오전 메모');
    const pm = await addItem(date, 'pm', '오후 메모');
    await app.invoke('item_set_completed', { id: pm.id, completed: true });
    const relink = async target => {
      await app.invoke('sync_unlink', { location: target });
      await app.invoke('sync_now');
      await app.invoke('sync_link', { location: target });
      const report = await app.invoke('sync_now');
      assert.equal(report.conflicts, 0, '같은 내용 — 비교 화면 없음');
      assert.equal(report.pushed, 0, '같은 내용을 다시 보내지 않는다');
    };
    await app.invoke('sync_link', { location });
    await app.invoke('sync_now');
    const server = (await dayOf(date)).document.serverVersion;
    const before = (await dayOf(date)).items.map(i => [i.id, i.contentHtml, i.completed]);
    for (let round = 0; round < 3; round++) await relink(location);
    const after = await dayOf(date);
    assert.equal(after.document.syncStatus, 'synced', 'DAY 자동 연결');
    assert.equal(after.document.serverVersion, server, '서버 version 그대로');
    assert.deepEqual(after.items.map(i => [i.id, i.contentHtml, i.completed]), before, '메모·이미지·체크 그대로');
    assert.equal((await app.invoke('conflicts_list')).filter(c => c.location.date === date).length, 0);
    // 화면에서 다시 연결해도 비교 창 없이 간단한 안내만
    await openDate(date);
    await page.click('[data-testid="sync-header-button"]');
    await page.locator('[data-testid="sync-unlink"]').click();
    await waitFor(async () => !(await dayOf(date)).document.syncEnabled, '해제');
    await page.mouse.move(5, 300);
    await page.click('[data-testid="sync-header-button"]');
    await page.click('[data-testid="sync-link-button"]');
    await page.locator('text=PLAN-A Work와 연결되었습니다.').waitFor({ timeout: 5000 });
    await waitFor(async () => (await dayOf(date)).document.syncStatus === 'synced', '화면에서 다시 연결');
    await sleep(800);
    assert.equal(await page.locator('[data-testid="conflict-dialog"]').count(), 0, '비교 창이 뜨지 않는다');
    await app.shot('07c-relink-same');
    // NEXT_LIST
    const list = await app.invoke('list_create', { name: '재연결 시험' });
    const listLocation = { kind: 'next', listId: list.id };
    await app.invoke('item_create', { input: { id: crypto.randomUUID(), location: listLocation, section: 'next', kind: 'checklist', contentHtml: '<span style="color: rgb(9, 9, 9);">List 메모</span>' } });
    await app.invoke('sync_link', { location: listLocation });
    await app.invoke('sync_now');
    await relink(listLocation);
    assert.equal((await app.invoke('memo_list', { listId: list.id })).list.document.syncStatus, 'synced', 'NEXT_LIST 자동 연결');
    // 실제로 다르면 — 비교 화면, 양쪽 그대로
    await app.invoke('sync_unlink', { location });
    await app.invoke('sync_now');
    await app.invoke('mock_remote_edit', { location, text: '해제 뒤 Web 에서 추가' });
    await app.invoke('sync_link', { location });
    assert.equal((await app.invoke('sync_now')).conflicts, 1, '실제 차이 — 비교 화면');
    const conflict = (await app.invoke('conflicts_list')).find(c => c.location.date === date);
    assert.equal(conflict.local.items.length, 3);
    assert.ok(conflict.remote.items.some(i => i.contentHtml === '해제 뒤 Web 에서 추가'));
    assert.deepEqual((await dayOf(date)).items.map(i => [i.id, i.contentHtml, i.completed]), before, '고르기 전에는 바꾸지 않는다');
    await page.reload();
    await page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
    // 뒤 단계에 영향 없게 이 PC 내용을 골라 끝낸다
    await app.invoke('conflict_resolve', { id: conflict.id, choice: 'local' });
    await waitFor(async () => (await dayOf(date)).document.syncStatus === 'synced', '선택 반영');
  },
  { mockOnly: true },
);

step(
  'linked-list-rename-refused',
  async () => {
    const page = app.page;
    const list = await app.invoke('list_create', { id: crypto.randomUUID(), name: '앱 개발' });
    await app.invoke('sync_link', { location: { kind: 'next', listId: list.id } });
    await app.invoke('sync_now');
    const before = (await app.invoke('sync_overview')).outbox; // 앞 단계의 '나중에 선택' 비교 1건은 그대로 대기
    const error = await app.invokeError('list_rename', { id: list.id, name: '앱 개발 2' });
    assert.equal(error.code, 'linked_list_managed');
    assert.equal((await app.invoke('sync_overview')).outbox, before, '보낼 것이 생기지 않는다');
    const info = await app.invoke('memo_list', { listId: list.id });
    assert.equal(info.list.name, '앱 개발', '이름 그대로');
    assert.equal(info.list.document.syncStatus, 'synced', '연결 그대로');
    // 화면: 메뉴에 이유가 보이고 × 가 없다
    await page.reload();
    await page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
    await page.click('[data-testid="memo-search-open"]');
    await page.locator('[data-testid="personal-memo-browse"] button').filter({ hasText: '앱 개발' }).first().click();
    const tab = page.locator(`[data-testid="memo-next-list-tab"][data-list-id="${list.id}"]`);
    await tab.waitFor();
    await tab.hover();
    assert.equal(await tab.locator('[data-testid="memo-next-list-delete"]').count(), 0, '연결된 List 에는 × 가 없다');
    await tab.click({ button: 'right' });
    const rename = page.locator('[data-testid="memo-next-list-rename"]');
    await rename.waitFor();
    assert.equal(await rename.getAttribute('aria-disabled'), 'true', '이름 변경 막힘');
    assert.ok((await rename.innerText()).includes('연결된 List의 이름 변경은 PLAN-A Work 공통 관리 기능이 준비된 후 사용할 수 있습니다.'), '이유 안내');
    assert.equal(await page.getAttribute('[data-testid="memo-next-list-context-delete"]', 'aria-disabled'), 'true', '삭제 막힘');
    await app.shot('26-linked-list-menu');
    await page.keyboard.press('Escape');
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
  const TOOLS = ['memo-search-open', 'memo-today', 'sync-header-button', 'carryover-open', 'open-settings'];
  assert.deepEqual(await order(), TOOLS, '주간: 검색 → 오늘 → 연동 → 가져오기 → 설정');
  assert.equal(await page.locator('[data-testid="open-settings"]').count(), 1, '설정 입구는 하나');
  assert.ok(await page.locator('[data-testid="carryover-open"]').isDisabled(), '주간에는 가져올 기준 날짜가 없다');
  // 같은 높이·세로 정렬
  const boxes = await page.$$eval('[data-testid="memo-header-tools"] > *', nodes => nodes.map(n => n.getBoundingClientRect()).map(r => [Math.round(r.top), Math.round(r.height)]));
  assert.ok(boxes.every(([top, h]) => h === boxes[0][1] && Math.abs(top - boxes[0][0]) <= 1), `도구 높이·정렬 ${JSON.stringify(boxes)}`);
  // 주간 이동(‹ ›)은 도구 바로 왼쪽, 표지(날짜·인사말)와 같은 줄 — 본문 위에 따로 이동 줄이 없다
  const sameRow = async selector => {
    const [nav, tools, title] = await Promise.all(
      [selector, '[data-testid="memo-header-tools"]', '[data-testid="memo-header-date"]'].map(s => page.locator(s).boundingBox()),
    );
    assert.ok(Math.abs(nav.y + nav.height / 2 - (tools.y + tools.height / 2)) <= 2, `${selector} 와 도구가 같은 줄`);
    assert.ok(nav.x + nav.width <= tools.x && nav.x > title.x + 200, `${selector} 는 오른쪽 도구 왼쪽`);
    assert.ok(tools.y < title.y + title.height, '조작 묶음이 표지 줄에 있다');
  };
  const monday = plusDays(today, -weekdayIndex(today));
  await page.click('[aria-label="다음 주"]');
  await page.locator(`[data-testid="memo-cell-${plusDays(monday, 7)}"]`).waitFor();
  await page.click('[aria-label="지난주"]');
  await page.locator(`[data-testid="memo-cell-${monday}"]`).waitFor();
  await page.mouse.move(5, 300);
  await sameRow('[data-testid="personal-memo-nav"]');
  await app.shot('20-header-week');
  // [오늘] → 오늘 날짜 상세(메인·오전·오후 + 다가오는 같은 요일)
  await page.click('[data-testid="memo-today"]');
  await page.waitForSelector('[data-testid="memo-section-main"]');
  await page.waitForSelector('[data-testid="upcoming-weekday"]');
  assert.equal(await page.getAttribute('[data-testid="memo-today"]', 'aria-pressed'), 'true');
  assert.deepEqual(await order(), TOOLS, '날짜 상세: 같은 순서');
  assert.ok(await page.locator('[data-testid="carryover-open"]').isEnabled(), '날짜 상세에서는 가져오기를 쓸 수 있다');
  assert.ok(await page.locator('[data-testid="memo-back-to-week"]').isVisible(), '← 주간 유지');
  // 날짜 상세: 한 줄 = ← 주간 ‹ 요일 Today › │ 검색·오늘·연동·가져오기·설정 — 본문 위 보조 줄 없음
  await sameRow('[data-testid="memo-header-nav"]');
  assert.equal(await page.locator('[data-testid="personal-memo-view-label"]').innerText(), `${['월', '화', '수', '목', '금', '토', '일'][weekdayIndex(today)]}요일`, '요일 표시');
  assert.equal(await page.locator('[data-testid="sync-link-control"]').count(), 0, '연결·History 보조 줄 없음');
  // 아이콘 설명
  await page.locator('[data-testid="sync-header-button"]').hover();
  await page.locator('[role="tooltip"]:has-text("PLAN-A Work 연동")').waitFor({ timeout: 5000 });
  await page.locator('[data-testid="carryover-open"]').hover();
  await page.locator('[role="tooltip"]:has-text("지난 미완료 가져오기")').waitFor({ timeout: 5000 });
  await page.mouse.move(5, 300);
  // 일반 변경 이력 메뉴는 어디에도 없다(보존된 내용은 설정에서)
  await page.click('[data-testid="sync-header-button"]');
  assert.ok(!(await page.locator('[data-testid="sync-header-menu"]').innerText()).includes('History'), '연동 메뉴에 History 없음');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-testid="memo-doc-menu"]').count(), 0, '요일에 변경 이력 메뉴 없음');
  await page.mouse.move(5, 300);
  // 빈 날짜는 메인·오전·오후가 적당한 기본 높이 — 다음 구역이 첫 화면에 보인다(자세히는 e2e/section-heights.mjs)
  const grid = await page.locator('[data-testid="personal-memo-day-sections"]').boundingBox();
  const viewport = page.viewportSize() ?? (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })));
  assert.ok(grid.height >= 420 && grid.y + grid.height < viewport.height, `메모 구역 높이 ${grid.height} / ${viewport.height}`);
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
  // 검색: 팝업 없이 머리 줄의 아이콘 자리가 입력칸으로 펼쳐지고 결과는 본문(찾아보기). 같은 높이로 겹치지 않는다.
  await page.click('[data-testid="memo-search-open"]');
  const search = page.locator('[data-testid="memo-header-tools"] [data-testid="memo-search-input"]');
  await search.waitFor();
  assert.ok(await search.evaluate(el => el === document.activeElement), '검색 입력칸에 바로 커서');
  assert.equal(await page.locator('[data-testid="memo-search-input"]').count(), 1, '입력칸은 머리 줄 하나뿐(본문에 두 번째 입력칸 없음)');
  assert.equal(await page.locator('[role="dialog"]').count(), 0, '검색 팝업 없음');
  const field = await page.locator('[data-testid="memo-search-field"]').boundingBox();
  assert.ok(Math.round(field.height) === 32 && field.x + field.width <= 851, `머리 줄 안의 입력칸 ${JSON.stringify(field)}`);
  await search.type('예약');
  await page.locator('[data-testid="personal-memo-browse"]').waitFor();
  await app.shot('21-search-inline-small');
  await search.press('Escape');
  assert.equal(await search.inputValue(), '', 'Esc 1회: 검색어 지우기');
  await search.press('Escape');
  await page.waitForSelector('[data-testid="memo-section-main"]');
  assert.equal(await page.locator('[data-testid="memo-search-input"]').count(), 0, 'Esc 2회: 원래 날짜 상세로');
  await page.setViewportSize(original);
  await app.shot('21-today-detail');
  // [← 주간] → 오늘이 든 주
  await page.click('[data-testid="memo-back-to-week"]');
  await page.waitForSelector(`[data-testid="memo-cell-${today}"]`);
});

// ── 날짜 표시 · 서식 메뉴 · 맨 위로 보내기 ──────────────────────────────────
const WEEKDAY_NAMES = ['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const englishDate = date => {
  const [y, m, d] = date.split('-').map(Number);
  return `${MONTHS_EN[m - 1]} ${d}, ${y}`;
};

step('date-labels', async () => {
  const page = app.page;
  await page.reload();
  await page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  await page.setViewportSize({ width: 1180, height: 760 });
  const title = () => page.locator('[data-testid="memo-header-date"]').innerText();
  const label = () => page.locator('[data-testid="personal-memo-view-label"]').innerText();
  const badge = page.locator('[data-testid="personal-memo-nav"] [data-testid="memo-today-badge"]');
  const toolsBox = () => page.locator('[data-testid="memo-header-tools"]').boundingBox();
  const monday = plusDays(today, -weekdayIndex(today));

  // 주간: 문구 없이 ‹ › 만 — 날짜는 요일 칸마다 있다
  assert.equal(await page.locator('[data-testid="personal-memo-week-range"]').count(), 0);
  assert.equal((await page.locator('[data-testid="memo-header-nav"]').innerText()).trim(), '', '주간 이동 영역에 글자 없음');
  assert.ok(!(await page.locator('[data-testid="memo-dialog-header"]').innerText()).includes('이번 주'), '머리에 이번 주 없음');
  assert.equal(await title(), englishDate(today));
  assert.ok((await page.locator(`[data-testid="memo-cell-${today}"]`).innerText()).includes('Today'), '오늘 칸 강조 유지');
  const weekTools = await toolsBox();
  await app.shot('30-week-header');
  await page.click('[aria-label="지난주"]');
  await page.locator(`[data-testid="memo-cell-${plusDays(monday, -7)}"]`).waitFor();
  await page.click('[aria-label="다음 주"]');
  await page.click('[aria-label="다음 주"]');
  await page.locator(`[data-testid="memo-cell-${plusDays(monday, 7)}"]`).waitFor();
  assert.equal(await title(), englishDate(today), '주간 제목은 오늘 날짜');
  assert.deepEqual(await toolsBox(), weekTools, '주를 옮겨도 도구 자리 그대로');
  await page.click('[aria-label="지난주"]');
  await page.locator(`[data-testid="memo-cell-${monday}"]`).waitFor();

  // 오늘 날짜 상세: 큰 제목 + 요일 + Today
  await page.click('[data-testid="memo-today"]');
  await page.waitForSelector('[data-testid="memo-section-main"]');
  assert.equal(await title(), englishDate(today));
  assert.equal(await label(), WEEKDAY_NAMES[weekdayIndex(today)]);
  assert.equal(await badge.count(), 1, '오늘이면 Today');
  assert.deepEqual(await toolsBox(), weekTools, '주간 ↔ 날짜 상세에서 도구 자리 그대로');
  await app.shot('31-day-today');

  // 다른 날짜: 다음 날 7번 — 모든 요일(토·일 포함), 날짜 반복 없음, Today 없음
  const marker = plusDays(today, 2);
  await addItem(marker, 'main', '이틀 뒤 메모');
  for (let n = 1; n <= 7; n++) {
    await page.click('[aria-label="다음 날"]');
    const date = plusDays(today, n);
    await waitFor(async () => (await title()) === englishDate(date), `제목 ${date}`);
    assert.equal(await label(), WEEKDAY_NAMES[weekdayIndex(date)], `요일 ${date}`);
    assert.doesNotMatch(await page.locator('[data-testid="personal-memo-nav"]').innerText(), /\d/, '이동 영역에 날짜 숫자 없음');
    assert.equal(await badge.count(), 0, '오늘이 아니면 Today 없음');
    assert.deepEqual(await toolsBox(), weekTools, '날짜를 옮겨도 도구 자리 그대로');
    if (date === marker) {
      await page.locator('[data-testid="memo-section-main"] >> text=이틀 뒤 메모').waitFor();
      await app.shot('32-day-other');
    }
  }
  // 과거로 — 어제
  for (let n = 6; n >= -1; n--) await page.click('[aria-label="전날"]');
  await waitFor(async () => (await title()) === englishDate(plusDays(today, -1)), '과거 날짜');
  assert.equal(await label(), WEEKDAY_NAMES[weekdayIndex(plusDays(today, -1))]);
  // [오늘] → 실제 오늘, ← 주간 → 그 주
  await page.click('[data-testid="memo-today"]');
  await waitFor(async () => (await title()) === englishDate(today), '오늘로');
  assert.equal(await badge.count(), 1);
  await page.click('[aria-label="다음 날"]');
  await page.click('[data-testid="memo-back-to-week"]');
  await page.waitForSelector('[data-testid="personal-memo-week"]');
  assert.equal(await title(), englishDate(today), '주간으로 돌아오면 제목은 오늘');

  // 해가 다른 날짜: 제목이 연도를 보여 주므로 요일에 연도를 붙이지 않는다
  await openDate('2027-01-01');
  assert.equal(await title(), 'January 1, 2027');
  assert.equal(await label(), '금요일');

  // Next List: 제목은 오늘, 이동 영역은 List 이름 — 화살표 없음
  await page.click('[data-testid="memo-back-to-week"]');
  await page.click('[data-testid="memo-cell-next"] button[aria-label$="메모 쓰기"]');
  await page.waitForSelector('[data-testid="memo-section-next"]');
  assert.equal(await title(), englishDate(today));
  assert.equal(await label(), 'Next');
  assert.equal(await page.locator('[aria-label="전날"]').count(), 0);
  assert.deepEqual(await toolsBox(), weekTools, 'Next List 에서도 도구 자리 그대로');
  await app.shot('33-next-list');
  await page.click('[data-testid="memo-back-to-week"]');

  // 찾아보기: 제목 유지. 가장 긴 조합(긴 달 + ← 목록 주간)으로 최소 창에서 겹침·잘림 확인
  await addItem('2026-09-30', 'main', '긴 달 이름 메모');
  await page.click('[data-testid="memo-search-open"]');
  const search = page.locator('[data-testid="memo-search-input"]');
  await search.waitFor();
  assert.equal(await title(), englishDate(today));
  await app.shot('34-search');
  await search.fill('9.30');
  await page.locator('[data-testid="memo-search-date-hit"]').first().click();
  await page.waitForSelector('[data-testid="memo-section-main"]');
  assert.equal(await title(), 'September 30, 2026');
  const notClipped = async width => {
    const clipped = await page.locator('[data-testid="memo-header-date"]').evaluate(el => el.scrollWidth > el.clientWidth + 1);
    assert.ok(!clipped, `${width}px: 제목 잘림 없음`);
    const rects = await page.$$eval('[data-testid="personal-memo-view-header"] button', nodes => nodes.map(n => n.getBoundingClientRect().toJSON()));
    const head = await page.locator('[data-testid="memo-header-date"]').evaluate(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().toJSON();
    });
    for (let i = 0; i < rects.length; i++) {
      const a = rects[i];
      assert.ok(a.right <= width + 1, `${width}px: 버튼이 창 안에`);
      assert.ok(!(head.left < a.right - 1 && a.left < head.right - 1 && head.top < a.bottom - 1 && a.top < head.bottom - 1), `${width}px: 제목과 버튼이 겹치지 않음`);
      for (let j = i + 1; j < rects.length; j++) {
        const b = rects[j];
        assert.ok(!(a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1), `${width}px: 버튼끼리 겹치지 않음`);
      }
    }
  };
  await page.setViewportSize({ width: 850, height: 620 });
  await sleep(150);
  await notClipped(850);
  await app.shot('35-long-date-850');
  const row = async () => {
    const [nav, head] = await Promise.all(['[data-testid="memo-header-tools"]', '[data-testid="memo-header-date"]'].map(s => page.locator(s).boundingBox()));
    return nav.y < head.y + head.height;
  };
  assert.ok(await row(), '최소 창에서도 제목과 도구가 한 줄');
  // 가장 넓은 조합(오늘 Today 배지 + 긴 달 이름)도 최소 창에서 한 줄에 든다 — 오늘이 그 달이 아니어도 폭으로 확인
  await page.click('[data-testid="memo-today"]');
  await page.locator('[data-testid="personal-memo-nav"] [data-testid="memo-today-badge"]').waitFor();
  const controls = await page.locator('[data-testid="personal-memo-view-header"]').boundingBox();
  const longTitle = await page.locator('[data-testid="memo-header-date"]').evaluate(el => {
    const probe = el.cloneNode(true);
    probe.textContent = 'September 30, 2026';
    Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', width: 'auto', overflow: 'visible' });
    el.parentElement.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  });
  assert.ok(longTitle + 16 + controls.width <= 850 - 48, `제목 ${longTitle} + 조작 ${controls.width} 가 최소 창에 든다`);
  await app.shot('35-today-850');
  await page.setViewportSize({ width: 620, height: 620 });
  await sleep(150);
  await notClipped(620);
  await app.shot('36-long-date-620');
  await page.setViewportSize({ width: 1180, height: 760 });
  await page.click('[data-testid="memo-back-to-week"]');
});

// 서식 메뉴 공통 조작 — 실제 마우스 우클릭(CDP)으로 연다.
const menuOf = page => page.locator('[data-testid="rich-text-context-menu"]');
const pressed = (page, label) => menuOf(page).locator(`[aria-label="${label}"]`).getAttribute('aria-pressed');
/** 글자를 찾아 선택(text 가 없으면 전체) */
const selectText = (editable, text) =>
  editable.evaluate((el, target) => {
    const selection = window.getSelection();
    const range = document.createRange();
    el.focus();
    if (!target) {
      range.selectNodeContents(el);
    } else {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      for (node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent.indexOf(target);
        if (at >= 0) {
          range.setStart(node, at);
          range.setEnd(node, at + target.length);
          break;
        }
      }
      if (!node) throw new Error(`글자 없음: ${target}`);
    }
    selection.removeAllRanges();
    selection.addRange(range);
  }, text);
/** 커서를 그 글자 끝으로 */
const caretAt = (editable, text) =>
  editable.evaluate((el, target) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    el.focus();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent.indexOf(target);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at + target.length);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error(`글자 없음: ${target}`);
  }, text);
async function openMenu(page, editable) {
  await menuOf(page).waitFor({ state: 'detached' });
  const point = await editable.evaluate(el => {
    const selection = window.getSelection();
    const rects = selection.getRangeAt(0).getClientRects();
    const rect = rects[0] ?? el.getBoundingClientRect();
    return { x: rect.left + Math.min(rect.width / 2, 40), y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await menuOf(page).waitFor();
  return menuOf(page);
}

step('rich-menu', async () => {
  const page = app.page;
  const date = plusDays(today, 40);
  const created = await addItem(date, 'main', '가나다 라마바 사아자 차카타 파하');
  await openDate(date);
  await page.setViewportSize({ width: 1180, height: 760 });
  const row = page.locator(`[data-memo-id="${created.id}"]`);
  await row.locator('[aria-label="메모 편집"]').click();
  const editable = row.locator('[contenteditable="true"]');
  await editable.waitFor();
  const html = async () => (await dayOf(date)).items.find(i => i.id === created.id).contentHtml;
  const saved = (test, message) => waitFor(async () => test(await html()), message);
  const click = async label => menuOf(page).locator(`[aria-label="${label}"]`).click();

  // 메뉴 구성 — 영역 제목과 버튼
  await selectText(editable, '가나다');
  await openMenu(page, editable);
  const menuText = await menuOf(page).innerText();
  for (const word of ['글자 크기', '글자 색상', '목록 · 들여쓰기', '맨 위로 보내기', '기본']) assert.ok(menuText.includes(word), `메뉴에 ${word}`);
  assert.equal(await pressed(page, '기본 크기'), 'true', '지정 없으면 기본 크기 강조');
  assert.equal(await pressed(page, '글자 크기 15'), 'false', '본문 크기를 숫자로 강조하지 않음');
  assert.equal(await pressed(page, '기본 색'), 'true');
  await app.shot('40-rich-menu');
  const box = await menuOf(page).boundingBox();
  assert.ok(box.width <= 260, `메뉴 폭 ${box.width}`);
  // 누르는 동안 선택이 풀리지 않는다 / Esc 로 닫아도 그대로
  await page.keyboard.press('Escape');
  await menuOf(page).waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.getSelection().toString()), '가나다', 'Esc 후 선택 유지');
  assert.ok(await editable.evaluate(el => el === document.activeElement), 'Esc 후 편집기 포커스 유지');

  // 굵게 · 밑줄 · 취소선 — 저장, 선택 유지, 다시 열면 강조
  await openMenu(page, editable);
  await click('굵게');
  await saved(h => /<(b|strong)>가나다<\/(b|strong)>/.test(h), '굵게 저장');
  assert.equal(await page.evaluate(() => window.getSelection().toString()), '가나다', '굵게 후 선택 유지');
  await openMenu(page, editable);
  assert.equal(await pressed(page, '굵게'), 'true', '다시 열면 굵게 강조');
  await page.keyboard.press('Escape');
  await selectText(editable, '라마바');
  await openMenu(page, editable);
  assert.equal(await pressed(page, '굵게'), 'false', '다른 글자는 굵게 아님');
  await click('밑줄');
  await saved(h => /<u>라마바<\/u>/.test(h), '밑줄 저장');
  await selectText(editable, '사아자');
  await openMenu(page, editable);
  await click('취소선');
  await saved(h => /<s>사아자<\/s>/.test(h), '취소선 저장');
  assert.doesNotMatch(await html(), /<strike/, '저장 표현은 <s>');

  // Undo → Redo (브라우저 기본 이력 + 자동 저장)
  await page.keyboard.press('Control+z');
  await saved(h => !h.includes('<s>') && h.includes('사아자'), 'Undo 저장');
  await page.keyboard.press('Control+y');
  await saved(h => /<s>사아자<\/s>/.test(h), 'Redo 저장');

  // 기존 단축키 — 기울임 Ctrl+I
  await selectText(editable, '차카타');
  await page.keyboard.press('Control+i');
  await saved(h => /<(i|em)>차카타<\/(i|em)>/.test(h), 'Ctrl+I 저장');

  // 글자 크기 — 기본 첫 칸, 현재 크기 강조, 기본으로 되돌리기
  await selectText(editable, '파하');
  await openMenu(page, editable);
  await click('글자 크기 20');
  await saved(h => /data-text-size="20"[^>]*>파하/.test(h), '크기 저장');
  await openMenu(page, editable);
  assert.equal(await pressed(page, '글자 크기 20'), 'true', '현재 크기 강조');
  assert.equal(await pressed(page, '기본 크기'), 'false');
  await click('기본 크기');
  await saved(h => !h.includes('data-text-size="20"') && h.includes('파하'), '기본 크기 저장');

  // 글자 색 — 현재 색 강조, Undo/Redo
  await openMenu(page, editable);
  await click('글자 색 #EF4444');
  await saved(h => /color:\s*(rgb\(239, 68, 68\)|#ef4444)/i.test(h) && h.includes('파하'), '색 저장');
  await openMenu(page, editable);
  assert.equal(await pressed(page, '글자 색 #EF4444'), 'true', '현재 색 강조');
  assert.equal(await pressed(page, '기본 색'), 'false');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await saved(h => !/color:/i.test(h), '색 Undo 저장');
  await page.keyboard.press('Control+y');
  await saved(h => /color:/i.test(h), '색 Redo 저장');

  // 링크 — 추가 · 수정 · 해제(글자는 그대로)
  await selectText(editable, '차카타');
  await openMenu(page, editable);
  assert.equal(await pressed(page, '링크'), 'false');
  await click('링크');
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  assert.ok((await dialog.innerText()).includes('링크 삽입'));
  await dialog.locator('input').nth(1).fill('example.com/first');
  await dialog.locator('button:has-text("적용")').click();
  await dialog.waitFor({ state: 'detached' });
  await saved(h => /href="https:\/\/example\.com\/first"/.test(h) && h.includes('차카타'), '링크 저장');
  await page.waitForTimeout(100);
  await page.mouse.move(5, 300);
  await caretAt(editable, '차카');
  await openMenu(page, editable);
  assert.equal(await pressed(page, '링크'), 'true', '링크 안이면 강조');
  await click('링크');
  await dialog.waitFor();
  assert.ok((await dialog.innerText()).includes('링크 편집'), '링크 안에서 누르면 편집');
  assert.ok((await dialog.locator('input').nth(1).inputValue()).includes('example.com/first'));
  await dialog.locator('input').nth(1).fill('example.com/second');
  await dialog.locator('button:has-text("적용")').click();
  await dialog.waitFor({ state: 'detached' });
  await saved(h => h.includes('example.com/second') && !h.includes('example.com/first'), '링크 수정 저장');
  assert.equal(((await html()).match(/<a /g) ?? []).length, 1, '링크가 겹치지 않음');
  await caretAt(editable, '차카');
  await openMenu(page, editable);
  await click('링크');
  await dialog.waitFor();
  await dialog.locator('button:has-text("링크 제거")').click();
  await dialog.waitFor({ state: 'detached' });
  await saved(h => !h.includes('<a ') && h.includes('차카타'), '링크 해제 저장');

  await page.locator('[data-testid="memo-header-date"]').click();
  await page.locator(`[data-memo-id="${created.id}"] [aria-label="메모 편집"]`).waitFor();
  const final = await html();
  for (const [name, pattern] of [
    ['굵게', /<(b|strong)>가나다/],
    ['밑줄', /<u>라마바/],
    ['취소선', /<s>사아자/],
  ]) assert.match(final, pattern, `편집을 끝낸 뒤에도 ${name}`);
  await app.shot('41-rich-formats-read');
  assert.deepEqual(app.consoleErrors.filter(e => !/favicon/i.test(e)), [], '콘솔 오류 없음');
});

step('rich-menu-lists', async () => {
  const page = app.page;
  const date = plusDays(today, 41);
  const created = await addItem(date, 'main', '<div>첫째 줄</div><div>둘째 줄</div><div>셋째 줄</div>');
  await openDate(date);
  await page.setViewportSize({ width: 1180, height: 760 });
  const row = page.locator(`[data-memo-id="${created.id}"]`);
  const openEdit = async () => {
    await row.locator('[aria-label="메모 편집"]').click();
    await row.locator('[contenteditable="true"]').waitFor();
  };
  await openEdit();
  const editable = row.locator('[contenteditable="true"]');
  const html = async () => (await dayOf(date)).items.find(i => i.id === created.id).contentHtml;
  const saved = (test, message) => waitFor(async () => test(await html()), message);
  const click = async label => menuOf(page).locator(`[aria-label="${label}"]`).click();
  const items = () => editable.locator('li').allInnerTexts();

  // 글머리 기호 → 번호 1. → 1) → ① (글자·항목 수는 그대로)
  await selectText(editable);
  await openMenu(page, editable);
  assert.ok(await menuOf(page).locator('[aria-label="들여쓰기"]').isDisabled(), '목록 밖에서는 들여쓰기 꺼짐');
  await click('글머리 기호');
  await saved(h => /<ul>/.test(h) && (h.match(/<li/g) ?? []).length === 3, '글머리 저장');
  await selectText(editable, '둘째');
  await openMenu(page, editable);
  assert.equal(await pressed(page, '글머리 기호'), 'true');
  assert.ok(await menuOf(page).locator('[aria-label="들여쓰기"]').isEnabled(), '목록 안에서 들여쓰기 켜짐');
  await page.keyboard.press('Escape');
  await selectText(editable);
  await openMenu(page, editable);
  await click('글머리 기호');
  await saved(h => !/<ul>/.test(h), '같은 종류를 다시 누르면 목록 끄기');
  for (const line of ['첫째 줄', '둘째 줄', '셋째 줄']) assert.ok((await html()).includes(line), `글자 유지 ${line}`);
  await selectText(editable);
  await openMenu(page, editable);
  await click('번호 1.');
  await saved(h => /<ol[^>]*data-list-style="decimal"/.test(h) && (h.match(/<li/g) ?? []).length === 3, '번호 저장');
  await page.keyboard.press('Control+a'); // 전체 선택 — 표기만 바뀌고 목록이 꺼지지 않는다
  await openMenu(page, editable);
  assert.equal(await pressed(page, '번호 1.'), 'true', '전체 선택도 목록 안');
  await click('번호 1)');
  await saved(h => /data-list-style="paren"/.test(h), '1) 저장');
  await selectText(editable);
  await openMenu(page, editable);
  assert.equal(await pressed(page, '번호 1)'), 'true');
  await click('원형 숫자 ①');
  await saved(h => /data-list-style="circled"/.test(h), '① 저장');
  assert.deepEqual((await items()).map(t => t.trim()), ['첫째 줄', '둘째 줄', '셋째 줄'], '글자·순서 그대로');
  assert.equal(await editable.locator('ol').first().evaluate(el => getComputedStyle(el).listStyleType), 'rich-circled', '① 표기 적용');
  await app.shot('42-list-circled');

  // 표기 변경의 Undo / Redo
  await page.keyboard.press('Control+z');
  await saved(h => /data-list-style="paren"/.test(h), '표기 Undo');
  await page.keyboard.press('Control+y');
  await saved(h => /data-list-style="circled"/.test(h), '표기 Redo');

  // 들여쓰기 · 내어쓰기(메뉴 · Tab) — 다른 항목을 건드리지 않는다
  await caretAt(editable, '둘째');
  await openMenu(page, editable);
  await click('들여쓰기');
  await saved(h => /<ol[^>]*>.*<ol[^>]*>\s*<li[^>]*>둘째 줄/s.test(h), '들여쓰기 저장');
  assert.doesNotMatch(await html(), /data-text-size/, '고르지 않은 크기가 굳지 않는다');
  await app.shot('43-list-indent');
  await caretAt(editable, '둘째');
  await openMenu(page, editable);
  await click('내어쓰기');
  await saved(h => (h.match(/<ol/g) ?? []).length === 1, '내어쓰기 저장');
  await caretAt(editable, '셋째');
  await page.keyboard.press('Tab');
  await saved(h => (h.match(/<ol/g) ?? []).length === 2, 'Tab 들여쓰기');
  assert.ok(await editable.evaluate(el => el === document.activeElement), 'Tab 후 포커스 유지');
  await page.keyboard.press('Shift+Tab');
  await saved(h => (h.match(/<ol/g) ?? []).length === 1, 'Shift+Tab 내어쓰기');
  assert.deepEqual((await items()).map(t => t.trim()), ['첫째 줄', '둘째 줄', '셋째 줄'], '들여쓰기 뒤에도 글자·순서 그대로');

  // 목록 이어쓰기 — Enter 로 다음 번호, 새 항목에 글자
  await caretAt(editable, '셋째 줄');
  await page.keyboard.press('Enter');
  await page.keyboard.type('넷째 줄');
  await saved(h => (h.match(/<li/g) ?? []).length === 4 && h.includes('넷째 줄'), '번호 이어쓰기');
  assert.equal(await page.evaluate(() => window.getSelection().anchorNode.textContent), '넷째 줄', '커서가 새 항목에');

  // Undo 로 목록을 만들기 전까지 되돌려도 글자를 잃지 않는다
  for (let n = 0; n < 6; n++) await page.keyboard.press('Control+z');
  for (let n = 0; n < 6; n++) await page.keyboard.press('Control+y');
  await saved(h => h.includes('넷째 줄') && h.includes('첫째 줄'), 'Undo·Redo 뒤 글자 유지');

  // 편집을 끝낸 읽기 화면에서도 같은 표기, 다시 열어도 그대로
  await page.locator('[data-testid="memo-header-date"]').click();
  const readList = row.locator('ol').first();
  await readList.waitFor();
  assert.equal(await readList.evaluate(el => getComputedStyle(el).listStyleType), 'rich-circled', '읽기 화면도 ①');
  await app.shot('44-list-read');
  await openEdit();
  assert.equal(await editable.locator('ol').first().getAttribute('data-list-style'), 'circled', '다시 열어도 ①');

  // 번호 흐름 잇기 — 위 목록 다음 번호, 그 사이 다른 글이 있으면 1 부터
  await page.locator('[data-testid="memo-header-date"]').click();
  const flow = await addItem(date, 'am', '<ol data-list-style="decimal"><li>일</li><li>이</li></ol><p><br></p><div>삼</div>');
  await page.reload();
  await page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  await openDate(date);
  const flowRow = page.locator(`[data-memo-id="${flow.id}"]`);
  await flowRow.locator('[aria-label="메모 편집"]').click();
  const flowEdit = flowRow.locator('[contenteditable="true"]');
  await flowEdit.waitFor();
  await caretAt(flowEdit, '삼');
  await openMenu(page, flowEdit);
  await menuOf(page).locator('[aria-label="번호 1."]').click();
  await waitFor(async () => /<ol[^>]*start="3"/.test((await dayOf(date)).items.find(i => i.id === flow.id).contentHtml), '이어서 3 부터');
  await page.locator('[data-testid="memo-header-date"]').click();
  assert.deepEqual(app.consoleErrors.filter(e => !/favicon/i.test(e)), [], '콘솔 오류 없음');
});

step('rich-menu-content-safety', async () => {
  const page = app.page;
  const date = plusDays(today, 42);
  const longText = '긴 줄 시작 ' + '가나다라마바사아자차카타파하 '.repeat(9000) + ' [END-LONG]';
  const table = '<table><tbody><tr><td>칸1</td><td>칸2</td></tr></tbody></table>';
  const created = await addItem(date, 'main', `<p>서식 대상 글자</p>${table}<p>${longText}</p>`);
  await openDate(date);
  await page.setViewportSize({ width: 1180, height: 760 });
  const row = page.locator(`[data-memo-id="${created.id}"]`);
  await row.locator('[aria-label="메모 편집"]').click();
  const editable = row.locator('[contenteditable="true"]');
  await editable.waitFor();
  const html = async () => (await dayOf(date)).items.find(i => i.id === created.id).contentHtml;
  const lengthBefore = (await editable.evaluate(el => el.innerText)).length;

  // 이미지를 함께 넣고
  await editable.evaluate(async el => {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 24;
    c.getContext('2d').fillRect(0, 0, 32, 24);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'capture.png', { type: 'image/png' }));
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el.querySelector('p'));
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await waitFor(async () => (await html()).includes('attachment://'), '이미지 저장');

  // 짧은 글자에 굵게·색·크기·목록을 줘도 나머지(긴 글·표·이미지)는 그대로
  await selectText(editable, '서식 대상');
  await openMenu(page, editable);
  await menuOf(page).locator('[aria-label="굵게"]').click();
  await selectText(editable, '서식 대상');
  await openMenu(page, editable);
  await menuOf(page).locator('[aria-label="글자 색 #3B82F6"]').click();
  await selectText(editable, '서식 대상');
  await openMenu(page, editable);
  await menuOf(page).locator('[aria-label="글자 크기 18"]').click();
  await waitFor(async () => {
    const h = await html();
    return h.includes('data-text-size="18"') && /<(b|strong)>/.test(h);
  }, '서식 저장', 30000);
  await page.locator('[data-testid="memo-header-date"]').click();
  await page.locator(`[data-memo-id="${created.id}"] [aria-label="메모 편집"]`).waitFor();
  const check = async where => {
    const h = await html();
    assert.ok(h.includes('[END-LONG]'), `${where}: 긴 글 끝까지`);
    assert.ok(h.includes('긴 줄 시작'), `${where}: 긴 글 처음`);
    assert.equal((h.match(/가나다라마바사아자차카타파하/g) ?? []).length, 9000, `${where}: 긴 글 반복 수`);
    assert.ok(/<table/.test(h) && h.includes('칸1') && h.includes('칸2'), `${where}: 표`);
    assert.ok(h.includes('attachment://'), `${where}: 이미지`);
    assert.ok(h.includes('data-text-size="18"'), `${where}: 크기`);
    assert.match(h, /<(b|strong)>/, `${where}: 굵게`);
    assert.match(h, /color:/i, `${where}: 색`);
  };
  await check('저장');
  assert.ok(lengthBefore > 100000, `긴 글 ${lengthBefore}자`);

  // 보존된 내용 — 삭제 직전 Snapshot 에 지금 서식이 그대로 담기고, 설정 화면에서도 보인다
  const extra = await addItem(date, 'pm', '이력 남기기');
  await app.invoke('item_delete', { id: extra.id });
  const versions = await app.invoke('history_list', { location: { kind: 'day', date } });
  assert.ok(versions.length > 0, '보존된 내용 있음');
  const detail = await app.invoke('history_get', { versionId: versions[0].id });
  const snapshotItem = detail.snapshot.items.find(i => i.contentHtml?.includes('서식 대상') || i.content_html?.includes('서식 대상'));
  assert.ok(snapshotItem, '보존된 내용에 그 메모');
  const snapshotHtml = snapshotItem.contentHtml ?? snapshotItem.content_html;
  assert.ok(snapshotHtml.includes('data-text-size="18"') && /<table/.test(snapshotHtml) && snapshotHtml.includes('[END-LONG]'), '보존된 내용에 서식·표·긴 글');
  await page.click('[data-testid="open-settings"]');
  await page.click('[data-testid="settings-preserved"]');
  await page.locator('[data-testid="preserved-dialog"]').waitFor();
  await sleep(500);
  await app.shot('45-preserved-formats');
  await page.locator('[data-testid="preserved-dialog"] button:has-text("닫기")').click();
  await page.locator('[data-testid="settings-dialog"] button:has-text("닫기")').last().click();
  await page.locator('[role="dialog"]').waitFor({ state: 'detached' });

  // 강제 종료 후 재실행 — SQLite 에서 그대로 복원(앞 단계의 서식·목록 메모 포함)
  await app.restart();
  await page.isClosed?.();
  await app.page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  await check('재실행');
  const lists = (await dayOf(plusDays(today, 41))).items.find(i => i.section === 'main').contentHtml;
  assert.ok(lists.includes('data-list-style="circled"') && lists.includes('넷째 줄'), '재실행: 번호 표기·글자');
  const formats = (await dayOf(plusDays(today, 40))).items[0].contentHtml;
  assert.match(formats, /<s>사아자<\/s>/, '재실행: 취소선');
});

step('rich-menu-placement', async () => {
  const page = app.page;
  const date = plusDays(today, 43);
  const created = await addItem(date, 'main', '창 가장자리 메뉴');
  await openDate(date);
  await page.setViewportSize({ width: 850, height: 620 });
  const row = page.locator(`[data-memo-id="${created.id}"]`);
  await row.locator('[aria-label="메모 편집"]').click();
  const editable = row.locator('[contenteditable="true"]');
  await editable.waitFor();
  await selectText(editable, '메뉴');
  // 창 오른쪽 아래 끝에서 열려도 창 안에 전부 보이고, 맨 아래 명령까지 누를 수 있다
  await editable.evaluate(el => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 845, clientY: 612 })));
  await menuOf(page).waitFor();
  await sleep(200);
  const box = await menuOf(page).boundingBox();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 850 && box.y + box.height <= 620, `창 안의 메뉴 ${JSON.stringify(box)}`);
  const scrolled = await menuOf(page).evaluate(el => el.scrollHeight - el.clientHeight);
  assert.ok(scrolled <= 1, `최소 창에서 메뉴 안 스크롤 없음(${scrolled})`);
  assert.ok(await menuOf(page).locator('[data-testid="rich-menu-action-move-top"]').isVisible(), '맨 위로 보내기가 보인다');
  await app.shot('46-rich-menu-corner');
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="memo-header-date"]').click();
  await page.setViewportSize({ width: 1180, height: 760 });

  // 오전 · 오후 · Next List 편집에서도 같은 메뉴 — 서식이 그 메모에 저장된다
  const pmItem = await addItem(date, 'pm', '오후 서식');
  const amItem = await addItem(date, 'am', '오전 서식');
  const nextItem = await app.invoke('item_create', { input: { id: crypto.randomUUID(), location: { kind: 'next', listId: null }, section: 'next', kind: 'checklist', contentHtml: 'Next 서식' } });
  await page.reload();
  await page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  await openDate(date);
  const boldInRow = async (id, text, read) => {
    const target = page.locator(`[data-testid="personal-memo-row"][data-memo-id="${id}"]`);
    await target.locator('[aria-label="메모 편집"]').click();
    const edit = target.locator('[contenteditable="true"]');
    await edit.waitFor();
    await selectText(edit, text);
    await openMenu(page, edit);
    await menuOf(page).locator('[aria-label="굵게"]').click();
    await waitFor(async () => new RegExp(`<(b|strong)>${text}`).test(await read()), `${text} 굵게 저장`);
    await page.locator('[data-testid="memo-header-date"]').click();
  };
  const readItem = id => async () => (await dayOf(date)).items.find(i => i.id === id).contentHtml;
  await boldInRow(amItem.id, '오전', readItem(amItem.id));
  await boldInRow(pmItem.id, '오후', readItem(pmItem.id));

  // 크게 편집 창 위에서도 메뉴가 뜨고, 창의 초안에 적용·저장된다(항목 명령은 행 편집에만)
  await page.locator(`[data-memo-id="${pmItem.id}"] [aria-label="메모 편집"]`).click({ button: 'right' });
  await page.locator('[data-testid="personal-memo-menu"] >> text=크게 편집').click();
  const large = page.locator('[data-testid="personal-memo-large-editor"] [contenteditable="true"]');
  await large.waitFor();
  await selectText(large, '서식');
  await openMenu(page, large);
  assert.ok(await menuOf(page).isVisible(), '크게 편집 위의 메뉴');
  assert.equal(await menuOf(page).locator('[data-testid="rich-menu-action-move-top"]').count(), 0, '크게 편집에는 항목 명령 없음');
  await menuOf(page).locator('[aria-label="글자 색 #8B5CF6"]').click();
  await waitFor(async () => /color:/i.test(await readItem(pmItem.id)()), '크게 편집 색 저장');
  await app.shot('50-large-editor-format');
  await page.locator('[data-testid="personal-memo-large-editor"] button:has-text("닫기")').click();
  await page.locator('[data-testid="personal-memo-large-editor"]').waitFor({ state: 'detached' });

  await page.click('[data-testid="memo-back-to-week"]');
  await page.click('[data-testid="memo-cell-next"] button[aria-label$="메모 쓰기"]');
  await page.waitForSelector('[data-testid="memo-section-next"]');
  const readNext = async () => (await app.invoke('memo_list', { listId: null })).items.find(i => i.id === nextItem.id).contentHtml;
  await boldInRow(nextItem.id, 'Next', readNext);
  await page.click('[data-testid="memo-back-to-week"]');
});

step('memo-move-top', async () => {
  const page = app.page;
  const date = plusDays(today, 44);
  const location = { kind: 'day', date };
  const ids = {};
  for (const name of ['A', 'B', 'C']) ids[name] = (await addItem(date, 'main', `맨위 ${name}`)).id;
  for (const name of ['M', 'N', 'O']) ids[name] = (await addItem(date, 'am', `맨위 ${name}`)).id;
  for (const name of ['X', 'Y', 'Z']) ids[name] = (await addItem(date, 'pm', `맨위 ${name}`)).id;
  const otherDay = plusDays(date, 1);
  const untouched = (await addItem(otherDay, 'main', '다른 날짜 메모')).id;
  await openDate(date);
  await page.setViewportSize({ width: 1180, height: 760 });
  const order = async section => (await dayOf(date)).items.filter(i => i.section === section).map(i => i.contentHtml.replace(/^.*맨위 ([A-Z]).*$/s, '$1')).join('');
  const shown = async section => (await page.locator(`[data-testid="memo-section-${section}"] [data-testid="personal-memo-row"]`).allInnerTexts()).map(t => t.replace(/^.*맨위 ([A-Z]).*$/s, '$1')).join('');
  const rowOf = name => page.locator(`[data-testid="personal-memo-row"][data-memo-id="${ids[name]}"]`);
  const viaRowMenu = async name => {
    await rowOf(name).locator('[aria-label="메모 편집"]').click({ button: 'right' });
    await page.locator('[data-testid="personal-memo-menu"]').waitFor();
    await page.locator('[data-testid="memo-menu-move-top"]').click();
  };

  // 편집 메뉴에서 — 편집 중인 메모가 그 구역 맨 위로, 편집·입력 내용은 그대로
  await rowOf('C').locator('[aria-label="메모 편집"]').click();
  const editable = rowOf('C').locator('[contenteditable="true"]');
  await editable.waitFor();
  await page.keyboard.press('End');
  await page.keyboard.type(' 고침');
  await selectText(editable, '맨위');
  await openMenu(page, editable);
  await app.shot('47-move-top-before');
  await menuOf(page).locator('[data-testid="rich-menu-action-move-top"]').click();
  await waitFor(async () => (await order('main')) === 'CAB', 'C 맨 위로');
  await waitFor(async () => (await shown('main')).startsWith('C'), '화면에도');
  assert.ok(await editable.isVisible(), '편집 상태 유지');
  assert.ok(await editable.evaluate(el => el === document.activeElement), '편집기 포커스 유지');
  assert.ok((await editable.innerText()).includes('고침'), '입력한 글자 유지');
  assert.ok((await dayOf(date)).items.find(i => i.id === ids.C).contentHtml.includes('고침'), '입력한 글자 저장');
  assert.equal(await order('am'), 'MNO', '다른 구역 그대로');
  assert.equal(await order('pm'), 'XYZ', '다른 구역 그대로');
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await waitFor(async () => (await dayOf(date)).items.find(i => i.id === ids.C).contentHtml.includes('!'), '옮긴 뒤에도 입력·저장');
  await app.shot('48-move-top-after');

  // 이미 맨 위면 꺼져 있다
  await selectText(editable, '맨위');
  await openMenu(page, editable);
  assert.ok(await menuOf(page).locator('[data-testid="rich-menu-action-move-top"]').isDisabled(), '이미 맨 위');
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="memo-header-date"]').click();
  await rowOf('C').locator('[aria-label="메모 편집"]').click({ button: 'right' });
  await page.locator('[data-testid="personal-memo-menu"]').waitFor();
  assert.equal(await page.getAttribute('[data-testid="memo-menu-move-top"]', 'aria-disabled'), 'true', '행 메뉴도 꺼짐');
  await page.keyboard.press('Escape');

  // 행 메뉴에서 — 오전 · 오후 각각 그 구역 맨 위로
  await viaRowMenu('O');
  await waitFor(async () => (await order('am')) === 'OMN', '오전');
  await viaRowMenu('Y');
  await waitFor(async () => (await order('pm')) === 'YXZ', '오후');
  assert.equal(await order('main'), 'CAB', '메인 그대로');

  // 여러 번 — 시드 고정 무작위로 20회, 매번 화면·저장이 기대값과 같고 항목이 빠지거나 겹치지 않는다
  let expected = (await order('main')).split('');
  let seed = 7;
  for (let n = 0; n < 20; n++) {
    seed = (seed * 31 + 11) % 97;
    const name = expected[1 + (seed % (expected.length - 1))];
    await viaRowMenu(name);
    expected = [name, ...expected.filter(x => x !== name)];
    await waitFor(async () => (await order('main')) === expected.join(''), `정렬 ${n}: ${expected.join('')}`);
    await waitFor(async () => (await shown('main')) === expected.join(''), `화면 ${n}: ${expected.join('')}`);
  }
  assert.equal((await dayOf(otherDay)).items.map(i => i.id).join(), untouched, '다른 날짜 그대로');

  // 주간 칸에서도(그 날짜의 그 구역 안에서만)
  await page.click('[data-testid="memo-back-to-week"]');
  await page.waitForSelector('[data-testid="personal-memo-week"]');
  const weekRow = name => page.locator(`[data-testid="memo-cell-${date}"] [data-memo-id="${ids[name]}"]`);
  await page.locator(`[data-testid="memo-cell-${date}"] button:has-text("더 보기")`).click();
  await weekRow('Z').locator('[aria-label="메모 편집"]').click({ button: 'right' });
  await page.locator('[data-testid="memo-menu-move-top"]').click();
  await waitFor(async () => (await order('pm')) === 'ZYX', '주간에서 오후 맨 위로');

  // Next List — 그 List 안에서만
  const list = await app.invoke('list_create', { name: '맨위 List', id: null });
  const addNext = (listId, html) => app.invoke('item_create', { input: { id: crypto.randomUUID(), location: { kind: 'next', listId }, section: 'next', kind: 'checklist', contentHtml: html } });
  const listItems = {};
  for (const name of ['P', 'Q', 'R']) listItems[name] = (await addNext(list.id, `리스트 ${name}`)).id;
  const defaults = [(await addNext(null, '기본 Next 1')).id, (await addNext(null, '기본 Next 2')).id];
  const listOrder = async listId => (await app.invoke('memo_list', { listId })).items.map(i => i.id);
  const defaultBefore = await listOrder(null);
  await page.reload();
  await page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  await page.click('[data-testid="memo-cell-next"] button[aria-label$="메모 쓰기"]');
  await page.waitForSelector('[data-testid="memo-section-next"]');
  await page.locator(`[data-testid="memo-next-list-tab"][data-list-id="${list.id}"]`).click();
  const rRow = page.locator(`[data-testid="personal-memo-row"][data-memo-id="${listItems.R}"]`);
  await rRow.waitFor();
  await rRow.locator('[aria-label="메모 편집"]').click();
  const rEdit = rRow.locator('[contenteditable="true"]');
  await rEdit.waitFor();
  await selectText(rEdit, '리스트');
  await openMenu(page, rEdit);
  await app.shot('49-next-list-menu');
  await menuOf(page).locator('[data-testid="rich-menu-action-move-top"]').click();
  await waitFor(async () => (await listOrder(list.id)).join() === [listItems.R, listItems.P, listItems.Q].join(), 'List 맨 위로');
  assert.deepEqual(await listOrder(null), defaultBefore, '기본 Next 는 그대로');
  assert.equal(defaults.length, 2);
  await page.locator('[data-testid="memo-header-date"]').click();

  // 끌어 놓기와 같은 저장 — 재실행 후에도 그 순서
  const beforeRestart = [await order('main'), await order('am'), await order('pm'), (await listOrder(list.id)).join()];
  await app.restart();
  await app.page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  assert.deepEqual([await order('main'), await order('am'), await order('pm'), (await listOrder(list.id)).join()], beforeRestart, '재실행 후 순서');
  await app.page.setViewportSize({ width: 1180, height: 760 }).catch(() => undefined);
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
  const weekdayText = `${['월', '화', '수', '목', '금', '토', '일'][weekdayIndex(today)]}요일`;
  const md = date => date.slice(5).split('-').map(Number).join('/');
  assert.ok(text7.includes('정기 점검') && text7.includes('예약한 일정 확인'), '다음 주 카드에 실제 내용');
  assert.equal(await card7.locator('[data-testid="upcoming-card-title"]').innerText(), `다음 ${weekdayText} · ${md(d7)}`, '카드 제목: 다음 ○요일 · 날짜');
  assert.equal(await card7.locator('[data-testid="personal-memo-quick-input"]').count(), 0, '접힌 카드 — 입력칸 없음');
  assert.ok(!text7.includes('추가 항목 5') && text7.includes('나머지 3개 펼치기'), '접힌 카드는 구역마다 앞의 메모만 미리 보기');
  await card7.locator('[data-testid="upcoming-show-more"]').click();
  assert.ok((await card7.innerText()).includes('추가 항목 5') && (await card7.locator('[data-testid="personal-memo-quick-input"]').count()) === 0, '펼쳐도 입력칸 없이 모두 보인다');
  await card7.locator('[data-testid="upcoming-show-more"]').click();
  assert.ok(!(await card7.innerText()).includes('추가 항목 5'), '간단히 보기');
  await card7.locator('[data-testid="upcoming-toggle"]').click();
  await card7.locator('[data-testid="upcoming-group-main"] [data-testid="personal-memo-quick-input"]').waitFor();
  assert.ok((await card7.innerText()).includes('추가 항목 5'), '펼치면 모든 항목');
  // 빈 2주 후 — 접혀 있고 '메모 없음', [기록] 을 눌러야 입력칸이 나온다
  const card14 = page.locator(`[data-testid="upcoming-card-${d14}"]`);
  assert.equal(await card14.locator('[data-testid="upcoming-card-title"]').innerText(), `다음 ${weekdayText} · ${md(d14)}`, '2주 후 카드도 같은 표기');
  assert.ok(!(await page.locator('[data-testid="upcoming-weekday"]').innerText()).match(/다음 주|다다음|주 후/), '상대 표현 없음');
  assert.equal(await page.locator('[data-testid="upcoming-write"]').count(), 0, '[미리 작성] 버튼 없음');
  assert.equal(await page.locator(`[data-testid="upcoming-card-${d28}"]`).count(), 0, '더 먼 날짜는 [더 보기] 전에는 없다');
  assert.equal(await card14.locator('[data-testid="upcoming-empty"]').innerText(), '메모 없음');
  assert.equal(await card14.locator('[data-testid="personal-memo-quick-input"]').count(), 0, '빈 날짜는 입력칸을 펼치지 않는다');
  const card14Height = (await card14.boundingBox()).height;
  assert.ok(card14Height < 60, `빈 날짜 카드는 한 줄(${card14Height}px)`);
  await card14.locator('[data-testid="upcoming-reminder-button"]').waitFor();
  await card14.scrollIntoViewIfNeeded();
  await app.shot('22a-upcoming-collapsed');
  await card14.locator('[data-testid="upcoming-toggle"]').click();
  const input14 = card14.locator('[data-testid="upcoming-group-main"] [data-testid="personal-memo-quick-input"]');
  await input14.waitFor();
  assert.ok(await input14.evaluate(el => el === document.activeElement), '[기록] → 메인 입력칸에 커서');
  await input14.type('다음 달 계획 검토');
  await page.keyboard.press('Control+Enter');
  await waitFor(async () => (await dayOf(d14)).items.some(i => i.contentHtml === '다음 달 계획 검토'), '카드에서 작성 → 그 날짜 문서');
  await card14.locator('[data-testid="personal-memo-row"]').waitFor();
  assert.equal(await card14.locator('[data-testid="upcoming-toggle"]').getAttribute('aria-expanded'), 'true', '기록 중에는 저절로 접히지 않는다');
  // 쓰던 글이 있어도 접는 순간 그 날짜에 저장된다
  const input14am = card14.locator('[data-testid="upcoming-group-am"] [data-testid="personal-memo-quick-input"]');
  await input14am.click();
  await input14am.type('접기 전에 쓴 글');
  await card14.locator('[data-testid="upcoming-toggle"]').click();
  await waitFor(async () => (await dayOf(d14)).items.some(i => i.contentHtml === '접기 전에 쓴 글'), '접어도 쓰던 글을 잃지 않는다');
  await card14.locator(`[data-testid="upcoming-preview-${d14}"]`).waitFor();
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
  // 카드 제목은 이동 버튼이 아니다 — 보고 있는 날짜는 그대로
  assert.equal(await card7.locator(`[aria-label="${d7} 날짜 상세로"]`).count(), 0, '카드에서 날짜 상세로 옮기지 않는다');
  assert.equal(await page.locator('[data-testid="memo-search-input"]').count(), 0, '검색 입력칸은 머리 줄에서 펼칠 때만');
});

step('upcoming-sections', async () => {
  const page = app.page;
  const labels = async card => card.locator('[data-testid^="upcoming-preview-group-"]').evaluateAll(nodes => nodes.map(n => n.dataset.testid.replace('upcoming-preview-group-', '')));
  const titled = async (card, section) => card.locator(`[data-testid="upcoming-preview-group-${section}"]`).innerText();
  // 메인만 · 오전만
  const base1 = plusDays(today, 210);
  const [mainOnly, amOnly] = [plusDays(base1, 7), plusDays(base1, 14)];
  await addItem(mainOnly, 'main', '메인만 있는 날');
  await addItem(amOnly, 'am', '오전만 있는 날');
  await openDate(base1);
  const cardMain = page.locator(`[data-testid="upcoming-card-${mainOnly}"]`);
  const cardAm = page.locator(`[data-testid="upcoming-card-${amOnly}"]`);
  assert.deepEqual(await labels(cardMain), ['main'], '메인만 — 다른 구역 제목 없음');
  assert.ok((await titled(cardMain, 'main')).startsWith('메인 할 일'));
  assert.deepEqual(await labels(cardAm), ['am'], '오전만');
  assert.ok((await titled(cardAm, 'am')).startsWith('오전 할 일'));
  assert.ok(!(await cardAm.innerText()).includes('메인 할 일'), '빈 구역은 생략');
  // 오후만 · 세 구역 모두
  const base2 = plusDays(today, 280);
  const [pmOnly, all] = [plusDays(base2, 7), plusDays(base2, 14)];
  await addItem(pmOnly, 'pm', '오후만 있는 날');
  await addItem(all, 'main', '보고서 작성');
  await addItem(all, 'main', '자료 정리');
  const am = await addItem(all, 'am', '회의 준비');
  await addItem(all, 'pm', '일정 검토');
  await addItem(all, 'pm', '일반 텍스트 메모', 'text');
  await addItem(all, 'pm', `긴 메모 ${'가나다라마바사 '.repeat(200)}[긴 메모 끝]`);
  await addItem(all, 'am', '<table><tbody><tr><td>표 칸1</td><td>표 칸2</td></tr><tr><td>표 칸3</td><td>표 칸4</td></tr></tbody></table>', 'text');
  await openDate(base2);
  const cardPm = page.locator(`[data-testid="upcoming-card-${pmOnly}"]`);
  const card = page.locator(`[data-testid="upcoming-card-${all}"]`);
  assert.deepEqual(await labels(cardPm), ['pm'], '오후만');
  assert.deepEqual(await labels(card), ['main', 'am', 'pm'], '메인·오전·오후 순서');
  assert.equal(await card.locator('[data-testid="personal-memo-quick-input"]').count(), 0, '입력칸은 숨김');
  const allText = await titled(card, 'main');
  assert.ok(allText.includes('보고서 작성') && allText.includes('자료 정리'), '구역 안 정렬 유지');
  assert.ok((await titled(card, 'pm')).includes('일반 텍스트 메모'), '일반 텍스트도 표시');
  const longRow = card.locator('[data-testid="personal-memo-row"]').filter({ hasText: '긴 메모' });
  assert.ok((await longRow.boundingBox()).height < 70, '긴 본문은 일부만');
  assert.ok((await titled(card, 'am')).includes('표 칸1'), '표도 미리 보기');
  await card.scrollIntoViewIfNeeded();
  await app.shot('22b-upcoming-sections');
  // 접힌 채 체크 → 그 미래 날짜에만, 취소선 유지
  const todayRevision = (await dayOf(base2)).document?.localRevision ?? null;
  const box = card.locator(`[data-testid="personal-memo-row"][data-memo-id="${am.id}"] input[type="checkbox"]`);
  await box.click();
  await waitFor(async () => (await dayOf(all)).items.find(i => i.id === am.id)?.completed, '접힌 카드에서 완료');
  assert.equal((await dayOf(base2)).document?.localRevision ?? null, todayRevision, '보고 있는 날짜는 바뀌지 않는다');
  await waitFor(async () => (await card.locator(`[data-testid="personal-memo-row"][data-memo-id="${am.id}"] [data-testid="personal-memo-content"]`).evaluate(el => getComputedStyle(el).textDecorationLine)) === 'line-through', '취소선');
  await box.click();
  await waitFor(async () => !(await dayOf(all)).items.find(i => i.id === am.id)?.completed, '접힌 카드에서 완료 해제');
  // 접기·펼치기 반복
  for (let i = 0; i < 3; i++) {
    await card.locator('[data-testid="upcoming-toggle"]').click();
    await card.locator('[data-testid="upcoming-group-main"] [data-testid="personal-memo-quick-input"]').waitFor();
    await card.locator('[data-testid="upcoming-toggle"]').click();
    await card.locator(`[data-testid="upcoming-preview-${all}"]`).waitFor();
  }
  assert.deepEqual(await labels(card), ['main', 'am', 'pm'], '반복해도 그대로');
  // 전부 지우면 '메모 없음'
  for (const item of (await dayOf(pmOnly)).items) await app.invoke('item_delete', { id: item.id });
  await openDate(base2);
  assert.equal(await cardPm.locator('[data-testid="upcoming-empty"]').innerText(), '메모 없음', '모든 구역이 비면 메모 없음');
  // 앱을 다시 켜도 그대로
  await app.restart();
  await openDate(base2);
  assert.deepEqual(await labels(app.page.locator(`[data-testid="upcoming-card-${all}"]`)), ['main', 'am', 'pm'], '재실행 후 유지');
  // 연결된 날짜(Mock Sync) — 접힌 카드에서 체크해도 그 날짜 문서로 전달
  if (isMockRun()) {
    const wasLoggedIn = (await app.invoke('auth_status')).loggedIn;
    if (!wasLoggedIn) {
      await app.invoke('auth_login_begin', { reconnect: false });
      await waitFor(async () => (await app.invoke('auth_status')).loggedIn, '로그인');
    }
    const location = { kind: 'day', date: all };
    await app.invoke('sync_link', { location });
    await app.invoke('sync_now');
    await waitFor(async () => (await dayOf(all)).document.syncStatus === 'synced', '미래 날짜 연결');
    const revision = (await dayOf(all)).document.localRevision;
    const linkedCard = app.page.locator(`[data-testid="upcoming-card-${all}"]`);
    await linkedCard.locator(`[data-testid="personal-memo-row"][data-memo-id="${am.id}"] input[type="checkbox"]`).click();
    await waitFor(async () => (await dayOf(all)).document.localRevision > revision, '연결된 미래 날짜 저장');
    const report = await app.invoke('sync_now');
    assert.equal(report.conflicts, 0);
    await waitFor(async () => (await dayOf(all)).document.syncStatus === 'synced', '연결된 미래 날짜 전달');
    await app.invoke('sync_unlink', { location });
    await app.invoke('sync_now');
    if (!wasLoggedIn) await app.invoke('auth_logout');
  }
});

step('date-search', async () => {
  const page = app.page;
  const year = Number(today.slice(0, 4));
  const target = `${year}-03-09`;
  const lastYear = `${year - 1}-03-09`;
  await addItem(target, 'main', '<p>날짜 검색 <b>메인</b></p>');
  await addItem(target, 'am', '날짜 검색 오전');
  await addItem(target, 'pm', '날짜 검색 오후');
  await addItem(lastYear, 'main', '작년 같은 날');
  await addItem(`${year}-04-01`, 'main', '본문에 3/9 라고 적음');
  await page.reload();
  await page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  await page.click('[data-testid="memo-search-open"]');
  const search = page.locator('[data-testid="memo-search-input"]');
  const yy = String(year).slice(2);
  const hasDay = async date => {
    const titles = await page.locator('[data-testid="memo-search-date-group"]').allInnerTexts();
    return titles.some(t => t.includes(date.replaceAll('-', '.')));
  };
  for (const query of ['3.9', '3/9', '3-9', '3월 9일', '3월9일', `${yy}.3.9`, `${yy}/3/9`, `${year}.03.09`, `${year}-03-09`, `${year}/03/09`]) {
    await search.fill(query);
    await waitFor(async () => hasDay(target), `날짜 검색 '${query}'`);
    assert.equal(await page.locator('[data-testid="memo-search-date-group"]').first().locator('[data-testid="memo-search-date-hit"]').count(), 3, `'${query}': 메인·오전·오후 모두`);
  }
  // 연도를 적으면 그 해만, 안 적으면 올해 먼저 + 다른 해
  await search.fill(`${year}-03-09`);
  await waitFor(async () => (await page.locator('[data-testid="memo-search-date-group"]').count()) === 1, '연도 지정 — 그 해만');
  await search.fill('3/9');
  await waitFor(async () => (await page.locator('[data-testid="memo-search-date-group"]').count()) === 2, '연도 없음 — 다른 해도');
  assert.ok((await page.locator('[data-testid="memo-search-date-group"]').first().innerText()).includes(`${year}.03.09`), '올해 먼저');
  // 본문에 같은 문자열이 있는 메모도 빠지지 않는다
  await page.locator('[data-testid="memo-search-hit"]:has-text("3/9 라고")').waitFor();
  await app.shot('23a-date-search');
  // 없는 날짜·날짜가 아닌 검색
  // 미래 메모도 날짜·본문 검색으로 찾는다
  const future = plusDays(today, 40);
  await addItem(future, 'main', '먼 미래 메모');
  const [, fm, fd] = future.split('-').map(Number);
  await search.fill(`${fm}/${fd}`);
  await waitFor(async () => hasDay(future), '미래 날짜 검색');
  await search.fill('먼 미래');
  await page.locator('[data-testid="memo-search-hit"]').first().waitFor();
  await search.fill('13/40');
  await waitFor(async () => (await page.locator('text=들어간 메모가 없습니다').count()) === 1, '없는 날짜 — 엉뚱한 날짜 없음');
  await search.fill('날짜 검색 오전');
  await page.locator('[data-testid="memo-search-hit"]').first().waitFor();
  assert.equal(await page.locator('[data-testid="memo-search-date-group"]').count(), 0, '본문 검색');
  // 결과를 누르면 그 날짜 상세
  await search.fill('3/9');
  await page.locator('[data-testid="memo-search-date-hit"]').first().waitFor();
  await page.locator('[data-testid="memo-search-date-hit"]').first().click();
  await page.waitForSelector('[data-testid="memo-section-main"]');
  assert.match(await page.locator('[data-testid="memo-header-date"]').innerText(), /^March 9, /);
  await page.click('[data-testid="memo-back-to-browse"]');
  await search.fill('');
});

step('month-cards', async () => {
  const page = app.page;
  const year = Number(today.slice(0, 4));
  await addItem(`${year - 1}-12-15`, 'main', '작년 12월 메모');
  await page.reload();
  await page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  await page.click('[data-testid="memo-search-open"]');
  await page.locator('[data-testid="memo-month-grid"]').waitFor();
  const label = month => page.locator(`[data-testid="memo-month-card"][data-month="${month}"] [data-testid="memo-month-label"]`).innerText();
  assert.equal(await label(`${year}-03`), '3월', '올해는 월만');
  assert.equal(await label(`${year - 1}-12`), `${year - 1}년 12월`, '다른 해는 연도와 월');
  const months = await page.$$eval('[data-testid="memo-month-card"]', nodes => nodes.map(n => n.dataset.month));
  assert.deepEqual(months, [...months].sort().reverse(), '최신 월부터');
  assert.ok(months.every(m => m <= today.slice(0, 7)), `미래 달 카드 없음 ${months}`);
  assert.equal(months[0], today.slice(0, 7), '이번 달이 맨 앞');
  const thisMonth = page.locator(`[data-testid="memo-month-card"][data-month="${today.slice(0, 7)}"]`);
  await thisMonth.locator('[data-testid="memo-day-summary"]').first().waitFor();
  const shownDays = await thisMonth.locator('[data-testid="memo-day-summary"]').allInnerTexts();
  const dayNumbers = shownDays.map(t => Number(t.match(/\d+\/(\d+)/)[1]));
  const todayNumber = Number(today.slice(8));
  assert.ok(dayNumbers.every(d => d <= todayNumber), `오늘까지만 ${dayNumbers}`);
  assert.ok(dayNumbers.includes(todayNumber), '오늘 메모는 보인다');
  const monthInfo = await app.invoke('memo_day_months', { until: today });
  const monthDays = await app.invoke('memo_days_in_month', { month: today.slice(0, 7), until: today });
  assert.equal(monthInfo[0].itemCount, monthDays.reduce((sum, d) => sum + d.itemCount, 0), '카드 개수 = 오늘까지의 메모');
  assert.equal(new Set(months).size, months.length, '월은 한 장씩');
  assert.equal(await page.locator(`[data-testid="memo-month-card"][data-month="${today.slice(0, 7)}"] [data-testid="memo-month-toggle"]`).getAttribute('aria-expanded'), 'true', '이번 달은 펼쳐진다');
  const march = page.locator(`[data-testid="memo-month-card"][data-month="${year}-03"]`);
  assert.equal(await march.locator('[data-testid="memo-day-summary"]').count(), 0, '다른 달은 접혀 있다');
  assert.ok((await march.innerText()).includes('메모 3개'), '메모 개수');
  await app.shot('23b-month-cards');
  await march.locator('[data-testid="memo-month-toggle"]').click();
  await march.locator('[data-testid="memo-day-summary"]').first().waitFor();
  assert.ok((await march.innerText()).includes('날짜 검색'), '펼치면 날짜별 내용');
  await app.shot('23c-month-open');
  // 작은 창에서도 카드가 잘리지 않는다
  const original = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  await page.setViewportSize({ width: 850, height: 620 });
  const overflow = await page.$$eval('[data-testid="memo-month-card"]', nodes => nodes.some(n => n.getBoundingClientRect().right > window.innerWidth));
  assert.equal(overflow, false, '월 카드가 창 밖으로 나가지 않는다');
  await page.setViewportSize(original);
  await march.locator('[data-testid="memo-day-summary"]').first().click();
  await page.waitForSelector('[data-testid="memo-section-main"]');
  await page.click('[data-testid="memo-back-to-browse"]');
  // 접힌 달도 검색된다
  await march.locator('[data-testid="memo-month-toggle"]').click();
  await page.locator('[data-testid="memo-search-input"]').fill('작년 12월');
  await page.locator('[data-testid="memo-search-hit"]').first().waitFor();
  await page.locator('[data-testid="memo-search-input"]').fill('');
});

// 메모 손잡이를 잡아 y 까지 천천히 끈다(놓지 않는다).
async function dragStart(row) {
  const page = app.page;
  await row.hover();
  const handle = row.locator('[aria-label="끌어서 옮기기"]');
  const box = await handle.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 8, { steps: 3 });
  return { x, y };
}

step('memo-drag', async () => {
  const page = app.page;
  const date = plusDays(today, 120);
  const location = { kind: 'day', date };
  const ids = {};
  for (const name of ['A', 'B', 'C', 'D', 'E']) ids[name] = (await addItem(date, 'main', `끌기 ${name}`)).id;
  ids.P = (await addItem(date, 'pm', '오후 메모')).id;
  await openDate(date);
  const main = page.locator('[data-testid="memo-section-main"]');
  await main.locator('[data-testid="personal-memo-row"]').first().waitFor();
  const order = async section => (await dayOf(date)).items.filter(i => i.section === section).map(i => i.contentHtml.replace('끌기 ', ''));
  const shown = async () => (await main.locator('[data-testid="personal-memo-row"]').allInnerTexts()).map(t => t.replace('끌기 ', '').trim());
  const rowOf = name => main.locator(`[data-memo-id="${ids[name]}"]`);
  const gapY = async (upper, lower) => {
    const a = await rowOf(upper).boundingBox();
    const b = await rowOf(lower).boundingBox();
    return (a.y + a.height + b.y) / 2;
  };
  const line = page.locator('[data-testid="memo-drop-line"]');
  const revision = async () => (await app.invoke('memo_day', { date: location.date })).document.localRevision;

  // ① 끄는 동안 메모 자리는 그대로, 삽입선이 뜨고, 가운데선 주변의 흔들림에 위치가 왔다 갔다 하지 않는다
  const before = await main.locator('[data-testid="personal-memo-row"]').evaluateAll(nodes => nodes.map(n => Math.round(n.getBoundingClientRect().top)));
  const { x } = await dragStart(rowOf('A'));
  const target = await gapY('C', 'D');
  await page.mouse.move(x, target, { steps: 12 });
  await line.waitFor();
  const lineTop = (await line.boundingBox()).y;
  assert.ok(Math.abs(lineTop - target) <= 3, `삽입선이 C·D 사이(${lineTop} / ${target})`);
  const during = await main.locator('[data-testid="personal-memo-row"]').evaluateAll(nodes => nodes.map(n => Math.round(n.getBoundingClientRect().top)));
  assert.deepEqual(during, before, '끄는 동안 메모가 밀리지 않는다');
  await app.shot('24a-drag-line');
  const dBox = await rowOf('D').boundingBox();
  const mid = dBox.y + dBox.height / 2;
  await page.evaluate(() => {
    window.__pointerTrace = [];
    window.__pointerListener = e => window.__pointerTrace.push([Math.round(e.clientX), Math.round(e.clientY)]);
    window.addEventListener('pointermove', window.__pointerListener, true);
  });
  const tops = new Set();
  for (const wobble of [-4, 3, -2, 5, -5, 2, 4, -3]) {
    await page.mouse.move(x, mid + wobble); // D 의 가운데선을 위아래로 넘나드는 작은 흔들림
    await sleep(40);
    tops.add(Math.round((await line.boundingBox()).y));
  }
  const trace = await page.evaluate(() => {
    window.removeEventListener('pointermove', window.__pointerListener, true);
    return window.__pointerTrace;
  });
  const foreign = trace.filter(([px]) => Math.abs(px - Math.round(x)) > 2);
  assert.equal(tops.size, 1, `작은 흔들림에 삽입선이 움직이지 않는다 ${[...tops]} · 테스트가 보내지 않은 좌표 ${JSON.stringify(foreign)} · 전체 입력 ${JSON.stringify(trace)}`);
  // 다른 곳의 포인터 입력이 들어오면(지난 실패의 값 486·520 처럼) 그쪽 구역으로 선이 갔다가, 다음 입력에 바로 돌아온다
  const pmBox = await page.locator(`[data-memo-id="${ids.P}"]`).boundingBox();
  await page.evaluate(([px, py]) => window.dispatchEvent(new PointerEvent('pointermove', { clientX: px, clientY: py })), [pmBox.x + 200, pmBox.y + 4]);
  await sleep(60);
  const elsewhere = (await line.boundingBox()).y;
  assert.ok(Math.abs(elsewhere - pmBox.y) <= 3, `끼어든 입력은 그 자리의 틈으로(${elsewhere} / ${pmBox.y})`);
  await page.mouse.move(x, mid - 3);
  await sleep(60);
  assert.ok((await line.boundingBox()).y < dBox.y + dBox.height, '다음 입력에 바로 돌아온다');
  // ② 놓으면 그 자리, 화면·저장 순서 일치
  await page.mouse.move(x, target, { steps: 3 });
  await sleep(60);
  await page.mouse.up();
  assert.deepEqual((await shown()), ['B', 'C', 'A', 'D', 'E'], '놓자마자 화면에 반영');
  await waitFor(async () => (await order('main')).join() === 'B,C,A,D,E', 'A 를 C·D 사이로');
  assert.equal(await line.count(), 0, '놓은 뒤 삽입선 없음');

  // ③ 맨 위 · 맨 아래 · 긴 이동
  let box = await rowOf('E').boundingBox();
  const startE = await dragStart(rowOf('E'));
  box = await rowOf('B').boundingBox();
  await page.mouse.move(startE.x, box.y - 2, { steps: 15 });
  await sleep(60);
  await page.mouse.up();
  await waitFor(async () => (await order('main')).join() === 'E,B,C,A,D', '맨 위로');
  const startB = await dragStart(rowOf('B'));
  box = await rowOf('D').boundingBox();
  await page.mouse.move(startB.x, box.y + box.height + 2, { steps: 6 }); // 빠른 이동
  await sleep(60);
  await page.mouse.up();
  await waitFor(async () => (await order('main')).join() === 'E,C,A,D,B', '맨 아래로');

  // ④ 제자리에 놓으면 저장하지 않는다
  const revisionBefore = await revision();
  const startC = await dragStart(rowOf('C'));
  await page.mouse.move(startC.x, startC.y + 3, { steps: 3 });
  await sleep(60);
  assert.equal(await line.count(), 0, '제자리에는 삽입선이 없다');
  await page.mouse.up();
  await sleep(300);
  assert.equal(await revision(), revisionBefore, '제자리에 놓으면 저장 요청 없음');

  // ⑤ Esc 취소 — 원래 순서
  const startA = await dragStart(rowOf('A'));
  await page.mouse.move(startA.x, (await rowOf('E').boundingBox()).y - 2, { steps: 8 });
  await line.waitFor();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await sleep(200);
  assert.equal(await line.count(), 0);
  assert.equal((await order('main')).join(), 'E,C,A,D,B', '취소 — 그대로');

  // ⑥ 다른 구역으로 옮기기(기존 기능) · 체크 상태 유지
  await app.invoke('item_set_completed', { id: ids.C, completed: true });
  await page.reload();
  await page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  await openDate(date);
  await rowOf('C').waitFor();
  const startX = await dragStart(rowOf('C'));
  const pmRow = await page.locator(`[data-memo-id="${ids.P}"]`).boundingBox();
  await page.mouse.move(pmRow.x + 40, pmRow.y + pmRow.height + 2, { steps: 12 });
  await sleep(60);
  await page.mouse.up();
  await waitFor(async () => (await dayOf(date)).items.find(i => i.id === ids.C)?.section === 'pm', '오후 구역으로');
  const moved = (await dayOf(date)).items.find(i => i.id === ids.C);
  assert.equal(moved.completed, true, '체크 상태 유지');
  void startX;

  // ⑦ 재실행 후 순서 그대로
  await app.restart();
  assert.equal((await order('main')).join(), 'E,A,D,B', '재실행 후 같은 순서');
});

step('memo-drag-scroll-long', async () => {
  const page = app.page;
  const date = plusDays(today, 130);
  const ids = [];
  for (let n = 0; n < 30; n++) ids.push((await addItem(date, 'am', `긴 목록 ${n}`)).id);
  const longText = Array.from({ length: 40 }, (_, n) => `긴 메모 ${n} 줄 — 내용이 길어 행 높이가 큽니다`).join('<br>');
  const long = await addItem(date, 'main', longText);
  const top = await addItem(date, 'main', '긴 메모 위');
  const bottom = await addItem(date, 'main', '긴 메모 아래');
  const original = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  await page.setViewportSize({ width: 850, height: 620 });
  await openDate(date);
  const section = page.locator('[data-testid="memo-section-am"]');
  const order = async sectionName => (await dayOf(date)).items.filter(i => i.section === sectionName).map(i => i.id);
  // 오전 구역이 화면 위쪽에 오게 한다(커서가 다른 구역으로 넘어가지 않게).
  await page.evaluate(() => document.querySelector('[data-testid="memo-section-am"]').scrollIntoView({ block: 'start' }));
  const scrollTop = () => page.evaluate(() => {
    let el = document.querySelector('[data-testid="memo-section-am"]').parentElement;
    while (el && getComputedStyle(el).overflowY !== 'auto') el = el.parentElement;
    return el.scrollTop;
  });

  // 스크롤 중: 화면이 움직여도 삽입선이 커서 아래 틈을 따라간다
  const first = section.locator(`[data-memo-id="${ids[0]}"]`);
  const start = await dragStart(first);
  await page.mouse.move(start.x, 300, { steps: 6 });
  await page.locator('[data-testid="memo-drop-line"]').waitFor();
  const lineBefore = (await page.locator('[data-testid="memo-drop-line"]').boundingBox()).y;
  assert.ok(Math.abs(lineBefore - 300) <= 40, `삽입선이 커서 근처(${lineBefore})`);
  const before = await scrollTop();
  await page.mouse.wheel(0, 120);
  await waitFor(async () => (await scrollTop()) > before, '끄는 중 휠 스크롤');
  await sleep(200);
  const lineAfter = (await page.locator('[data-testid="memo-drop-line"]').boundingBox()).y;
  assert.ok(Math.abs(lineAfter - 300) <= 40, `스크롤 뒤에도 삽입선이 커서 근처(${lineBefore} → ${lineAfter})`);
  const rowsBeforeEdge = await section.locator('[data-drop-row]').evaluateAll(nodes => nodes.map(n => ({ id: n.dataset.dropRow, bottom: n.getBoundingClientRect().bottom })));
  assert.ok(rowsBeforeEdge.some(r => Math.abs(r.bottom - lineAfter) <= 4), '삽입선은 메모 사이 틈에 있다');
  // 창 아래 가장자리로 가면 저절로 스크롤되고 삽입선이 함께 움직인다
  const edgeStart = await scrollTop();
  await page.mouse.move(start.x, 612, { steps: 5 });
  await waitFor(async () => (await scrollTop()) > edgeStart, '가장자리 자동 스크롤');
  await page.mouse.move(start.x, 300, { steps: 5 });
  await sleep(500);
  // 놓으면 삽입선이 가리킨 틈에 들어간다 — 선 위의 메모 바로 뒤
  const rows = await section.locator('[data-drop-row]').evaluateAll(nodes => nodes.map(n => ({ id: n.dataset.dropRow, bottom: n.getBoundingClientRect().bottom })));
  const lineNow = (await page.locator('[data-testid="memo-drop-line"]').boundingBox()).y;
  const above = rows.filter(r => r.id !== ids[0] && r.bottom <= lineNow + 2).at(-1);
  await page.mouse.up();
  await waitFor(async () => {
    const saved = await order('am');
    return saved.indexOf(ids[0]) === saved.indexOf(above.id) + 1;
  }, '삽입선이 가리킨 자리에 저장');
  const shownIds = await section.locator('[data-drop-row]').evaluateAll(nodes => nodes.map(n => n.dataset.dropRow));
  assert.deepEqual(shownIds, await order('am'), '화면과 저장 순서가 같다');

  // 긴 메모 주변: 위·아래 메모를 긴 메모 너머로 옮긴다
  const main = page.locator('[data-testid="memo-section-main"]');
  await main.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.querySelector('[data-testid="memo-section-main"]').scrollIntoView({ block: 'start' }));
  const topRow = main.locator(`[data-memo-id="${top.id}"]`);
  const longBox = await main.locator(`[data-memo-id="${long.id}"]`).boundingBox();
  assert.ok(longBox.height > 300, `긴 메모 높이 ${longBox.height}`);
  await app.invoke('items_reorder', { location: { kind: 'day', date }, section: 'main', ids: [top.id, long.id, bottom.id] });
  await page.reload();
  await page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  await openDate(date);
  await page.evaluate(() => document.querySelector('[data-testid="memo-section-main"]').scrollIntoView({ block: 'start' }));
  await topRow.waitFor();
  const s1 = await dragStart(topRow);
  const longNow = await main.locator(`[data-memo-id="${long.id}"]`).boundingBox();
  await page.mouse.move(s1.x, longNow.y + longNow.height / 2 + 20, { steps: 10 }); // 긴 메모 가운데를 넘어간다
  await sleep(80);
  await page.mouse.up();
  await waitFor(async () => (await order('main')).join() === [long.id, top.id, bottom.id].join(), '긴 메모 뒤로');
  await page.setViewportSize(original);
});

step('memo-drag-stress', async () => {
  const page = app.page;
  const date = plusDays(today, 140);
  const model = [];
  for (let n = 0; n < 7; n++) model.push((await addItem(date, 'main', `연속 ${n}`)).id);
  model.splice(4, 0, (await addItem(date, 'main', Array.from({ length: 4 }, (_, n) => `긴 줄 ${n}`).join('<br>'))).id);
  const stored = async () => (await dayOf(date)).items.filter(i => i.section === 'main').map(i => i.id);
  await app.invoke('items_reorder', { location: { kind: 'day', date }, section: 'main', ids: model });
  const main = page.locator('[data-testid="memo-section-main"]');
  const line = page.locator('[data-testid="memo-drop-line"]');
  const original = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  let seed = 20261102;
  const random = max => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % max;
  };
  const round = async (count, label) => {
    await openDate(date); // 맨 위(스크롤 0) — 메모가 모두 자동 스크롤 구역 밖에 있다
    await main.locator('[data-drop-row]').first().waitFor();
    for (let i = 0; i < count; i++) {
      const from = random(model.length);
      const gap = random(model.length + 1);
      const fast = random(3) === 0;
      const row = main.locator(`[data-memo-id="${model[from]}"]`);
      const start = await dragStart(row);
      const rows = await main.locator('[data-drop-row]').evaluateAll(nodes => nodes.map(n => {
        const r = n.getBoundingClientRect();
        return [r.top, r.bottom];
      }));
      const y = gap === 0 ? rows[0][0] - 1 : gap >= rows.length ? rows[rows.length - 1][1] + 1 : (rows[gap - 1][1] + rows[gap][0]) / 2;
      await page.mouse.move(start.x, y, { steps: fast ? 1 : 8 });
      await sleep(40);
      const noop = gap === from || gap === from + 1;
      if (!noop) {
        const top = (await line.boundingBox())?.y;
        assert.ok(top !== undefined && Math.abs(top - y) <= 4, `${label} #${i} 삽입선(${top} / ${y})`);
      } else {
        assert.equal(await line.count(), 0, `${label} #${i} 제자리에는 선 없음`);
      }
      await page.mouse.up();
      if (!noop) model.splice(gap > from ? gap - 1 : gap, 0, model.splice(from, 1)[0]);
      const onScreen = await main.locator('[data-drop-row]').evaluateAll(nodes => nodes.map(n => n.dataset.dropRow));
      assert.deepEqual(onScreen, model, `${label} #${i} 놓자마자 화면 순서`);
      await waitFor(async () => (await stored()).join() === model.join(), `${label} #${i} 저장 순서`, 5000);
    }
  };
  await round(40, '기본 창');
  await page.setViewportSize({ width: 850, height: 620 });
  await round(25, '최소 창');
  await page.setViewportSize(original);
  await app.restart();
  assert.equal((await stored()).join(), model.join(), '재실행 후 같은 순서');
});

step('list-manage-trash', async () => {
  const page = app.page;
  const names = Array.from({ length: 24 }, (_, n) => `주제별 List 이름 ${n + 1}`);
  const lists = [];
  for (const name of names) lists.push(await app.invoke('list_create', { id: crypto.randomUUID(), name }));
  const target = lists[1];
  const item = await app.invoke('item_create', { input: { id: crypto.randomUUID(), location: { kind: 'next', listId: target.id }, section: 'next', kind: 'checklist', contentHtml: '<p><b>복구</b>될 메모</p>' } });
  await app.invoke('item_set_completed', { id: item.id, completed: true });
  await app.invoke('item_create', { input: { id: crypto.randomUUID(), location: { kind: 'next', listId: target.id }, section: 'next', kind: 'text', contentHtml: '두 번째 메모' } });
  await page.reload();
  await page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  await page.click('[data-testid="memo-search-open"]');
  await page.locator(`[data-testid="personal-memo-browse"] >> text=${target.name}`).first().click();
  const tabsBox = page.locator('[data-testid="memo-next-list-tabs"]');
  await tabsBox.waitFor();

  // 자동 줄바꿈 + 두 줄로 접힘 + 가로 스크롤 없음
  const scroll = await tabsBox.evaluate(el => ({ overflow: el.scrollWidth - el.clientWidth, height: el.getBoundingClientRect().height }));
  assert.ok(scroll.overflow <= 1, '가로 스크롤 없음');
  assert.ok(scroll.height <= 32 * 2 + 6 + 6, `접힌 높이 두 줄(${scroll.height})`);
  const more = page.locator('[data-testid="memo-next-list-more"]');
  const label = await more.innerText();
  assert.match(label, /List 더 보기 · \d+개/, label);
  await app.shot('25a-list-collapsed');
  const created = page.locator('[data-testid="memo-next-list-create"]');
  assert.ok(await created.isVisible(), '+ List 항상 보임');
  // 맨 뒤 List 를 고르면 — 접혀 있어도 선택 List 가 보인다
  await more.click();
  assert.ok((await tabsBox.boundingBox()).height > scroll.height, '펼치면 모두');
  await app.shot('25b-list-expanded');
  const lastTab = page.locator(`[data-testid="memo-next-list-tab"][data-list-id="${lists[23].id}"]`);
  await lastTab.click();
  await waitFor(async () => (await lastTab.getAttribute('aria-selected')) === 'true', '맨 뒤 List 선택');
  await more.click();
  await page.locator('[data-testid="memo-next-list-pinned"]').waitFor();
  assert.ok((await page.locator('[data-testid="memo-next-list-pinned"]').innerText()).includes(lists[23].name), '가려진 선택 List 를 함께 보여 준다');
  assert.equal(await lastTab.getAttribute('aria-selected'), 'true', '접어도 선택 유지');
  // 작은 창
  const original = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  await page.setViewportSize({ width: 850, height: 620 });
  assert.ok((await tabsBox.evaluate(el => el.scrollWidth - el.clientWidth)) <= 1, '작은 창에서도 가로 스크롤 없음');
  await app.shot('25c-list-small');
  await page.setViewportSize(original);
  await page.locator(`[data-testid="memo-next-list-tab"][data-list-id="${target.id}"]`).click();
  const tab = page.locator(`[data-testid="memo-next-list-tab"][data-list-id="${target.id}"]`);
  await waitFor(async () => (await tab.getAttribute('aria-selected')) === 'true', 'List 선택');

  // 우클릭 — 이름 변경(Esc 취소 · 빈 제목 · Enter 저장, 메모·선택 유지)
  await tab.click({ button: 'right' });
  await page.click('[data-testid="memo-next-list-rename"]');
  const nameInput = page.locator('[data-testid="memo-list-name-dialog"] input');
  assert.equal(await nameInput.inputValue(), target.name, '기존 제목 표시');
  await nameInput.fill('취소될 이름');
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="memo-list-name-dialog"]').waitFor({ state: 'detached' });
  assert.ok((await tab.innerText()).includes(target.name), 'Esc 취소');
  await tab.click({ button: 'right' });
  await page.click('[data-testid="memo-next-list-rename"]');
  await nameInput.fill('   ');
  assert.ok(await page.locator('[data-testid="memo-list-name-dialog"] button:has-text("저장")').isDisabled(), '빈 제목 불가');
  await nameInput.fill('메모장 개선');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await tab.innerText()).includes('메모장 개선'), '이름 변경');
  assert.equal(await tab.getAttribute('aria-selected'), 'true', '선택 유지');
  assert.equal((await app.invoke('memo_list', { listId: target.id })).items.length, 2, '메모 그대로');
  // 기본 Next 는 메뉴 없음
  await page.locator('[data-testid="memo-next-list-tab"]').first().click({ button: 'right' });
  assert.equal(await page.locator('[data-testid="memo-next-list-rename"]').count(), 0, '기본 Next 는 이름 변경·삭제 없음');
  assert.equal(await page.locator('[data-testid="memo-next-list-tab"]').first().locator('[data-testid="memo-next-list-delete"]').count(), 0);

  // × — 바로 지우지 않는다. 취소 → 그대로
  await tab.hover();
  await tab.locator('[data-testid="memo-next-list-delete"]').click();
  const confirm = page.locator('[data-testid="memo-list-delete-confirm"]');
  await confirm.waitFor();
  const confirmText = await confirm.innerText();
  assert.ok(confirmText.includes('메모장 개선') && confirmText.includes('메모 2개') && confirmText.includes('7일'), confirmText);
  await app.shot('25d-list-delete-confirm');
  await confirm.locator('button:has-text("취소")').click();
  await confirm.waitFor({ state: 'detached' });
  assert.ok((await app.invoke('memo_lists')).some(l => l.id === target.id), '취소 — 그대로');

  const indexBefore = (await app.invoke('memo_lists')).findIndex(l => l.id === target.id);
  // 휴지통으로 — 보고 있던 List 면 기본 Next 로, 두 번 호출해도 안전
  await tab.hover();
  await tab.locator('[data-testid="memo-next-list-delete"]').click();
  await page.click('[data-testid="memo-list-delete-submit"]');
  await confirm.waitFor({ state: 'detached' });
  await waitFor(async () => (await page.locator('[data-testid="memo-next-list-tab"]').first().getAttribute('aria-selected')) === 'true', '기본 Next 로');
  assert.equal(await page.locator(`[data-testid="memo-next-list-tab"][data-list-id="${target.id}"]`).count(), 0);
  assert.equal((await app.invoke('list_delete', { id: target.id })).already, true, '두 번 실행 — 오류 없음');
  assert.equal((await app.invoke('memo_search', { query: '복구될' })).items.length, 0, '휴지통 메모는 검색되지 않는다');

  // 보존된 내용 유지(이미지 보존은 Rust 테스트 — 첨부 파일까지 확인)
  const historyInTrash = await app.invoke('history_list', { location: { kind: 'next', listId: target.id } });
  assert.ok(historyInTrash.some(v => v.reason === 'list_delete'), '삭제 전 내용을 보존한다');

  // 설정 → 휴지통: 정보 · 복구
  await page.mouse.move(5, 300);
  await page.click('[data-testid="open-settings"]');
  const entry = page.locator(`[data-testid="trash-entry"][data-list-id="${target.id}"]`);
  await entry.waitFor();
  const entryText = await entry.innerText();
  assert.ok(entryText.includes('메모장 개선') && entryText.includes('메모 2개') && entryText.includes('영구 삭제 예정'), entryText);
  await entry.scrollIntoViewIfNeeded();
  await app.shot('25e-trash');
  const rows = page.locator('[data-testid="trash-section"]');
  await rows.locator('[data-testid="trash-restore"]').first().click();
  await waitFor(async () => (await app.invoke('memo_lists')).some(l => l.id === target.id), '복구');
  const restored = await app.invoke('memo_list', { listId: target.id });
  assert.deepEqual(restored.items.map(i => [i.contentHtml, i.completed]), [['<p><b>복구</b>될 메모</p>', true], ['두 번째 메모', false]], '내용·서식·완료 그대로');
  assert.equal((await app.invoke('memo_lists')).findIndex(l => l.id === target.id), indexBefore, '원래 순서로');
  assert.ok((await app.invoke('history_list', { location: { kind: 'next', listId: target.id } })).length >= historyInTrash.length, '보존된 내용 유지');
  assert.equal((await app.invoke('trash_restore', { id: target.id })).id, target.id, '복구를 두 번 실행해도 안전');

  // 영구 삭제 — 확인 후. 취소하면 그대로.
  await app.invoke('list_delete', { id: target.id });
  await page.reload();
  await page.waitForSelector('[data-testid="personal-memo-week"]', { timeout: 20000 });
  await page.click('[data-testid="open-settings"]');
  await entry.waitFor();
  await page.locator('[data-testid="trash-section"] [data-testid="trash-purge"]').first().click();
  await page.locator('[data-testid="trash-purge-confirm"]').waitFor();
  const purgeText = await page.locator('[data-testid="trash-purge-confirm"]').innerText();
  assert.ok(purgeText.includes('영구 삭제하시겠습니까') && purgeText.includes('이미지 및 보존된 내용이 삭제됩니다') && purgeText.includes('휴지통에서 복구할 수 없습니다'), purgeText);
  await app.shot('25f-trash-purge-confirm');
  await page.locator('[data-testid="trash-purge-confirm"] button:has-text("취소")').click();
  assert.equal((await app.invoke('trash_list')).length, 1, '취소 — 그대로');
  await page.locator('[data-testid="trash-section"] [data-testid="trash-purge"]').first().click();
  const backupsBefore = (await app.invoke('backup_list')).filter(b => b.fileName.includes('pre-trash-purge')).length;
  await page.click('[data-testid="trash-purge-confirm-button"]');
  await waitFor(async () => (await app.invoke('trash_list')).length === 0, '영구 삭제');
  assert.ok((await app.invoke('backup_list')).filter(b => b.fileName.includes('pre-trash-purge')).length > backupsBefore, '영구 삭제 전 Backup');
  assert.equal((await app.invoke('history_list', { location: { kind: 'next', listId: target.id } })).length, 0, '보존된 내용도 삭제');
  await app.invoke('trash_purge', { id: target.id }); // 두 번 실행 — 오류 없음
  await page.locator('[data-testid="settings-dialog"] button:has-text("닫기")').click();
  // 재실행해도 다시 나타나지 않는다
  await app.restart();
  assert.ok(!(await app.invoke('memo_lists')).some(l => l.id === target.id), '다시 나타나지 않는다');
  for (const list of lists) if (list.id !== target.id) await app.invoke('list_delete', { id: list.id });
  for (const list of lists) if (list.id !== target.id) await app.invoke('trash_purge', { id: list.id });
});

step(
  'linked-list-delete-refused',
  async () => {
    if (!(await app.invoke('auth_status')).loggedIn) {
      await app.invoke('auth_login_begin', { reconnect: false });
      await waitFor(async () => (await app.invoke('auth_status')).loggedIn, '로그인');
    }
    await app.invoke('sync_now');
    const list = await app.invoke('list_create', { id: crypto.randomUUID(), name: '연결된 List' });
    const location = { kind: 'next', listId: list.id };
    await app.invoke('item_create', { input: { id: crypto.randomUUID(), location, section: 'next', kind: 'checklist', contentHtml: '연결된 메모' } });
    await app.invoke('sync_link', { location });
    await app.invoke('sync_now');
    const error = await app.invokeError('list_delete', { id: list.id });
    assert.equal(error.code, 'linked_list_managed', '서버 지원 전에는 삭제를 받지 않는다');
    assert.ok(error.message.includes('공통 관리 기능'));
    const kept = await app.invoke('memo_list', { listId: list.id });
    assert.equal(kept.items.length, 1, '메모 그대로');
    assert.equal(kept.list.document.syncEnabled, true, '연결 그대로');
    assert.ok(!(await app.invoke('trash_list')).some(e => e.listId === list.id), '휴지통에 들어가지 않는다');
    // 연동 해제 → 이 PC 의 List — 이름 변경·휴지통·복구가 다시 된다. 복구해도 저절로 연결하지 않는다.
    await app.invoke('sync_unlink', { location });
    await app.invoke('sync_now');
    assert.equal((await app.invoke('list_rename', { id: list.id, name: '이 PC 이름' })).name, '이 PC 이름');
    await app.invoke('list_delete', { id: list.id });
    const [entry] = (await app.invoke('trash_list')).filter(e => e.listId === list.id);
    assert.equal(entry.restorable, true);
    assert.equal(entry.wasLinked, false);
    await app.invoke('trash_restore', { id: list.id });
    await app.invoke('sync_now');
    const restored = await app.invoke('memo_list', { listId: list.id });
    assert.equal(restored.list.document.syncEnabled, false, '몰래 다시 연결하지 않는다');
    assert.equal(restored.items[0].contentHtml, '연결된 메모');
  },
  { mockOnly: true },
);

step('carryover-icon-notices', async () => {
  const page = app.page;
  // 지난 날짜인데 D-7 에 가져올 것이 없다 — 간결한 안내만, 창을 열지 않는다
  const past = plusDays(today, -200);
  await openDate(past);
  await page.click('[data-testid="carryover-open"]');
  await page.locator('text=가져올 미완료 체크리스트가 없습니다.').waitFor();
  assert.equal(await page.locator('[data-testid="carryover-dialog"]').count(), 0, '고를 것이 없으면 창이 없다');
  // Next List 에는 기준 날짜가 없다
  await page.click('[data-testid="memo-search-open"]');
  await page.locator('[data-testid="personal-memo-browse"] button').filter({ hasText: /^Next/ }).first().click();
  await page.locator('[data-testid="memo-next-list-tabs"]').waitFor();
  assert.ok(await page.locator('[data-testid="carryover-open"]').isDisabled(), 'List 화면에서는 비활성');
  await page.locator('[data-testid="carryover-open"]').locator('..').hover();
  await page.locator('[role="tooltip"]:has-text("날짜를 연 화면")').waitFor({ timeout: 5000 });
  await page.mouse.move(5, 300);
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
  await app.page.click('[data-testid="carryover-open"]');
  await app.page.locator('[data-testid="carryover-dialog"] [data-testid="carryover-picker"]').waitFor();
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
  assert.equal(await app.page.locator('[data-testid="memo-header-date"]').innerText(), englishDate(target), '알림의 날짜 상세');
  assert.equal(await app.invoke('app_take_pending_open'), null, '한 번 연 날짜는 비워진다');
});

// ── memo-sync-v2 공통 관리(Mock 서버 — 실제 PLAN-A Work 아님) ───────────────────────────────

const v2 = input => app.invoke('mock_v2_web', { input });
async function syncTimes(n = 3) {
  for (let i = 0; i < n; i++) await app.invoke('sync_now');
}

step(
  'shared-v2',
  async () => {
    // 로그인(새 기기) + 서버 v2 켜기
    if (!(await app.invoke('auth_status')).loggedIn) {
      await app.invoke('auth_login_begin', { reconnect: false });
      await waitFor(async () => (await app.invoke('auth_status')).loggedIn, '로그인');
    }
    await app.invoke('sync_now'); // 새 기기 등록 정리(이전 기기 연결 보존)를 먼저 — 앱도 로그인 직후 자동으로 한다
    await v2({ action: 'enable' });
    const target = plusDays(today, 3);
    const source = plusDays(target, -7);
    await addItem(source, 'main', '공통 복사 A');
    await addItem(source, 'main', '공통 복사 B');
    await addItem(target, 'am', '대상 날짜');
    await app.invoke('sync_link', { location: { kind: 'day', date: source } });
    await app.invoke('sync_link', { location: { kind: 'day', date: target } });
    await syncTimes();
    assert.equal((await app.invoke('management_day', { date: target })).mode, 'shared');

    // ① Web 에서 A 를 복사 → Desktop 에 보이고, 다시 권하지 않는다
    const serverSource = await v2({ action: 'items', date: source });
    const a = serverSource.find(i => i.content === '공통 복사 A');
    await v2({ action: 'carry', date: target, sourceIds: [a.id] });
    await syncTimes();
    assert.equal((await dayOf(target)).items.filter(i => i.contentHtml === '공통 복사 A').length, 1, 'Web 복사본이 Desktop 에');
    const fresh = await app.invoke('carryover_refresh', { date: target });
    assert.deepEqual(fresh.items.map(i => i.contentHtml), ['공통 복사 B'], '이미 복사한 A 는 다시 권하지 않는다');

    // ② Desktop(화면)에서 남은 B 가져오기 → 서버 공통 복사 1건, 중복 없음
    await openDate(target);
    await app.page.click('[data-testid="carryover-open"]');
    await app.page.locator('[data-testid="carryover-picker"]').waitFor();
    assert.equal(await app.page.locator('[data-testid="carryover-option"]').count(), 1);
    await app.shot('30-shared-carryover-picker');
    await app.page.click('[data-testid="carryover-import"]');
    await waitFor(async () => (await dayOf(target)).items.some(i => i.contentHtml === '공통 복사 B'), 'B 복사');
    await syncTimes();
    const serverTarget = (await v2({ action: 'items', date: target })).map(i => i.content);
    assert.equal(serverTarget.filter(c => c === '공통 복사 A').length, 1);
    assert.equal(serverTarget.filter(c => c === '공통 복사 B').length, 1, 'Desktop 복사도 서버에 한 번');
    assert.equal((await dayOf(target)).items.length, 3, '대상 1 + 복사 2 — 중복 없음');
    assert.equal((await dayOf(target)).document.syncStatus, 'synced');

    // ③ 알림: Desktop 설정 → 서버, Web 변경 → Desktop(Windows 예약 갱신)
    const r = plusDays(today, 20);
    await addItem(r, 'main', '알림 날짜 할 일');
    await app.invoke('sync_link', { location: { kind: 'day', date: r } });
    await syncTimes();
    await app.invoke('reminder_set', { date: r, offsets: [7, 2], time: '09:00' });
    await syncTimes();
    let state = await v2({ action: 'state', date: r });
    assert.deepEqual(state.rule.days_before, [7, 2], 'Desktop 설정이 공통 설정으로');
    await v2({ action: 'rule', date: r, offsets: [2], time: '18:30' });
    await syncTimes();
    const local = await app.invoke('reminder_get', { date: r });
    assert.deepEqual([local.offsets, local.time], [[2], '18:30'], 'Web 설정이 Desktop 에');
    const fire = local.fires[0].fireAt;
    await waitFor(async () => (await app.invoke('reminder_status')).task?.triggers.includes(fire), 'Windows 예약도 새 시각으로');

    // ④ Web 에서 확인 → Desktop 도 확인됨, 예약에서 빠진다
    await v2({ action: 'clock', at: new Date(new Date(`${fire}:00`).getTime() + 60_000).toISOString() });
    await v2({ action: 'ack', date: r, offset: 2 });
    await syncTimes();
    assert.equal((await app.invoke('reminder_get', { date: r })).fires[0].acknowledged, true);
    await waitFor(async () => !(await app.invoke('reminder_status')).task?.triggers.includes(fire), '확인된 알림은 예약하지 않는다');
    await v2({ action: 'clock', at: null });

    // ⑤ 동시 수정 → 두 설정 보관 + 화면에서 선택
    const c = plusDays(today, 22);
    await addItem(c, 'main', '충돌 날짜');
    await app.invoke('sync_link', { location: { kind: 'day', date: c } });
    await syncTimes();
    await app.invoke('mock_set_online', { online: false });
    await app.invoke('reminder_set', { date: c, offsets: [7], time: '08:00' });
    await v2({ action: 'rule', date: c, offsets: [2], time: '10:00' });
    await app.invoke('mock_set_online', { online: true });
    await syncTimes(2);
    assert.ok((await app.invoke('management_day', { date: c })).reminderConflict, '충돌 보관');
    await openDate(plusDays(c, -7));
    await app.page.locator(`[data-testid="upcoming-card-${c}"] [data-testid="upcoming-reminder-button"]`).click();
    await app.page.locator('[data-testid="reminder-conflict"]').waitFor();
    await app.shot('31-shared-reminder-conflict');
    await app.page.click('[data-testid="reminder-conflict-mine"]');
    await syncTimes();
    state = await v2({ action: 'state', date: c });
    assert.deepEqual([state.rule.days_before, state.rule.local_time], [[7], '08:00'], '고른 설정(이 PC)이 공통 설정으로');
    assert.equal((await app.invoke('management_day', { date: c })).reminderConflict, null);
  },
  { mockOnly: true },
);

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
