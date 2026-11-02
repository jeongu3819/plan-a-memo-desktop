// Staging 릴리스 준비 — 서버 확인·검사·버전·서명 빌드·산출물 검증까지. 서버에는 아무것도 올리지 않는다(게시는 publish-staging.mjs).
//
//   npm run release:staging                  다음 패치 버전으로(예: 0.2.4 → 0.2.5)
//   npm run release:staging -- --bump minor  --bump patch|minor|major · --version 0.3.0 · --no-bump(이번 버전 다시 빌드)
//   npm run release:staging -- --e2e         E2E 도 실행
//   npm run release:staging -- --allow-dirty --allow-branch --skip-checks --allow-server-not-ready
//
// 서명 비밀번호는 입력을 화면에 보이지 않게 받는다(또는 환경 변수 TAURI_SIGNING_PRIVATE_KEY_PASSWORD).
// 개인키·비밀번호는 저장하지 않고 빌드 프로세스의 환경 변수로만 넘긴다. Production 은 다루지 않는다.
//
// 어느 단계에서 실패하든 버전 파일·산출물은 시작 전으로 되돌린다(릴리스 노트만 남는다). 프로세스가 강제 종료되면 다음 실행이 먼저 되돌린다.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  NOTES_DRAFT_MARK,
  applyVersion,
  beginTransaction,
  checkUpdateServer,
  commitTransaction,
  compareVersions,
  decideVersion,
  draftNotes,
  expandHome,
  inspectArtifacts,
  limitBuildJobs,
  loadStagingConfig,
  nodeBin,
  npmCli,
  parseVersion,
  readRecord,
  readTransaction,
  readVersions,
  recordPath,
  resolveNodeHome,
  rollbackTransaction,
  tauriCli,
  toolEnv,
  verifySignature,
} from './lib/release-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}
const KNOWN = ['--bump', '--version', '--no-bump', '--e2e', '--allow-dirty', '--allow-branch', '--skip-checks', '--allow-server-not-ready'];
args.forEach((arg, i) => {
  const isValue = i > 0 && ['--bump', '--version'].includes(args[i - 1]);
  if (!isValue && !KNOWN.includes(arg)) fail(`알 수 없는 옵션: ${arg}`);
});
const interactive = process.stdin.isTTY && process.stdout.isTTY;
const step = (n, title) => console.log(`\n[${n}/9] ${title}`);
const info = message => console.log(`  • ${message}`);

if (process.env.PLANA_ENV && process.env.PLANA_ENV !== 'staging') fail(`PLANA_ENV=${process.env.PLANA_ENV} — 이 스크립트는 staging 전용입니다.`);

const config = loadStagingConfig(root);
const nodeHome = resolveNodeHome(root);
const node = nodeBin(nodeHome);
const env = limitBuildJobs(toolEnv(nodeHome));
delete env.TAURI_SIGNING_PRIVATE_KEY_PATH; // 다른 키 경로가 끼어들지 않게
const channelDir = path.join(root, 'release', 'staging');

// ── 실패하면 시작 전으로 ────────────────────────────────────────────────
const txDir = path.join(channelDir, '.release-tx');
let txOpen = false;
function restore(message) {
  const journal = rollbackTransaction(txDir);
  if (journal) console.warn(`  ↩ ${message} — v${journal.from} 상태로 되돌렸습니다(버전 파일·산출물).`);
}
process.on('exit', () => {
  if (txOpen) restore(`v${releaseVersion} 빌드를 끝내지 못했습니다`);
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(130));
let releaseVersion;

const unfinished = readTransaction(txDir);
if (unfinished) {
  let alive = false;
  try {
    process.kill(unfinished.pid, 0);
    alive = unfinished.pid !== process.pid;
  } catch {
    /* 끝난 프로세스 */
  }
  if (alive) fail(`다른 release:staging 실행(pid ${unfinished.pid})이 진행 중입니다. 끝난 뒤 다시 실행해주세요.`);
  restore(`지난 실행(v${unfinished.to})이 중간에 끊겼습니다`);
}

const git = (...gitArgs) => {
  const r = spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** 입력을 화면에 보이지 않게 받는다. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    const { stdin } = process;
    let value = '';
    const finish = (error, result) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(result);
    };
    const onData = chunk => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish(null, value);
        if (ch === '\u0003') return finish(new Error('입력을 취소했습니다.'));
        if (ch === '\u0008' || ch === '\u007f') value = [...value].slice(0, -1).join('');
        else value += ch;
      }
      return undefined;
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

// ── 1. Git ─────────────────────────────────────────────────────────────
step(1, 'Git 상태');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const dirty = (git('status', '--porcelain') ?? '').split('\n').filter(Boolean);
info(`브랜치 ${branch} · 커밋 ${git('rev-parse', '--short', 'HEAD')} · 커밋하지 않은 변경 ${dirty.length}개`);
if (branch !== 'main' && !flag('--allow-branch')) {
  fail(`main 브랜치가 아닙니다(${branch}). 이 브랜치로 만들려면 --allow-branch 를 붙이세요.`);
}
if (dirty.length && !flag('--allow-dirty')) {
  dirty.slice(0, 20).forEach(line => info(line));
  if (dirty.length > 20) info(`… 외 ${dirty.length - 20}개`);
  if (!interactive) fail('커밋하지 않은 변경이 있습니다. 그대로 빌드하려면 --allow-dirty 를 붙이세요.');
  if (!/^y(es)?$/i.test(await ask('  이 변경을 포함해 빌드할까요? 릴리스 기록에 남습니다 [y/N] '))) fail('취소했습니다.');
}

// ── 2. 업데이트 서버 — 주소는 설치본에 영구히 들어가므로 정적 파일을 제대로 내주는 것을 확인한 뒤 빌드한다 ──
step(2, `업데이트 서버 ${config.baseUrl}`);
const server = await checkUpdateServer(config.baseUrl);
const serverReady = server.problems.length === 0;
if (serverReady) info(server.published.state === 'published' ? `정상 · 게시된 버전 v${server.published.version}` : '정상 · 게시된 버전 없음(첫 게시)');
else if (flag('--allow-server-not-ready')) server.problems.forEach(problem => console.warn(`  ⚠ ${problem}`));
else fail(`업데이트 서버가 준비되지 않았습니다(docs/release.md §4-2):\n  - ${server.problems.join('\n  - ')}`);

// ── 3. 서명 키 — 긴 검사·빌드 전에 비밀번호와 키 짝을 먼저 확인한다 ─────────
step(3, 'Staging 서명 키');
const keyPath = expandHome(config.signingKey);
const pubkeyPath = path.join(root, 'src-tauri', 'updater', 'staging.pub');
if (!existsSync(keyPath)) fail(`서명 개인키가 없습니다: ${config.signingKey} — 키를 새로 만들면 설치된 앱이 업데이트를 받지 못합니다. 원래 키를 찾아주세요.`);
if (!existsSync(pubkeyPath)) fail('공개키 src-tauri/updater/staging.pub 이 없습니다.');
const pubkey = readFileSync(pubkeyPath, 'utf8').trim();
if (!git('ls-files', 'src-tauri/updater/staging.pub')) {
  console.warn('  ⚠ src-tauri/updater/staging.pub 이 아직 커밋되지 않았습니다 — 다른 PC·새 checkout 에서는 업데이트가 꺼진 빌드가 됩니다.');
}
if (!env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
  if (!interactive) fail('환경 변수 TAURI_SIGNING_PRIVATE_KEY_PASSWORD 가 없고 입력을 받을 수 없습니다(터미널에서 실행해주세요).');
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = await askHidden('  서명 키 비밀번호(화면에 보이지 않음): ').catch(error => fail(error.message));
}
{
  // 작은 파일에 시험 서명 → 공개키로 확인. 틀리면 몇 분 뒤 빌드 끝에서야 실패하므로 여기서 멈춘다.
  const probeDir = mkdtempSync(path.join(tmpdir(), 'plana-sign-'));
  try {
    const probe = path.join(probeDir, 'probe.bin');
    writeFileSync(probe, 'plan-a-memo signing probe');
    const r = spawnSync(node, [tauriCli(root), 'signer', 'sign', '--private-key-path', keyPath, probe], { cwd: root, env, stdio: 'ignore' });
    if (r.status !== 0) fail('서명 시험에 실패했습니다 — 비밀번호를 확인해주세요(키 파일을 새로 만들지 마세요).');
    const checked = verifySignature(readFileSync(probe), readFileSync(`${probe}.sig`, 'utf8'), pubkey);
    if (!checked.ok) fail(`개인키와 staging.pub 이 짝이 아닙니다(${checked.reason}). 이대로 빌드하면 설치된 앱이 업데이트를 거부합니다.`);
    info('비밀번호 확인 · 개인키와 공개키 짝 확인');
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

// ── 4. 버전 ────────────────────────────────────────────────────────────
step(4, '버전');
const versions = readVersions(root);
const distinct = new Set(versions.map(v => v.version));
if (distinct.size !== 1) fail(`버전이 서로 다릅니다: ${versions.map(v => `${v.file} ${v.version}`).join(' · ')} — 같은 값으로 맞춘 뒤 다시 실행해주세요.`);
const [current] = distinct;
if (!parseVersion(current)) fail(`지금 버전 '${current}' 이 x.y.z 형식이 아닙니다.`);
const headPackage = git('show', 'HEAD:package.json');
const { published } = server;

let version;
try {
  version = decideVersion({
    current,
    head: headPackage ? JSON.parse(headPackage).version : null,
    published: published.state === 'published' ? published.version : null,
    isBuilt: v => existsSync(recordPath(path.join(channelDir, v))),
    request: { version: option('--version'), bump: option('--bump'), noBump: flag('--no-bump') },
  });
} catch (error) {
  fail(error.message);
}
const versionDir = path.join(channelDir, version);
beginTransaction({
  dir: txDir,
  meta: { from: current, to: version },
  files: [
    ...new Set(versions.map(v => path.join(root, v.file))),
    path.join(channelDir, 'latest.json'),
    path.join(channelDir, 'PLAN-A-Memo-Staging-Setup.exe'),
  ],
  folders: [versionDir],
});
txOpen = true;
releaseVersion = version;
if (version !== current) {
  applyVersion(root, version);
  info(`v${current} → v${version} (package.json · package-lock.json · tauri.conf.json · Cargo.toml · Cargo.lock)`);
} else {
  info(`v${version} 그대로`);
}

// ── 5. 릴리스 노트 ─────────────────────────────────────────────────────
step(5, '릴리스 노트');
const notesFile = path.join(root, 'release-notes', `${version}.md`);
const notesRel = `release-notes/${version}.md`;
if (!existsSync(notesFile)) {
  // 지난 빌드 이후 커밋 제목으로 초안을 만든다.
  const earlier = existsSync(channelDir)
    ? readdirSync(channelDir)
        .filter(name => parseVersion(name) && compareVersions(name, version) < 0 && readRecord(path.join(channelDir, name)))
        .sort(compareVersions)
    : [];
  const since = earlier.length ? readRecord(path.join(channelDir, earlier[earlier.length - 1])).gitCommit : null;
  writeFileSync(notesFile, draftNotes((since ? git('log', `${since}..HEAD`, '--format=%s') ?? '' : '').split('\n')));
  info(`초안을 만들었습니다: ${notesRel}`);
}
const notesAreDraft = () => {
  const text = readFileSync(notesFile, 'utf8');
  return text.includes(NOTES_DRAFT_MARK) || !text.trim();
};
if (notesAreDraft()) {
  if (!interactive) fail(`${notesRel} 이 초안입니다. 사용자에게 보일 내용으로 고치고 첫 줄을 지운 뒤 다시 실행해주세요.`);
  await ask(`  ${notesRel} 을 고치고 첫 줄(초안 표시)을 지운 뒤 Enter — 앱 업데이트 화면에 그대로 보입니다. `);
  if (notesAreDraft()) fail(`${notesRel} 이 아직 초안입니다. 고친 뒤 다시 실행해주세요.`);
}
readFileSync(notesFile, 'utf8').trim().split(/\r?\n/).forEach(line => info(line));

// ── 6. 검사 ────────────────────────────────────────────────────────────
step(6, '검사');
// 검사 단계에는 서명 값을 넘기지 않는다.
const checkEnv = { ...env };
delete checkEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
const checksRun = [];
if (flag('--skip-checks')) {
  console.warn('  ⚠ 검사를 건너뜁니다(--skip-checks) — 릴리스 기록에 남습니다.');
} else {
  const scripts = ['type-check', 'lint', 'test', 'test:rust'];
  if (flag('--e2e')) scripts.push('e2e:build', 'e2e');
  for (const script of scripts) {
    info(`npm run ${script}`);
    const r = spawnSync(node, [npmCli(nodeHome), 'run', '--silent', script], { cwd: root, env: checkEnv, stdio: 'inherit' });
    if (r.status !== 0) fail(`${script} 실패 — 고친 뒤 다시 실행해주세요.`);
    checksRun.push(script);
  }
}

// ── 7. 빌드·서명 ───────────────────────────────────────────────────────
step(7, `서명 빌드(tauri build · Rust 병렬 ${env.CARGO_BUILD_JOBS}) — 몇 분 걸립니다`);
const buildEnv = { ...env, PLANA_ENV: 'staging', TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, 'utf8').trim() };
const built = spawnSync(node, [path.join(root, 'scripts', 'dist.mjs'), 'staging'], { cwd: root, env: buildEnv, stdio: 'inherit' });
if (built.status !== 0) fail('빌드 실패 — 고친 뒤 다시 실행해주세요. 컴파일러가 강제 종료됐다면 다른 프로그램을 닫거나 CARGO_BUILD_JOBS 를 줄여주세요.');

// ── 8. 산출물 검증 ─────────────────────────────────────────────────────
step(8, '산출물 검증(버전·해시·경로·서명)');
const inspected = inspectArtifacts({ versionDir, version, baseUrl: config.baseUrl, pubkey });
if (inspected.problems.length) fail(`산출물에 문제가 있습니다:\n  - ${inspected.problems.join('\n  - ')}`);
for (const file of inspected.files) info(`${file.name} · ${file.size} bytes · sha256 ${file.sha256}`);
info(`latest.json · sha256 ${inspected.manifestFile.sha256}`);

// ── 9. 기록 — 여기까지 와야 이 빌드가 확정된다 ──────────────────────────
step(9, '릴리스 기록');
const record = {
  version,
  channel: 'staging',
  builtAt: new Date().toISOString(),
  gitBranch: branch,
  gitCommit: git('rev-parse', 'HEAD'),
  gitDirty: dirty.length > 0,
  checks: checksRun,
  serverChecked: serverReady,
  files: [...inspected.files, inspected.manifestFile].map(({ name, size, sha256 }) => ({ name, size, sha256 })),
};
writeFileSync(recordPath(versionDir), `${JSON.stringify(record, null, 2)}\n`);
info(path.relative(root, recordPath(versionDir)));
txOpen = false;
commitTransaction(txDir);

console.log(`
✔ v${version} 준비 완료 — 서버에는 아직 아무것도 올리지 않았습니다.
  게시:        npm run publish:staging
  직접 설치:   ${path.relative(root, path.join(versionDir, inspected.files[0].name))}
`);
