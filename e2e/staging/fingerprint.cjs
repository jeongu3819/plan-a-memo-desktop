// 설치된 Staging 의 메모 지문 — 복사본만 읽는다. 내용·토큰은 출력하지 않는다(건수와 해시만).
// 시험 전후 출력이 같으면 설치본 메모가 그대로라는 뜻이다.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const src = path.join(os.homedir(), 'PLAN-A Memo Staging', 'data');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plana-fingerprint-'));
try {
  for (const f of ['memo.sqlite3', 'memo.sqlite3-wal', 'memo.sqlite3-shm']) {
    if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(tmp, f));
  }
  const db = new DatabaseSync(path.join(tmp, 'memo.sqlite3'));
  const q = (s) => db.prepare(s).all();
  const h = (rows) => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
  const items = q('SELECT * FROM memo_items ORDER BY id');
  const docs = q('SELECT id, kind, sync_enabled, sync_status, local_revision FROM documents ORDER BY id');
  const out = {
    items: items.length,
    itemsHash: h(items),
    documents: docs.length,
    docsHash: h(docs),
    linked: q('SELECT COUNT(*) n FROM sync_links')[0].n,
    linksHash: h(q('SELECT document_id, account_key, link_id, server_document_id FROM sync_links ORDER BY document_id')),
    versions: q('SELECT COUNT(*) n FROM document_versions')[0].n,
    openConflicts: q("SELECT COUNT(*) n FROM conflicts WHERE status='open'")[0].n,
    outbox: q('SELECT COUNT(*) n FROM sync_outbox')[0].n,
    dateRange: q("SELECT MIN(memo_date) a, MAX(memo_date) b FROM documents WHERE kind='DAY'").map((r) => [r.a, r.b])[0],
  };
  db.close();
  console.log(JSON.stringify(out, null, 1));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
