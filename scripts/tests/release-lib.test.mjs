// @vitest-environment node
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NOTES_DRAFT_MARK,
  SERVER_PROBE,
  applyVersion,
  beginTransaction,
  bumpVersion,
  checkUpdateServer,
  commitTransaction,
  compareDataSnapshots,
  compareVersions,
  compareWithRecord,
  decideVersion,
  draftNotes,
  inspectArtifacts,
  installerName,
  limitBuildJobs,
  loadStagingConfig,
  publishRelease,
  readPublished,
  readTransaction,
  readVersions,
  resolveNodeHome,
  rollbackTransaction,
  shellTransport,
  toolEnv,
  verifySignature,
} from '../lib/release-lib.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = 'https://updates.test/memo-updates';

// minisign 형식의 키·서명을 직접 만든다(Tauri CLI 없이).
function makeKeys(id = 'a1a2a3a4a5a6a7a8') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const body = Buffer.concat([Buffer.from('Ed'), Buffer.from(id, 'hex'), raw]).toString('base64');
  const pub = Buffer.from(`untrusted comment: minisign public key: ${id}\n${body}\n`).toString('base64');
  return { pub, privateKey, id };
}

function makeSig(keys, data, trusted, { algorithm = 'ED' } = {}) {
  const message = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  const signature = sign(null, message, keys.privateKey);
  const block = Buffer.concat([Buffer.from(algorithm), Buffer.from(keys.id, 'hex'), signature]).toString('base64');
  const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), keys.privateKey).toString('base64');
  return Buffer.from(`untrusted comment: signature\n${block}\ntrusted comment: ${trusted}\n${global}\n`).toString('base64');
}

describe('버전', () => {
  it('올리기와 비교 — 숫자로 비교한다(0.2.10 > 0.2.9)', () => {
    expect(bumpVersion('0.2.3')).toBe('0.2.4');
    expect(bumpVersion('0.2.3', 'minor')).toBe('0.3.0');
    expect(bumpVersion('0.2.3', 'major')).toBe('1.0.0');
    expect(compareVersions('0.2.10', '0.2.9')).toBe(1);
    expect(compareVersions('0.2.4', '0.2.4')).toBe(0);
    expect(() => bumpVersion('0.2.3-beta')).toThrow();
    expect(() => bumpVersion('0.2.3', 'huge')).toThrow();
  });

  const decide = over => decideVersion({ current: '0.2.3', head: '0.2.3', isBuilt: () => false, published: null, ...over });

  it('첫 실행 — 0.2.3 → 0.2.4', () => {
    expect(decide({})).toBe('0.2.4');
  });

  it('커밋도 빌드도 안 된 번호가 파일에 있으면(직접 고친 번호) 그 번호를 쓴다', () => {
    expect(decide({ current: '0.2.4' })).toBe('0.2.4');
  });

  it('이미 빌드한 번호는 새 업데이트로 다시 쓰지 않는다', () => {
    expect(decide({ current: '0.2.4', isBuilt: v => v === '0.2.4' })).toBe('0.2.5');
    expect(decide({ current: '0.2.4', head: '0.2.4', isBuilt: () => true, published: '0.2.4' })).toBe('0.2.5');
  });

  it('게시본보다 높은 번호만 — 뒤처진 파일이면 게시본 기준으로 올린다', () => {
    expect(decide({ current: '0.2.3', published: '0.2.7' })).toBe('0.2.8');
    expect(() => decide({ request: { noBump: true }, current: '0.2.4', published: '0.2.4' })).toThrow(/높지 않습니다/);
    expect(() => decide({ request: { version: '0.2.4' }, published: '0.2.5' })).toThrow(/높지 않습니다/);
  });

  it('명시한 요청을 따른다', () => {
    expect(decide({ request: { version: '0.3.0' } })).toBe('0.3.0');
    expect(decide({ request: { bump: 'minor' } })).toBe('0.3.0');
    expect(decide({ current: '0.2.4', isBuilt: () => true, request: { noBump: true } })).toBe('0.2.4');
    expect(() => decide({ request: { version: '0.3' } })).toThrow(/형식/);
  });

  it('버전이 적힌 곳을 함께 바꾸고 다른 패키지 버전·서식은 그대로 둔다', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'plana-ver-'));
    mkdirSync(path.join(dir, 'src-tauri'));
    for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
      cpSync(path.join(repo, file), path.join(dir, file));
    }
    const changedLines = (a, b) => a.split('\n').filter((line, i) => line !== b.split('\n')[i]).length;
    const read = file => readFileSync(path.join(dir, file), 'utf8');
    const before = { cargo: read('src-tauri/Cargo.lock'), lock: read('package-lock.json') };
    applyVersion(dir, '7.8.9');
    expect(new Set(readVersions(dir).map(v => v.version))).toEqual(new Set(['7.8.9']));
    const lock = JSON.parse(read('package-lock.json'));
    expect([lock.version, lock.packages[''].version]).toEqual(['7.8.9', '7.8.9']);
    expect(changedLines(before.lock, read('package-lock.json'))).toBe(2);
    expect(changedLines(before.cargo, read('src-tauri/Cargo.lock'))).toBe(1);
  });
});

describe('Node 경로', () => {
  it('Shim 이 아니라 실제 설치 폴더를 PATH 맨 앞에 — Path 키를 둘로 만들지 않는다', () => {
    const env = toolEnv('C:\\nvm\\v22', { Path: 'C:\\.nodejs' });
    expect(Object.keys(env)).toEqual(['Path']);
    expect(env.Path.startsWith('C:\\nvm\\v22')).toBe(true);
  });

  it('PLANA_NODE_HOME → C:\\nvm\\v<.nvmrc> → 실행 중인 node 순서', () => {
    const nvmrc = readFileSync(path.join(repo, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
    const nvmDir = path.join(`C:\\nvm\\v${nvmrc}`);
    expect(resolveNodeHome(repo, { PLANA_NODE_HOME: 'D:\\node' }, 'C:\\.nodejs\\node.exe', () => true)).toBe('D:\\node');
    expect(resolveNodeHome(repo, {}, 'C:\\.nodejs\\node.exe', file => file.startsWith(nvmDir))).toBe(nvmDir);
    expect(resolveNodeHome(repo, {}, path.join('C:\\.nodejs', 'node.exe'), () => false)).toBe(path.dirname(path.join('C:\\.nodejs', 'node.exe')));
  });
});

describe('빌드 설정', () => {
  it('Rust 병렬 작업 수 — 기본값을 제한하고, 지정한 값은 그대로 둔다', () => {
    expect(limitBuildJobs({}).CARGO_BUILD_JOBS).toBe('4');
    expect(limitBuildJobs({ CARGO_BUILD_JOBS: '2' }).CARGO_BUILD_JOBS).toBe('2');
  });

  it('SSH 대상은 이 PC 의 로컬 파일에서만 읽는다 — 저장소 설정에는 없다', () => {
    const shared = JSON.parse(readFileSync(path.join(repo, 'scripts', 'release.staging.json'), 'utf8'));
    expect(shared.ssh).toBeUndefined();
    expect(shared.baseUrl).toBe('https://staging.planawork.com/memo-updates');

    const root = mkdtempSync(path.join(tmpdir(), 'plana-config-'));
    mkdirSync(path.join(root, 'scripts'));
    writeFileSync(path.join(root, 'scripts', 'release.staging.json'), JSON.stringify({ baseUrl: BASE }));
    expect(loadStagingConfig(root).ssh).toBeUndefined();
    writeFileSync(path.join(root, 'scripts', 'release.staging.local.json'), JSON.stringify({ ssh: { host: 'h' } }));
    expect(loadStagingConfig(root)).toEqual({ baseUrl: BASE, ssh: { host: 'h' } });
  });
});

describe('실패 시 되돌리기', () => {
  function makeTree() {
    const root = mkdtempSync(path.join(tmpdir(), 'plana-tx-'));
    const version = path.join(root, 'package.json');
    const created = path.join(root, 'latest.json');
    const folder = path.join(root, '0.2.4');
    const dir = path.join(root, '.release-tx');
    writeFileSync(version, 'v0.2.3');
    return { root, version, created, folder, dir, files: [version, created], folders: [folder], meta: { from: '0.2.3', to: '0.2.4' } };
  }
  const start = tree => beginTransaction({ dir: tree.dir, files: tree.files, folders: tree.folders, meta: tree.meta });

  it('고친 파일은 원래 내용으로, 새로 생긴 파일·폴더는 지운다', () => {
    const tree = makeTree();
    start(tree);
    writeFileSync(tree.version, 'v0.2.4');
    writeFileSync(tree.created, 'new');
    mkdirSync(tree.folder);
    writeFileSync(path.join(tree.folder, 'setup.exe'), 'partial');
    expect(rollbackTransaction(tree.dir).from).toBe('0.2.3');
    expect(readFileSync(tree.version, 'utf8')).toBe('v0.2.3');
    expect(existsSync(tree.created)).toBe(false);
    expect(existsSync(tree.folder)).toBe(false);
    expect(existsSync(tree.dir)).toBe(false);
  });

  it('이미 있던 폴더(같은 버전 다시 빌드)는 치워 두었다가 그대로 돌려놓는다', () => {
    const tree = makeTree();
    mkdirSync(tree.folder);
    writeFileSync(path.join(tree.folder, 'release-record.json'), 'old');
    start(tree);
    expect(existsSync(tree.folder)).toBe(false);
    mkdirSync(tree.folder);
    writeFileSync(path.join(tree.folder, 'setup.exe'), 'partial');
    rollbackTransaction(tree.dir);
    expect(readFileSync(path.join(tree.folder, 'release-record.json'), 'utf8')).toBe('old');
    expect(existsSync(path.join(tree.folder, 'setup.exe'))).toBe(false);
  });

  it('강제 종료 뒤 — 기록만 남아 있어도 다음 실행이 되돌린다', () => {
    const tree = makeTree();
    start(tree);
    writeFileSync(tree.version, 'v0.2.4');
    expect(readTransaction(tree.dir).to).toBe('0.2.4'); // 프로세스는 없고 기록만 남은 상태
    rollbackTransaction(tree.dir);
    expect(readFileSync(tree.version, 'utf8')).toBe('v0.2.3');
    expect(rollbackTransaction(tree.dir)).toBeNull(); // 두 번 실행해도 안전
  });

  it('성공하면 바뀐 내용을 유지하고 치워 둔 것만 지운다', () => {
    const tree = makeTree();
    start(tree);
    writeFileSync(tree.version, 'v0.2.4');
    commitTransaction(tree.dir);
    expect(readFileSync(tree.version, 'utf8')).toBe('v0.2.4');
    expect(rollbackTransaction(tree.dir)).toBeNull();
  });
});

describe('릴리스 노트 초안', () => {
  it('커밋 제목에서 접두어를 빼고 초안 표시를 남긴다', () => {
    const draft = draftNotes(['feat: 날짜 검색', 'fix(ui): 잘림 수정', 'update code', '']);
    expect(draft).toContain(NOTES_DRAFT_MARK);
    expect(draft).toContain('- 날짜 검색\n- 잘림 수정');
    expect(draft).not.toContain('update code');
    expect(draftNotes([])).toContain('변경 사항을 적어주세요');
  });
});

describe('서명 확인', () => {
  const keys = makeKeys();
  const data = Buffer.from('installer bytes');
  const trusted = 'timestamp:1\tfile:setup.exe\tversion:0.2.5';

  it('맞는 서명 — 서명된 버전을 읽는다(prehash·legacy 모두)', () => {
    expect(verifySignature(data, makeSig(keys, data, trusted), keys.pub)).toEqual({ ok: true, signedVersion: '0.2.5' });
    expect(verifySignature(data, makeSig(keys, data, trusted, { algorithm: 'Ed' }), keys.pub).ok).toBe(true);
    expect(verifySignature(data, makeSig(keys, data, 'timestamp:1'), keys.pub)).toEqual({ ok: true, signedVersion: null });
  });

  it('파일이 바뀌면 거절', () => {
    expect(verifySignature(Buffer.from('tampered'), makeSig(keys, data, trusted), keys.pub).ok).toBe(false);
  });

  it('다른 키(같은 key id 포함) 서명은 거절', () => {
    expect(verifySignature(data, makeSig(makeKeys('b1b2b3b4b5b6b7b8'), data, trusted), keys.pub).reason).toMatch(/다른 키/);
    expect(verifySignature(data, makeSig(makeKeys(keys.id), data, trusted), keys.pub).ok).toBe(false);
  });

  it('trusted comment(버전)를 바꿔치면 거절', () => {
    const forged = Buffer.from(makeSig(keys, data, trusted), 'base64').toString().replace('version:0.2.5', 'version:0.2.9');
    expect(verifySignature(data, Buffer.from(forged).toString('base64'), keys.pub).reason).toMatch(/trusted comment/);
  });

  it('형식이 아니면 거절(예외 없이)', () => {
    expect(verifySignature(data, 'bm90IGEgc2lnbmF0dXJl', keys.pub).ok).toBe(false);
    expect(verifySignature(data, makeSig(keys, data, trusted), 'bm90IGEga2V5').ok).toBe(false);
  });
});

/** 임시 폴더에 dist 결과와 같은 구성을 만든다. */
function makeBuild(version = '0.2.5', over = {}) {
  const keys = makeKeys();
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'plana-art-')), version);
  mkdirSync(dir);
  const exe = Buffer.concat([Buffer.from('MZ'), Buffer.from(`installer ${version}`)]);
  const name = installerName(version);
  const sig = makeSig(keys, exe, `timestamp:1\tfile:${name}\tversion:${over.signedVersion ?? version}`);
  writeFileSync(path.join(dir, name), exe);
  writeFileSync(path.join(dir, `${name}.sig`), sig);
  const manifest = {
    version,
    channel: 'staging',
    notes: '- 변경',
    pub_date: '2026-11-02T00:00:00Z',
    platforms: { 'windows-x86_64': { signature: sig, url: `${BASE}/staging/${version}/${name}` } },
    ...over.manifest,
  };
  writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, keys, inspected: inspectArtifacts({ versionDir: dir, version, baseUrl: BASE, pubkey: keys.pub }) };
}

describe('산출물 검증', () => {
  it('정상 빌드는 문제 없음', () => {
    const { inspected } = makeBuild();
    expect(inspected.problems).toEqual([]);
    expect(inspected.files.map(f => f.name)).toEqual([installerName('0.2.5'), `${installerName('0.2.5')}.sig`]);
  });

  it.each([
    ['서명된 버전이 다름', { signedVersion: '0.2.4' }, /서명된 버전/],
    ['다른 채널', { manifest: { channel: 'production' } }, /channel/],
    ['다른 버전', { manifest: { version: '0.2.6' } }, /version 0.2.6/],
    ['노트 없음', { manifest: { notes: ' ' } }, /릴리스 노트/],
    ['초안 노트', { manifest: { notes: `${NOTES_DRAFT_MARK}\n- x` } }, /초안/],
    ['잘못된 URL', { manifest: { platforms: { 'windows-x86_64': { signature: 'x', url: `${BASE}/production/0.2.5/a.exe` } } } }, /url/],
    ['날짜 형식', { manifest: { pub_date: 'yesterday' } }, /pub_date/],
  ])('%s → 문제로 보고', (_name, over, pattern) => {
    expect(makeBuild('0.2.5', over).inspected.problems.join('\n')).toMatch(pattern);
  });

  it('다른 키로 서명한 빌드 → 문제로 보고', () => {
    const { dir } = makeBuild();
    const other = makeKeys('c1c2c3c4c5c6c7c8');
    const result = inspectArtifacts({ versionDir: dir, version: '0.2.5', baseUrl: BASE, pubkey: other.pub });
    expect(result.problems.join('\n')).toMatch(/다른 키/);
  });

  it('파일이 없으면 문제로 보고', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'plana-empty-'));
    expect(inspectArtifacts({ versionDir: empty, version: '0.2.5', baseUrl: BASE, pubkey: makeKeys().pub }).problems.length).toBe(3);
  });

  it('검증 기록과 해시가 다르면 게시하지 않는다', () => {
    const { inspected } = makeBuild();
    const all = [...inspected.files, inspected.manifestFile];
    expect(compareWithRecord(null, inspected)[0]).toMatch(/검증 기록/);
    expect(compareWithRecord({ files: all }, inspected)).toEqual([]);
    expect(compareWithRecord({ files: all.map(f => ({ ...f, sha256: 'x' })) }, inspected).length).toBe(3);
  });
});

/** 메모리 업데이트 서버 + 전송 기록. 올린 파일은 fetch 로 바로 보인다(실제 서버와 같게). */
function fakeServer({ published, spaFallback = false, corruptUpload = false, staleManifest = false } = {}) {
  const files = new Map();
  if (published) files.set(`${BASE}/staging/latest.json`, Buffer.from(JSON.stringify(published)));
  const calls = [];
  const fetchImpl = async url => {
    const bytes = files.get(url);
    if (bytes) return new Response(bytes, { status: 200, headers: { 'content-type': url.endsWith('.json') ? 'application/json' : 'application/octet-stream' } });
    if (spaFallback) return new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response('not found', { status: 404 });
  };
  const transport = {
    uploadVersion(version, list) {
      calls.push('version');
      for (const file of list) {
        const bytes = corruptUpload ? Buffer.from('broken') : readFileSync(file.path);
        files.set(`${BASE}/staging/${version}/${encodeURIComponent(file.name)}`, bytes);
      }
    },
    uploadManifest(file) {
      calls.push('manifest');
      if (!staleManifest) files.set(`${BASE}/staging/latest.json`, readFileSync(file.path));
    },
  };
  return { files, calls, fetchImpl, transport };
}

const publish = (build, server, version = '0.2.5') =>
  publishRelease({
    version,
    baseUrl: BASE,
    files: build.inspected.files,
    manifestFile: build.inspected.manifestFile,
    transport: server.transport,
    fetchImpl: server.fetchImpl,
  });

describe('서버 확인', () => {
  const respond = (status, type, text) => new Response(text, { status, headers: { 'content-type': type } });
  const LATEST = `${BASE}/staging/latest.json`;
  const PROBE = `${BASE}/staging/probe.json`;
  const server = routes => async url => {
    if (url in routes) return routes[url]();
    return routes.other();
  };
  const notFound = () => respond(404, 'text/plain', 'not found');
  // 실제 Staging 서버(nginx/1.24.0)가 없는 파일에 돌려주는 응답 그대로
  const nginx404 = () =>
    respond(404, 'text/html', '<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx/1.24.0 (Ubuntu)</center>\r\n</body>\r\n</html>\r\n');
  const spa = () => respond(200, 'text/html', '<!doctype html><div id="root"></div>');

  it('SPA fallback — 모든 경로에 웹 화면 HTML 200 → 문제', async () => {
    const { problems, published } = await checkUpdateServer(BASE, { fetchImpl: server({ other: spa }) });
    expect(problems.length).toBe(2);
    expect(problems[0]).toMatch(/SPA fallback/);
    expect(published.state).toBe('not-configured');
  });

  it('없는 파일은 404 인데 latest.json 만 웹 화면 HTML 200 → 문제', async () => {
    const { problems, published } = await checkUpdateServer(BASE, { fetchImpl: server({ [LATEST]: spa, other: nginx404 }) });
    expect(problems.join()).toMatch(/latest\.json/);
    expect(published.state).toBe('not-configured');
  });

  it('설정 후 — 없는 파일은 텍스트 404, latest.json 은 아직 없음 → 정상', async () => {
    const { problems, published } = await checkUpdateServer(BASE, { fetchImpl: server({ other: notFound }) });
    expect(problems).toEqual([]);
    expect(published.state).toBe('none');
  });

  it('Nginx 기본 HTML 404 → 정상적인 파일 없음', async () => {
    const { problems, published } = await checkUpdateServer(BASE, { fetchImpl: server({ other: nginx404 }) });
    expect(problems).toEqual([]);
    expect(published.state).toBe('none');
  });

  it('없는 파일에 404 도 HTML 200 도 아닌 응답 → 문제', async () => {
    for (const status of [403, 500]) {
      const { problems } = await checkUpdateServer(BASE, { fetchImpl: server({ other: () => respond(status, 'text/html', '<html></html>') }) });
      expect(problems.join()).toContain(`HTTP ${status}`);
    }
  });

  it('게시 후 — staging JSON 이면 정상, 다른 채널이면 문제', async () => {
    const json = channel => () => respond(200, 'application/json', JSON.stringify({ version: '0.2.4', channel }));
    const ok = await checkUpdateServer(BASE, { fetchImpl: server({ [LATEST]: json('staging'), other: notFound }) });
    expect(ok.problems).toEqual([]);
    expect(ok.published.version).toBe('0.2.4');
    const wrong = await checkUpdateServer(BASE, { fetchImpl: server({ [LATEST]: json('production'), other: notFound }) });
    expect(wrong.problems.join()).toMatch(/channel/);
  });

  describe('확인 파일(--probe)', () => {
    const body = JSON.stringify({ probe: SERVER_PROBE });
    const check = route => checkUpdateServer(BASE, { probe: true, fetchImpl: server({ ...(route ? { [PROBE]: route } : {}), other: nginx404 }) });

    it('200 · JSON Content-Type · 약속한 본문 → 정상', async () => {
      expect((await check(() => respond(200, 'application/json', `${body}\n`))).problems).toEqual([]);
      expect((await check(() => respond(200, 'application/json; charset=utf-8', body))).problems).toEqual([]);
    });

    it('파일이 없으면(Nginx 기본 404) → 문제', async () => {
      expect((await check()).problems.join()).toMatch(/probe\.json → HTTP 404/);
    });

    it('웹 화면 HTML 200 → 문제', async () => {
      expect((await check(spa)).problems.join()).toMatch(/Content-Type/);
    });

    it('본문이 맞아도 Content-Type 이 JSON 이 아니면 → 문제', async () => {
      expect((await check(() => respond(200, 'application/octet-stream', body))).problems.join()).toMatch(/Content-Type/);
    });

    it('JSON Content-Type 인데 본문이 다르면 → 문제', async () => {
      for (const wrong of ['', 'null', '{}', '{"probe":"other"}', `not json ${SERVER_PROBE}`]) {
        expect((await check(() => respond(200, 'application/json', wrong))).problems.join()).toMatch(/본문/);
      }
    });
  });

  it('연결 실패 → 문제', async () => {
    const down = async () => {
      throw new TypeError('fetch failed');
    };
    const { problems, published } = await checkUpdateServer(BASE, { fetchImpl: down });
    expect(problems.join()).toMatch(/연결하지 못했습니다/);
    expect(published.state).toBe('unreachable');
  });
});

describe('셸 transport', () => {
  it('임시 폴더에 올린 뒤 옮기고, 같은 버전 폴더를 덮어쓰지 않는다 · 경로 형식을 확인한다', () => {
    const commands = [];
    const copies = [];
    const transport = shellTransport({ remoteDir: '/var/www/memo-updates', remote: c => commands.push(c), copy: (n, d) => copies.push([n, d]) });
    transport.uploadVersion('0.2.4', [{ name: 'a.exe' }, { name: 'a.exe.sig' }]);
    transport.uploadManifest();
    expect(copies[0]).toEqual([['a.exe', 'a.exe.sig'], '/var/www/memo-updates/staging/.incoming-0.2.4/']);
    expect(copies[1]).toEqual([['latest.json'], '/var/www/memo-updates/staging/.incoming-latest.json']);
    expect(commands[1]).toContain("test ! -e '/var/www/memo-updates/staging/0.2.4'");
    expect(commands[2]).toContain('latest.previous.json');
    expect(() => shellTransport({ remoteDir: "/x'; rm -rf /", remote() {}, copy() {} })).toThrow(/remoteDir/);
  });
});

describe('업데이트 전후 데이터 비교', () => {
  const base = {
    storageRoot: 'D:/memo',
    integrity: 'ok',
    tables: { documents: 3, memo_items: 10, document_versions: 20, sync_outbox: 2 },
    attachments: { '2026/11/a.png': 'hash-a' },
    backups: ['memo-1-auto.sqlite3'],
  };
  const after = over => ({ ...base, backups: [...base.backups, 'memo-2-pre-update.sqlite3'], ...over });

  it('그대로면 통과 · 메모가 늘거나 대기열이 줄어드는 것은 문제가 아니다', () => {
    expect(compareDataSnapshots(base, after({})).problems).toEqual([]);
    expect(compareDataSnapshots(base, after({ tables: { ...base.tables, memo_items: 12, sync_outbox: 0 } })).problems).toEqual([]);
  });

  it('메모·History 가 줄거나 표가 없어지면 실패', () => {
    expect(compareDataSnapshots(base, after({ tables: { ...base.tables, memo_items: 9 } })).problems.join()).toMatch(/memo_items/);
    expect(compareDataSnapshots(base, after({ tables: { ...base.tables, document_versions: 19 } })).problems.join()).toMatch(/document_versions/);
    expect(compareDataSnapshots(base, after({ tables: { documents: 3, memo_items: 10, sync_outbox: 2 } })).problems.join()).toMatch(/없어졌습니다/);
  });

  it('이미지가 없어지거나 내용이 바뀌면 실패', () => {
    expect(compareDataSnapshots(base, after({ attachments: {} })).problems.join()).toMatch(/없어졌습니다/);
    expect(compareDataSnapshots(base, after({ attachments: { '2026/11/a.png': 'other' } })).problems.join()).toMatch(/바뀌었습니다/);
  });

  it('pre-update Backup 이 없거나 저장 위치가 바뀌거나 DB 가 손상되면 실패', () => {
    expect(compareDataSnapshots(base, { ...base }).problems.join()).toMatch(/pre-update/);
    expect(compareDataSnapshots(base, after({ storageRoot: 'C:/other' })).problems.join()).toMatch(/저장 위치/);
    expect(compareDataSnapshots(base, after({ integrity: 'malformed' })).problems.join()).toMatch(/무결성/);
  });
});

describe('게시 순서', () => {
  it('파일 먼저, latest.json 은 마지막', async () => {
    const build = makeBuild();
    const server = fakeServer();
    await expect(publish(build, server)).resolves.toEqual({ status: 'published', previous: null });
    expect(server.calls).toEqual(['version', 'manifest']);
    expect(server.files.get(`${BASE}/staging/latest.json`).equals(readFileSync(build.inspected.manifestFile.path))).toBe(true);
  });

  it('올린 파일의 해시가 다르면 latest.json 을 올리지 않는다', async () => {
    const server = fakeServer({ corruptUpload: true });
    await expect(publish(makeBuild(), server)).rejects.toThrow(/해시가 다릅니다/);
    expect(server.calls).toEqual(['version']);
  });

  it('SPA fallback(HTML 200)이면 서버 설정 전 — 아무것도 올리지 않는다', async () => {
    const server = fakeServer({ spaFallback: true });
    await expect(publish(makeBuild(), server)).rejects.toThrow(/nginx/);
    expect(server.calls).toEqual([]);
  });

  it('같은 버전을 다른 내용으로, 또는 더 낮은 버전을 게시하지 않는다', async () => {
    const same = fakeServer({ published: { version: '0.2.5', channel: 'staging' } });
    await expect(publish(makeBuild(), same)).rejects.toThrow(/높은 버전만/);
    const lower = fakeServer({ published: { version: '0.2.6', channel: 'staging' } });
    await expect(publish(makeBuild(), lower)).rejects.toThrow(/높은 버전만/);
    expect([...same.calls, ...lower.calls]).toEqual([]);
  });

  it('버전 폴더에 다른 파일이 있으면 덮어쓰지 않는다', async () => {
    const build = makeBuild();
    const server = fakeServer();
    server.files.set(`${BASE}/staging/0.2.5/${installerName('0.2.5')}`, Buffer.from('other'));
    await expect(publish(build, server)).rejects.toThrow(/이미 다른 파일/);
    expect(server.calls).toEqual([]);
  });

  it('다시 실행 — 이미 같으면 아무것도 바꾸지 않는다 · 파일만 올라갔으면 이어서 latest.json', async () => {
    const build = makeBuild();
    const server = fakeServer();
    await publish(build, server);
    server.calls.length = 0;
    await expect(publish(build, server)).resolves.toMatchObject({ status: 'already-published' });
    expect(server.calls).toEqual([]);

    const resume = fakeServer();
    for (const file of build.inspected.files) {
      resume.files.set(`${BASE}/staging/0.2.5/${encodeURIComponent(file.name)}`, readFileSync(file.path));
    }
    await publish(build, resume);
    expect(resume.calls).toEqual(['manifest']);
  });

  it('올린 뒤 latest.json 이 다르면(캐시 등) 실패로 보고', async () => {
    const server = fakeServer({ staleManifest: true });
    await expect(publish(makeBuild(), server)).rejects.toThrow(/latest.previous.json/);
  });

  it('서버 상태 읽기 — 게시본·없음·HTML·연결 실패를 구분한다', async () => {
    expect((await readPublished(BASE, fakeServer().fetchImpl)).state).toBe('none');
    expect((await readPublished(BASE, fakeServer({ spaFallback: true }).fetchImpl)).state).toBe('not-configured');
    expect((await readPublished(BASE, fakeServer({ published: { version: '0.2.4' } }).fetchImpl)).version).toBe('0.2.4');
    const down = async () => {
      throw new TypeError('fetch failed');
    };
    expect((await readPublished(BASE, down)).state).toBe('unreachable');
  });
});
