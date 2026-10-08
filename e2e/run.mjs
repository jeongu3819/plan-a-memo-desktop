// PLAN-A Memo E2E — 실제 앱을 띄워 핵심 흐름을 순서대로 확인한다.
//   npm run e2e:build   (development debug 빌드 · Mock 서버)
//   npm run e2e         (전체)   /   node e2e/run.mjs memo image   (이름에 맞는 단계만 — 앞 단계 상태가 필요하면 함께)
// 결과 스크린샷: e2e/output/*.png  ·  PLANA_E2E_KEEP=1 이면 임시 저장소를 남긴다.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { App, clearE2eCredential, isMockRun } from './harness.mjs';

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
  execFileSync('cmd', ['/c', 'start', '', 'plana-memo://open'], { stdio: 'ignore' });
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

const only = process.argv.slice(2);
let failed = 0;
clearE2eCredential();
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
}
console.log(failed ? `E2E 실패 ${failed}` : 'E2E 통과');
process.exit(failed ? 1 : 0);
