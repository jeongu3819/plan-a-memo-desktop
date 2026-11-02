// 업데이트 전후 데이터 보존 확인 — 메모 내용은 보지 않고 표별 개수·이미지 해시·Backup 목록만 비교한다.
//
//   npm run update:data-check -- snapshot   업데이트 전(앱을 닫고)
//   npm run update:data-check -- compare    업데이트 후(앱을 닫고)
//   --storage <폴더>                        저장 위치를 직접 지정(기본: Staging 앱 설정에서 읽음)
//   --out <파일>                            스냅숏 파일(기본: release/staging/data-snapshot.json)
//
// 원본에는 쓰지 않는다 — DB 는 임시 폴더로 복사해 그 사본을 연다.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { compareDataSnapshots } from './lib/release-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = args[0];

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}
if (!['snapshot', 'compare'].includes(mode)) fail('npm run update:data-check -- snapshot  또는  compare');

function storageRoot() {
  if (option('--storage')) return path.resolve(option('--storage'));
  const configFile = path.join(process.env.APPDATA ?? '', 'com.plana.memo.staging', 'app-config.json');
  if (!existsSync(configFile)) fail(`Staging 앱 설정이 없습니다: ${configFile}`);
  const dir = JSON.parse(readFileSync(configFile, 'utf8')).storageDir;
  if (!dir) fail('Staging 앱에 저장 위치가 아직 없습니다.');
  return dir;
}

function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full).replaceAll('\\', '/')];
  });
}

function takeSnapshot(storage) {
  const dbFile = path.join(storage, 'data', 'memo.sqlite3');
  if (!existsSync(dbFile)) fail(`메모 DB 가 없습니다: ${dbFile}`);
  const work = mkdtempSync(path.join(tmpdir(), 'plana-data-check-'));
  try {
    const copy = path.join(work, 'memo.sqlite3');
    copyFileSync(dbFile, copy);
    if (existsSync(`${dbFile}-wal`)) copyFileSync(`${dbFile}-wal`, `${copy}-wal`);
    const db = new DatabaseSync(copy);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    const tables = Object.fromEntries(names.map(name => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]));
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    db.close();
    const attachmentsDir = path.join(storage, 'attachments');
    const attachments = Object.fromEntries(
      listFiles(attachmentsDir).map(file => [file, createHash('sha256').update(readFileSync(path.join(attachmentsDir, file))).digest('hex')]),
    );
    return { takenAt: new Date().toISOString(), storageRoot: storage, tables, integrity, attachments, backups: listFiles(path.join(storage, 'backups')) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const outFile = path.resolve(option('--out') ?? path.join(root, 'release', 'staging', 'data-snapshot.json'));
const now = takeSnapshot(storageRoot());
const summary = snapshot =>
  `document_versions(History) ${snapshot.tables.document_versions ?? '-'} · memo_items ${snapshot.tables.memo_items ?? '-'} · documents ${snapshot.tables.documents ?? '-'} · 이미지 ${Object.keys(snapshot.attachments).length} · Backup ${snapshot.backups.length} · 무결성 ${snapshot.integrity}`;

if (mode === 'snapshot') {
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(now, null, 2)}\n`);
  console.log(`\n✔ 업데이트 전 스냅숏: ${outFile}\n  저장 위치 ${now.storageRoot}\n  ${summary(now)}\n`);
} else {
  if (!existsSync(outFile)) fail(`스냅숏이 없습니다: ${outFile} — 업데이트 전에 snapshot 을 먼저 실행합니다.`);
  const before = JSON.parse(readFileSync(outFile, 'utf8'));
  const { problems, notes } = compareDataSnapshots(before, now);
  console.log(`\n전 ${before.takenAt}\n  ${summary(before)}\n후 ${now.takenAt}\n  ${summary(now)}`);
  notes.forEach(note => console.log(`  • ${note}`));
  if (problems.length) fail(`보존 확인 실패:\n  - ${problems.join('\n  - ')}`);
  console.log('\n✔ 메모·History·이미지 보존 확인 · pre-update Backup 있음\n');
}
