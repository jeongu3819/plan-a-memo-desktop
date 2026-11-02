// Staging 게시 — release-staging.mjs 가 검증한 빌드를 업데이트 서버에 올린다. Production 은 다루지 않는다.
//
//   npm run publish:staging                     게시 대상을 보여 주고 버전 번호를 입력해야 올린다
//   npm run publish:staging -- --dry-run        확인만(서버를 바꾸지 않는다)
//   npm run publish:staging -- --version 0.2.4  특정 버전(기본: release/staging 의 가장 높은 빌드)
//   npm run publish:staging -- --confirm 0.2.5  입력 대신 승인(터미널이 없는 실행). 대상 버전과 같아야 한다
//
// 순서: 파일 재검증 → 임시 폴더로 업로드 → 버전 폴더로 옮김 → HTTP 해시 확인 → 마지막에 latest.json.
// SSH 대상은 scripts/release.staging.local.json(커밋하지 않는다 — release.staging.local.example.json 참고).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  compareVersions,
  compareWithRecord,
  expandHome,
  inspectArtifacts,
  loadStagingConfig,
  parseVersion,
  publishRelease,
  readPublished,
  readRecord,
  recordPath,
  shellTransport,
} from './lib/release-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes('--dry-run');

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}
const info = message => console.log(`• ${message}`);

if (process.env.PLANA_ENV && process.env.PLANA_ENV !== 'staging') fail(`PLANA_ENV=${process.env.PLANA_ENV} — 이 스크립트는 staging 전용입니다.`);

const config = loadStagingConfig(root);
const channelDir = path.join(root, 'release', 'staging');
const pubkey = readFileSync(path.join(root, 'src-tauri', 'updater', 'staging.pub'), 'utf8').trim();

// ── 게시 대상 ──────────────────────────────────────────────────────────
const builds = existsSync(channelDir)
  ? readdirSync(channelDir).filter(name => parseVersion(name) && existsSync(recordPath(path.join(channelDir, name)))).sort(compareVersions)
  : [];
const version = option('--version') ?? builds[builds.length - 1];
if (!version) fail('게시할 빌드가 없습니다. 먼저 npm run release:staging 을 실행해주세요.');
if (!parseVersion(version)) fail(`버전 형식이 아닙니다: ${version}`);
const versionDir = path.join(channelDir, version);
const inspected = inspectArtifacts({ versionDir, version, baseUrl: config.baseUrl, pubkey });
const record = readRecord(versionDir);
const problems = inspected.problems.length ? inspected.problems : compareWithRecord(record, inspected);
if (problems.length) fail(`v${version} 을 게시할 수 없습니다:\n  - ${problems.join('\n  - ')}`);

const published = await readPublished(config.baseUrl);
const remoteText = {
  published: `v${published.version}`,
  none: '없음(첫 게시)',
  'not-configured': `서버 설정 전(${published.detail})`,
  unreachable: `연결 실패(${published.detail})`,
}[published.state];

console.log(`
게시 대상   Staging · v${version}
서버 현재   ${remoteText}
주소        ${config.baseUrl}/staging/latest.json
SSH         ${config.ssh ? `${config.ssh.user}@${config.ssh.host}:${config.ssh.remoteDir}/staging/` : '⚠ scripts/release.staging.local.json 없음'}
커밋        ${record.gitCommit.slice(0, 10)} (${record.gitBranch}${record.gitDirty ? ' · 커밋하지 않은 변경 포함' : ''})
검사        ${record.checks.length ? record.checks.join(' · ') : '⚠ 건너뜀'}
빌드 시각   ${record.builtAt}
파일`);
for (const file of [...inspected.files, inspected.manifestFile]) console.log(`  ${file.name}\n    ${file.size} bytes · sha256 ${file.sha256}`);
console.log(`\n릴리스 노트\n${inspected.manifest.notes.split('\n').map(line => `  ${line}`).join('\n')}\n`);

if (dryRun) {
  console.log('--dry-run: 서버를 바꾸지 않았습니다.\n');
  process.exit(0);
}

if (!config.ssh) fail('SSH 대상이 없습니다 — scripts/release.staging.local.example.json 을 release.staging.local.json 으로 복사해 채워주세요.');

// ── 승인 ───────────────────────────────────────────────────────────────
const confirm = option('--confirm');
if (confirm !== undefined) {
  if (confirm !== version) fail(`--confirm ${confirm} 이 게시 대상 v${version} 과 다릅니다.`);
} else {
  if (!process.stdin.isTTY) fail('승인을 입력받을 수 없습니다. 터미널에서 실행하거나 --confirm <버전> 을 붙여주세요.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`게시하려면 버전 번호(${version})를 입력하세요: `)).trim();
  rl.close();
  if (answer !== version) fail('취소했습니다 — 서버를 바꾸지 않았습니다.');
}

// ── SSH 전송 ───────────────────────────────────────────────────────────
const { host, user, identityFile, remoteDir } = config.ssh;
const identity = expandHome(identityFile);
if (!existsSync(identity)) fail(`SSH 키가 없습니다: ${identityFile}`);
// Windows OpenSSH 를 먼저 쓴다(Git 의 scp 는 C:\ 경로를 원격 주소로 읽는다).
const systemSsh = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'OpenSSH') : null;
const tool = name => (systemSsh && existsSync(path.join(systemSsh, `${name}.exe`)) ? path.join(systemSsh, `${name}.exe`) : name);
const sshOptions = ['-i', identity, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'StrictHostKeyChecking=yes'];
const target = `${user}@${host}`;
const stagingDir = `${remoteDir}/staging`;

function remote(command) {
  const r = spawnSync(tool('ssh'), [...sshOptions, target, command], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`서버 명령 실패: ${(r.stderr || r.error?.message || '').trim() || `exit ${r.status}`}`);
  return r.stdout;
}

function copy(names, destination) {
  // 파일 이름만 넘겨(cwd 기준) 로컬 경로의 한글·드라이브 문자를 scp 가 해석하지 않게 한다.
  const r = spawnSync(tool('scp'), [...sshOptions, '-q', ...names, `${target}:${destination}`], { cwd: versionDir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`업로드 실패: ${(r.stderr || r.error?.message || '').trim() || `exit ${r.status}`}`);
}

// ── 게시 ───────────────────────────────────────────────────────────────
let result;
try {
  const transport = shellTransport({ remoteDir, remote, copy });
  result = await publishRelease({
    version,
    baseUrl: config.baseUrl,
    files: inspected.files,
    manifestFile: inspected.manifestFile,
    transport,
    log: info,
  });
} catch (error) {
  fail(error.message);
}
if (result.status === 'already-published') {
  console.log(`\n✔ v${version} 은 이미 같은 내용으로 게시되어 있습니다.\n`);
  process.exit(0);
}
writeFileSync(recordPath(versionDir), `${JSON.stringify({ ...record, publishedAt: new Date().toISOString() }, null, 2)}\n`);
console.log(`
✔ Staging v${version} 게시 완료(이전: ${result.previous ? `v${result.previous}` : '없음'}) — 앱의 설정 → [업데이트 확인]에서 받을 수 있습니다.
  되돌리기: 서버의 ${stagingDir}/latest.previous.json 을 latest.json 으로 복사(docs/release.md).
`);
