// 릴리스 스크립트 공용 함수 — 버전 · 서명 검증 · 산출물 검증 · 게시 순서. docs/release.md 참고.
// 개인키·비밀번호는 여기서 다루지 않는다(release-staging.mjs 가 빌드 프로세스 환경으로만 넘긴다).

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// ── 도구 경로 ──────────────────────────────────────────────────────────
export const expandHome = value => (value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value);

/** 저장소의 release.staging.json(공개 값) + 이 PC 의 release.staging.local.json(SSH 대상 — 커밋하지 않는다). */
export function loadStagingConfig(root) {
  const config = JSON.parse(readFileSync(path.join(root, 'scripts', 'release.staging.json'), 'utf8'));
  const localFile = path.join(root, 'scripts', 'release.staging.local.json');
  return existsSync(localFile) ? { ...config, ...JSON.parse(readFileSync(localFile, 'utf8')) } : config;
}

/**
 * 실제 Node 설치 폴더. nvm Shim(C:\.nodejs)을 거치면 npm·npx 실행이 실패하는 PC 가 있어 Shim 에 기대지 않는다.
 * PLANA_NODE_HOME → C:\nvm\v<.nvmrc> → 지금 실행 중인 node 순서.
 */
export function resolveNodeHome(root, env = process.env, execPath = process.execPath, exists = existsSync) {
  const nvmrc = readFileSync(path.join(root, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
  const candidates = [env.PLANA_NODE_HOME, `C:\\nvm\\v${nvmrc}`, path.dirname(execPath)].filter(Boolean);
  const nodeExe = process.platform === 'win32' ? 'node.exe' : 'node';
  const home = candidates.find(dir => exists(path.join(dir, nodeExe)));
  return home ?? path.dirname(execPath);
}

/** 환경 변수를 복사하고 Node 폴더를 PATH 맨 앞에 — Tauri CLI 의 beforeBuildCommand(npm run build)도 같은 Node 를 쓴다. */
export function toolEnv(nodeHome, base = process.env) {
  const env = { ...base };
  // Windows 의 환경 변수 이름은 대소문자를 가리지 않지만 객체로 복사하면 가린다(Path·PATH 가 둘이 되면 안 된다).
  const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH';
  env[key] = [nodeHome, env[key]].filter(Boolean).join(path.delimiter);
  return env;
}

/** Rust 병렬 작업 수 — 기본값(CPU 수)은 메모리가 부족한 PC 에서 컴파일러가 강제 종료된다. CARGO_BUILD_JOBS 로 바꿀 수 있다. */
export const DEFAULT_CARGO_JOBS = '4';
export function limitBuildJobs(env) {
  env.CARGO_BUILD_JOBS ||= DEFAULT_CARGO_JOBS;
  return env;
}

export const nodeBin = nodeHome => path.join(nodeHome, process.platform === 'win32' ? 'node.exe' : 'node');
export const tauriCli = root => path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
export const npmCli = nodeHome => path.join(nodeHome, 'node_modules', 'npm', 'bin', 'npm-cli.js');

// ── 버전 ───────────────────────────────────────────────────────────────
/** x.y.z 숫자만(Windows 설치 정보·Updater 비교에 쓰는 형식). 아니면 null. */
export function parseVersion(value) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const [pa, pb] = [parseVersion(a), parseVersion(b)];
  if (!pa || !pb) throw new Error(`버전 형식이 아닙니다: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function bumpVersion(value, level = 'patch') {
  const p = parseVersion(value);
  if (!p) throw new Error(`버전 형식이 아닙니다: ${value}`);
  if (level === 'major') return `${p[0] + 1}.0.0`;
  if (level === 'minor') return `${p[0]}.${p[1] + 1}.0`;
  if (level === 'patch') return `${p[0]}.${p[1]}.${p[2] + 1}`;
  throw new Error(`알 수 없는 단계: ${level} (patch · minor · major)`);
}

/**
 * 이번 릴리스 버전. 이미 빌드했거나 게시한 번호를 새 업데이트로 다시 쓰지 않는다.
 * @param current   파일에 적힌 버전
 * @param head      HEAD 커밋의 버전(없으면 null)
 * @param isBuilt   version => 이 버전의 빌드 기록이 있는가
 * @param published 서버에 게시된 버전(모르면 null)
 * @param request   { version?, bump?, noBump? }
 */
export function decideVersion({ current, head, isBuilt, published, request = {} }) {
  const notPublished = version => {
    if (published && compareVersions(version, published) <= 0) {
      throw new Error(`v${version} 은 게시된 v${published} 보다 높지 않습니다 — 앱이 새 업데이트로 보지 않습니다.`);
    }
    return version;
  };
  if (request.version) {
    if (!parseVersion(request.version)) throw new Error(`버전 형식이 아닙니다: ${request.version}`);
    return notPublished(request.version);
  }
  if (request.noBump) return notPublished(current);
  if (request.bump) return notPublished(bumpVersion(current, request.bump));
  // 커밋도 빌드도 안 된 번호가 파일에 있다(직접 고친 번호) — 건너뛰지 않고 그 번호를 쓴다.
  const interrupted = head !== null && head !== current && !isBuilt(current);
  if (interrupted && (!published || compareVersions(current, published) > 0)) return current;
  const next = bumpVersion(current);
  return published && compareVersions(next, published) <= 0 ? bumpVersion(published) : next;
}

/** 버전이 적힌 곳. 내용 일부만 바꿔 서식·줄바꿈을 그대로 둔다. package-lock.json 은 맨 위와 packages[""] 두 곳이다. */
const VERSION_FIELDS = [
  { file: 'package.json', pattern: /^(\s*"version":\s*")[^"]+(")/m },
  { file: 'package-lock.json', pattern: /^(\s*"version":\s*")[^"]+(")/m },
  { file: 'package-lock.json', pattern: /("packages":\s*\{\s*"":\s*\{\s*"name":\s*"[^"]+",\s*"version":\s*")[^"]+(")/ },
  { file: 'src-tauri/tauri.conf.json', pattern: /^(\s*"version":\s*")[^"]+(")/m },
  { file: 'src-tauri/Cargo.toml', pattern: /^(version\s*=\s*")[^"]+(")/m },
  { file: 'src-tauri/Cargo.lock', pattern: /(name = "plan-a-memo"\r?\nversion = ")[^"]+(")/ },
];

export function readVersions(root) {
  return VERSION_FIELDS.map(({ file, pattern }) => {
    const match = pattern.exec(readFileSync(path.join(root, file), 'utf8'));
    if (!match) throw new Error(`${file} 에서 버전을 찾지 못했습니다.`);
    return { file, version: /"([^"]+)"$/.exec(match[0])[1] };
  });
}

/** 먼저 전부 계산하고 나서 쓴다 — 패턴을 못 찾으면 어느 파일도 바꾸지 않는다. */
export function applyVersion(root, version) {
  const contents = new Map();
  for (const { file, pattern } of VERSION_FIELDS) {
    const text = contents.get(file) ?? readFileSync(path.join(root, file), 'utf8');
    if (!pattern.test(text)) throw new Error(`${file} 에서 버전을 찾지 못했습니다.`);
    contents.set(file, text.replace(pattern, `$1${version}$2`));
  }
  for (const [file, text] of contents) writeFileSync(path.join(root, file), text);
}

// ── 릴리스 노트 ────────────────────────────────────────────────────────
/** 이 줄이 남아 있으면 사람이 확인하지 않은 초안이다 — 앱 화면에 그대로 보이므로 빌드하지 않는다. */
export const NOTES_DRAFT_MARK = '<!-- 초안: 사용자에게 보일 내용으로 고친 뒤 이 줄을 지우세요 -->';

export function draftNotes(subjects) {
  const lines = subjects
    .map(subject => subject.replace(/^(feat|fix|chore|refactor|docs|style|test)(\([^)]*\))?:\s*/i, '').trim())
    .filter(subject => subject && subject !== 'update code')
    .map(subject => `- ${subject}`);
  return `${NOTES_DRAFT_MARK}\n${(lines.length ? lines : ['- (변경 사항을 적어주세요)']).join('\n')}\n`;
}

// ── 서명(minisign) 확인 — 앱의 Updater 와 같은 규칙을 게시 전에 ─────────
const b64 = value => Buffer.from(value, 'base64');

/** 공개키 파일 내용(base64) → { keyId, key }. */
export function parsePublicKey(pubkeyB64) {
  const line = b64(pubkeyB64.trim()).toString('utf8').split(/\r?\n/)[1];
  const raw = line ? b64(line.trim()) : Buffer.alloc(0);
  if (raw.length !== 42) throw new Error('공개키 형식이 아닙니다.');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.subarray(10).toString('base64url') }, format: 'jwk' });
  return { keyId: raw.subarray(2, 10).toString('hex'), key };
}

/**
 * .sig 내용(base64)을 공개키로 확인한다. tauri-plugin-updater verify_signature 와 같은 순서:
 * 파일 서명 → 전역 서명(trusted comment 포함) → 그다음에야 trusted comment 의 version 을 믿는다.
 * @returns {{ ok: boolean, reason?: string, signedVersion?: string|null }}
 */
export function verifySignature(data, signatureB64, pubkeyB64) {
  let pub;
  try {
    pub = parsePublicKey(pubkeyB64);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  const lines = b64(signatureB64.trim()).toString('utf8').split(/\r?\n/);
  if (lines.length < 4 || !lines[2].startsWith('trusted comment: ')) return { ok: false, reason: '서명 파일 형식이 아닙니다.' };
  const sigBlock = b64(lines[1].trim());
  if (sigBlock.length !== 74) return { ok: false, reason: '서명 파일 형식이 아닙니다.' };
  const algorithm = sigBlock.subarray(0, 2).toString('latin1');
  const keyId = sigBlock.subarray(2, 10).toString('hex');
  const signature = sigBlock.subarray(10);
  if (keyId !== pub.keyId) return { ok: false, reason: `다른 키로 서명했습니다(서명 ${keyId} · 공개키 ${pub.keyId}).` };
  let message;
  if (algorithm === 'ED') message = createHash('blake2b512').update(data).digest();
  else if (algorithm === 'Ed') message = data;
  else return { ok: false, reason: `알 수 없는 서명 방식: ${algorithm}` };
  if (!cryptoVerify(null, message, pub.key, signature)) return { ok: false, reason: '파일과 서명이 맞지 않습니다.' };
  const trusted = lines[2].slice('trusted comment: '.length);
  const globalOk = cryptoVerify(null, Buffer.concat([signature, Buffer.from(trusted, 'utf8')]), pub.key, b64(lines[3].trim()));
  if (!globalOk) return { ok: false, reason: 'trusted comment 가 서명과 맞지 않습니다.' };
  const signedVersion = trusted.split('\t').find(field => field.startsWith('version:'))?.slice('version:'.length) ?? null;
  return { ok: true, signedVersion };
}

// ── 산출물 ─────────────────────────────────────────────────────────────
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const installerName = version => `PLAN-A-Memo-Staging_${version}_x64-setup.exe`;

/** release/staging/<버전>/ 의 파일들이 게시해도 되는 상태인지. 문제 목록(없으면 빈 배열)과 파일 정보를 돌려준다. */
export function inspectArtifacts({ versionDir, version, baseUrl, pubkey, channel = 'staging' }) {
  const problems = [];
  const name = installerName(version);
  const exePath = path.join(versionDir, name);
  const sigPath = `${exePath}.sig`;
  const manifestPath = path.join(versionDir, 'latest.json');
  for (const file of [exePath, sigPath, manifestPath]) {
    if (!existsSync(file)) problems.push(`파일이 없습니다: ${file}`);
  }
  if (problems.length) return { problems, files: [], manifest: null };

  const exe = readFileSync(exePath);
  const sigBytes = readFileSync(sigPath);
  const sig = sigBytes.toString('utf8').trim();
  const manifestBytes = readFileSync(manifestPath);
  if (exe.subarray(0, 2).toString('latin1') !== 'MZ') problems.push('설치 파일이 실행 파일 형식이 아닙니다.');

  const checked = verifySignature(exe, sig, pubkey);
  if (!checked.ok) problems.push(`서명 확인 실패: ${checked.reason}`);
  else if (!checked.signedVersion) problems.push('서명에 버전이 없습니다 — 앱(requireSignedVersion)이 설치를 거부합니다.');
  else if (checked.signedVersion !== version) problems.push(`서명된 버전 ${checked.signedVersion} ≠ ${version}`);

  let manifest = null;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    problems.push('latest.json 이 JSON 이 아닙니다.');
  }
  if (manifest) {
    const target = manifest.platforms?.['windows-x86_64'];
    const expectedUrl = `${baseUrl}/${channel}/${version}/${encodeURIComponent(name)}`;
    if (manifest.version !== version) problems.push(`latest.json version ${manifest.version} ≠ ${version}`);
    if (manifest.channel !== channel) problems.push(`latest.json channel '${manifest.channel}' ≠ ${channel}`);
    if (!String(manifest.notes ?? '').trim()) problems.push('latest.json 에 릴리스 노트가 없습니다.');
    if (String(manifest.notes ?? '').includes(NOTES_DRAFT_MARK)) problems.push('릴리스 노트가 아직 초안입니다.');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(manifest.pub_date ?? '')) problems.push('latest.json pub_date 형식이 RFC 3339 가 아닙니다.');
    if (target?.url !== expectedUrl) problems.push(`latest.json url 이 다릅니다: ${target?.url} (기대: ${expectedUrl})`);
    if (target?.signature !== sig) problems.push('latest.json signature 가 .sig 파일과 다릅니다.');
  }
  const describe = (file, bytes) => ({ name: path.basename(file), path: file, size: bytes.length, sha256: sha256(bytes) });
  return {
    problems,
    manifest,
    manifestFile: describe(manifestPath, manifestBytes),
    files: [describe(exePath, exe), describe(sigPath, sigBytes)],
  };
}

export const recordPath = versionDir => path.join(versionDir, 'release-record.json');

export function readRecord(versionDir) {
  const file = recordPath(versionDir);
  return existsSync(file) && statSync(file).isFile() ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** release-staging 이 검증하며 남긴 해시와 지금 파일이 같은지(빌드 뒤 바뀌지 않았는지). */
export function compareWithRecord(record, inspected) {
  if (!record) return ['검증 기록(release-record.json)이 없습니다 — npm run release:staging 으로 만든 빌드만 게시합니다.'];
  const recorded = new Map(record.files.map(f => [f.name, f.sha256]));
  return [...inspected.files, inspected.manifestFile].filter(file => recorded.get(file.name) !== file.sha256).map(file => `${file.name} 이 검증 뒤 바뀌었습니다.`);
}

// ── 실패 시 되돌리기 ───────────────────────────────────────────────────
// 빌드가 끝나기 전에는 버전 파일·산출물을 중간 상태로 남기지 않는다. 사본과 기록을 먼저 남기므로
// 프로세스가 강제 종료되어도(메모리 부족 등) 다음 실행이 되돌릴 수 있다.
const journalPath = dir => path.join(dir, 'journal.json');

export function beginTransaction({ dir, files = [], folders = [], meta = {} }) {
  rmSync(dir, { recursive: true, force: true }); // 기록(journal)이 없는 조각은 시작하다 끊긴 것이다
  mkdirSync(dir, { recursive: true });
  const fileEntries = files.map((file, i) => {
    const backup = existsSync(file) ? `file-${i}` : null;
    if (backup) copyFileSync(file, path.join(dir, backup));
    return { file, backup };
  });
  const folderEntries = folders.map((folder, i) => ({ folder, backup: existsSync(folder) ? `folder-${i}` : null }));
  const journalText = JSON.stringify({ ...meta, pid: process.pid, files: fileEntries, folders: folderEntries }, null, 2);
  writeFileSync(`${journalPath(dir)}.tmp`, journalText);
  renameSync(`${journalPath(dir)}.tmp`, journalPath(dir));
  for (const { folder, backup } of folderEntries) {
    if (backup) renameSync(folder, path.join(dir, backup));
  }
}

export function readTransaction(dir) {
  return existsSync(journalPath(dir)) ? JSON.parse(readFileSync(journalPath(dir), 'utf8')) : null;
}

/** 시작 전 상태로 되돌린다. 중간에 끊겨 다시 실행해도 결과가 같다. 되돌린 기록을 돌려준다(없으면 null). */
export function rollbackTransaction(dir) {
  const journal = readTransaction(dir);
  if (!journal) return null;
  for (const { file, backup } of journal.files) {
    if (backup) copyFileSync(path.join(dir, backup), file);
    else rmSync(file, { force: true });
  }
  for (const { folder, backup } of journal.folders) {
    const saved = backup ? path.join(dir, backup) : null;
    if (saved && existsSync(saved)) {
      rmSync(folder, { recursive: true, force: true });
      renameSync(saved, folder);
    } else if (!saved) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
  rmSync(dir, { recursive: true, force: true });
  return journal;
}

export const commitTransaction = dir => rmSync(dir, { recursive: true, force: true });

// ── 서버 확인 ──────────────────────────────────────────────────────────
const looksLikeHtml = ({ type, text }) => /text\/html/i.test(type) || /^\s*<(!doctype|html)/i.test(text);

/** 서버에 임시로 두는 확인 파일의 내용(docs/release.md §4-2). */
export const SERVER_PROBE = 'plan-a-memo-update-probe';

/**
 * 업데이트 경로가 정적 파일을 제대로 내주는지(읽기만). 문제 목록과 게시 상태를 돌려준다.
 * 없는 파일 → 404(본문 형식은 보지 않는다 — Nginx 기본 404 는 HTML 이다) · latest.json → 404 또는 이 채널의 JSON ·
 * (probe) 확인 파일 → 200 · JSON Content-Type · 약속한 본문. 웹 화면 HTML 을 200 으로 주는 SPA fallback 은 실패다.
 */
export async function checkUpdateServer(baseUrl, { fetchImpl = fetch, channel = 'staging', probe = false } = {}) {
  const problems = [];
  const get = async url => {
    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, redirect: 'manual' });
      return { url, status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() };
    } catch (error) {
      return { url, error: error.cause?.code || error.message };
    }
  };
  const missing = await get(`${baseUrl}/${channel}/not-a-file-${Date.now()}.json`);
  if (missing.error) {
    problems.push(`${baseUrl} 에 연결하지 못했습니다(${missing.error}).`);
    return { problems, published: { state: 'unreachable', detail: missing.error } };
  }
  if (missing.status === 200 && looksLikeHtml(missing)) problems.push('없는 파일에 웹 화면 HTML 이 HTTP 200 으로 옵니다(SPA fallback) — 404 여야 합니다. scripts/server/memo-updates.nginx.conf 가 적용되지 않았습니다.');
  else if (missing.status !== 404) problems.push(`없는 파일에 HTTP ${missing.status} (${missing.type || '형식 불명'}) — 404 여야 합니다. scripts/server/memo-updates.nginx.conf 가 적용되지 않았습니다.`);

  const published = await readPublished(baseUrl, fetchImpl, channel);
  if (published.state === 'not-configured') problems.push(`latest.json 이 업데이트 정보가 아닙니다(${published.detail}).`);
  if (published.state === 'unreachable') problems.push(`latest.json 을 읽지 못했습니다(${published.detail}).`);
  if (published.state === 'published' && published.manifest?.channel !== channel) problems.push(`게시된 latest.json 의 channel 이 '${published.manifest?.channel}' 입니다(기대: ${channel}).`);

  if (probe) {
    const file = await get(`${baseUrl}/${channel}/probe.json`);
    if (file.error || file.status !== 200) problems.push(`확인 파일 probe.json → ${file.error ?? `HTTP ${file.status}`} (200 이어야 합니다).`);
    else if (!/application\/json/i.test(file.type)) problems.push(`확인 파일의 Content-Type 이 JSON 이 아닙니다(${file.type || '형식 불명'}). 파일 위치와 root 를 확인해주세요.`);
    else if (!isProbeBody(file.text)) problems.push(`확인 파일의 본문이 {"probe":"${SERVER_PROBE}"} 가 아닙니다. 파일 내용을 확인해주세요.`);
  }
  return { problems, published };
}

function isProbeBody(text) {
  try {
    return JSON.parse(text)?.probe === SERVER_PROBE;
  } catch {
    return false;
  }
}

// ── 게시 ───────────────────────────────────────────────────────────────
/** 서버의 latest.json 상태. SPA fallback(HTML 200)을 '게시본 없음' 으로 착각하지 않는다. */
export async function readPublished(baseUrl, fetchImpl = fetch, channel = 'staging') {
  const url = `${baseUrl}/${channel}/latest.json`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  } catch (error) {
    return { state: 'unreachable', detail: error.cause?.code || error.message };
  }
  if (res.status === 404) return { state: 'none' };
  if (!res.ok) return { state: 'unreachable', detail: `HTTP ${res.status}` };
  const text = await res.text();
  try {
    const manifest = JSON.parse(text);
    return { state: 'published', manifest, version: manifest.version, bytes: Buffer.from(text, 'utf8') };
  } catch {
    return { state: 'not-configured', detail: `${res.headers.get('content-type') ?? '형식 불명'} — JSON 이 아닙니다` };
  }
}

async function downloadHash(fetchImpl, url) {
  const res = await fetchImpl(url);
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const bytes = Buffer.from(await res.arrayBuffer());
  return { hash: sha256(bytes), size: bytes.length, contentType: res.headers.get('content-type') };
}

/**
 * 게시 순서: 설치 파일·서명 → HTTP 로 내려받아 해시 비교 → 마지막에 latest.json → 다시 확인.
 * 앞 단계가 하나라도 실패하면 latest.json 을 건드리지 않는다(앱은 계속 이전 버전을 본다).
 * transport: { uploadVersion(version, files), uploadManifest(file) } — 실제 구현은 publish-staging.mjs(SSH).
 */
export async function publishRelease({ version, baseUrl, files, manifestFile, transport, fetchImpl = fetch, log = () => {}, channel = 'staging' }) {
  const published = await readPublished(baseUrl, fetchImpl, channel);
  if (published.state === 'unreachable') throw new Error(`업데이트 주소에 연결하지 못했습니다(${published.detail}).`);
  if (published.state === 'not-configured') {
    throw new Error(`${baseUrl}/${channel}/latest.json 이 업데이트 정보가 아닙니다(${published.detail}). 서버에 scripts/server/memo-updates.nginx.conf 를 먼저 적용해야 합니다.`);
  }
  const manifestBytes = readFileSync(manifestFile.path);
  if (published.state === 'published') {
    const order = compareVersions(version, published.version);
    if (order === 0 && published.bytes.equals(manifestBytes)) return { status: 'already-published', previous: published.version };
    if (order <= 0) throw new Error(`게시된 v${published.version} 보다 높은 버전만 게시합니다(이번 v${version}).`);
  }

  const urlOf = name => `${baseUrl}/${channel}/${version}/${encodeURIComponent(name)}`;
  const existing = await Promise.all(files.map(file => downloadHash(fetchImpl, urlOf(file.name))));
  const present = existing.filter(item => item.hash);
  if (present.length && existing.some((item, i) => item.hash !== files[i].sha256)) {
    throw new Error(`v${version} 폴더에 이미 다른 파일이 있습니다. 같은 버전 번호로 다른 내용을 올리지 않습니다 — 새 버전으로 다시 빌드해주세요.`);
  }
  if (present.length === files.length) {
    log(`v${version} 파일은 이미 올라가 있어 건너뜁니다(해시 같음).`);
  } else {
    log('설치 파일·서명 올리는 중…');
    await transport.uploadVersion(version, files);
  }

  log('올린 파일을 HTTP 로 내려받아 확인하는 중…');
  for (const file of files) {
    const got = await downloadHash(fetchImpl, urlOf(file.name));
    if (got.error) throw new Error(`${file.name} 을 내려받지 못했습니다(${got.error}). latest.json 은 올리지 않았습니다.`);
    if (got.hash !== file.sha256) throw new Error(`${file.name} 해시가 다릅니다. latest.json 은 올리지 않았습니다.`);
  }

  log('latest.json 올리는 중(마지막 단계)…');
  await transport.uploadManifest(manifestFile);
  const after = await readPublished(baseUrl, fetchImpl, channel);
  if (after.state !== 'published' || !after.bytes.equals(manifestBytes)) {
    throw new Error(`올린 뒤 latest.json 이 로컬 파일과 다릅니다(${after.state}). 캐시 또는 서버 설정을 확인하고, 필요하면 latest.previous.json 으로 되돌리세요.`);
  }
  return { status: 'published', previous: published.version ?? null };
}

/**
 * 셸 명령으로 올리는 transport — 다 올린 뒤 폴더를 한 번에 옮겨, 반쯤 올라간 버전 폴더가 보이지 않게 한다.
 * remote(command): 서버에서 sh 명령 실행 · copy(names, destination): 파일을 서버로 복사(실제 구현은 publish-staging.mjs 의 ssh·scp).
 */
export function shellTransport({ remoteDir, remote, copy, channel = 'staging' }) {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(remoteDir)) throw new Error(`remoteDir 형식이 올바르지 않습니다: ${remoteDir}`);
  const dir = `${remoteDir}/${channel}`;
  return {
    uploadVersion(version, files) {
      const incoming = `${dir}/.incoming-${version}`;
      remote(`set -e; test -w '${dir}'; rm -rf '${incoming}'; mkdir '${incoming}'`);
      copy(files.map(file => file.name), `${incoming}/`);
      // 같은 버전 폴더가 이미 있으면 덮어쓰지 않는다.
      remote(`set -e; test ! -e '${dir}/${version}'; chmod -R a+rX '${incoming}'; mv '${incoming}' '${dir}/${version}'`);
    },
    uploadManifest() {
      const incoming = `${dir}/.incoming-latest.json`;
      copy(['latest.json'], incoming);
      remote(`set -e; chmod a+r '${incoming}'; if [ -e '${dir}/latest.json' ]; then cp -p '${dir}/latest.json' '${dir}/latest.previous.json'; fi; mv -f '${incoming}' '${dir}/latest.json'`);
    },
  };
}

// ── 업데이트 전후 데이터 비교 ───────────────────────────────────────────
/** 보내면 줄어드는 대기열·정리용 표 — 개수가 줄어도 데이터 손실이 아니다. */
const TRANSIENT_TABLES = new Set(['sync_outbox', 'management_outbox', 'purged_attachments', 'reminder_toasts', 'carryover_prompts', 'conflicts', 'conflicts_v2', 'sync_state']);

/**
 * 업데이트 전 스냅숏과 지금을 비교한다. 내용은 보지 않고 개수·파일 해시만.
 * @returns {{ problems: string[], notes: string[] }}
 */
export function compareDataSnapshots(before, after) {
  const problems = [];
  const notes = [];
  if (before.storageRoot !== after.storageRoot) problems.push(`저장 위치가 바뀌었습니다: ${before.storageRoot} → ${after.storageRoot}`);
  if (after.integrity !== 'ok') problems.push(`SQLite 무결성 검사 실패: ${after.integrity}`);
  for (const [table, count] of Object.entries(before.tables)) {
    const now = after.tables[table];
    if (now === undefined) problems.push(`표 ${table} 이 없어졌습니다.`);
    else if (now < count && TRANSIENT_TABLES.has(table)) notes.push(`${table}: ${count} → ${now}(대기열 — 처리되면 줄어듭니다)`);
    else if (now < count) problems.push(`${table}: ${count} → ${now} 줄었습니다.`);
    else if (now > count) notes.push(`${table}: ${count} → ${now}`);
  }
  for (const [file, hash] of Object.entries(before.attachments)) {
    if (!(file in after.attachments)) problems.push(`이미지 파일이 없어졌습니다: ${file}`);
    else if (after.attachments[file] !== hash) problems.push(`이미지 파일 내용이 바뀌었습니다: ${file}`);
  }
  const newBackups = after.backups.filter(name => !before.backups.includes(name));
  const lostBackups = before.backups.filter(name => !after.backups.includes(name));
  if (!newBackups.some(name => name.includes('pre-update'))) problems.push('이번 업데이트의 pre-update Backup 이 없습니다.');
  if (lostBackups.length) notes.push(`오래된 Backup 정리: ${lostBackups.length}개(보관 개수 규칙)`);
  notes.push(`새 Backup: ${newBackups.join(', ') || '없음'}`);
  return { problems, notes };
}
