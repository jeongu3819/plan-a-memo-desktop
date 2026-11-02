// 게시한 업데이트 확인 — 앱이 보는 것과 같은 주소에서 latest.json·업데이트 파일을 읽어 dist 결과와 맞는지 본다.
//
//   npm run release:verify:staging       (= node scripts/verify-update.mjs staging)
//   npm run release:verify:production
//
// 필요한 값: PLANA_UPDATE_BASE_URL(빌드 때와 같은 값 — staging 은 scripts/release.staging.json 이 기본값). release/<채널>/ 에 dist 결과가 있으면 그것과 비교한다.
// 확인하는 것
//   1. <BASE>/<채널>/latest.json — 내려받기 가능, channel 이 이 채널, version·signature 가 dist 결과와 같음
//   2. latest.json 의 url — <BASE>/<채널>/<버전>/ 아래, 내려받기 가능, 내용(sha256)이 dist 결과 파일과 같음
// 아무것도 올리거나 바꾸지 않는다(읽기만).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStagingConfig, sha256 } from './lib/release-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const channel = process.argv[2];
const problems = [];
const info = message => console.log(`• ${message}`);
const problem = message => {
  problems.push(message);
  console.error(`✖ ${message}`);
};

if (!['staging', 'production'].includes(channel)) {
  console.error('\n✖ 채널을 정해주세요: npm run release:verify:staging  또는  npm run release:verify:production\n');
  process.exit(1);
}
const baseUrl = (process.env.PLANA_UPDATE_BASE_URL || (channel === 'staging' ? loadStagingConfig(root).baseUrl : '')).replace(/\/+$/, '');
if (!baseUrl) {
  console.error('\n✖ PLANA_UPDATE_BASE_URL 이 없습니다(빌드 때와 같은 값).\n');
  process.exit(1);
}

const outDir = path.join(root, 'release', channel);
const localManifestPath = path.join(outDir, 'latest.json');
const local = existsSync(localManifestPath) ? JSON.parse(readFileSync(localManifestPath, 'utf8')) : null;
if (!local) info(`release/${channel}/latest.json 이 없어 게시본만 확인합니다.`);

// 1. latest.json — 캐시를 피하는 query 없이(앱이 요청하는 주소 그대로)
const manifestUrl = `${baseUrl}/${channel}/latest.json`;
let remote = null;
try {
  const res = await fetch(manifestUrl, { headers: { Accept: 'application/json' } });
  if (!res.ok) problem(`${manifestUrl} → HTTP ${res.status}`);
  else {
    const text = await res.text();
    try {
      remote = JSON.parse(text);
    } catch {
      problem(`${manifestUrl} 이 JSON 이 아닙니다(${res.headers.get('content-type')}) — 웹 화면 HTML 이 돌아오면 서버 설정이 빠진 것입니다(scripts/server/memo-updates.nginx.conf).`);
    }
  }
} catch (error) {
  problem(`${manifestUrl} 을 읽지 못했습니다(${error.cause?.code || error.message})`);
}

if (remote) {
  info(`게시된 latest.json: version ${remote.version} · channel ${remote.channel} · pub_date ${remote.pub_date}`);
  const target = remote.platforms?.['windows-x86_64'];
  if (remote.channel !== channel) problem(`channel 이 '${remote.channel}' 입니다(기대: ${channel}) — 앱이 설치를 거부합니다.`);
  if (!target?.url || !target?.signature) problem('platforms.windows-x86_64 의 url·signature 가 없습니다.');
  if (local) {
    if (remote.version !== local.version) problem(`게시본 version ${remote.version} ≠ dist 결과 ${local.version} (CDN 캐시 또는 업로드 누락)`);
    if (target?.signature !== local.platforms?.['windows-x86_64']?.signature) problem('게시본 signature 가 dist 결과와 다릅니다.');
  }

  // 2. 업데이트 파일
  if (target?.url) {
    const expectedPrefix = `${baseUrl}/${channel}/${remote.version}/`;
    if (!target.url.startsWith(expectedPrefix)) problem(`url 이 ${expectedPrefix} 아래가 아닙니다: ${target.url}`);
    try {
      const res = await fetch(target.url);
      if (!res.ok) problem(`업데이트 파일 → HTTP ${res.status} (latest.json 보다 먼저 올려야 합니다)`);
      else {
        const bytes = Buffer.from(await res.arrayBuffer());
        const hash = sha256(bytes);
        info(`업데이트 파일: HTTP ${res.status} · ${bytes.length} bytes · sha256 ${hash}`);
        const localFile = path.join(outDir, remote.version, decodeURIComponent(target.url.split('/').pop()));
        if (existsSync(localFile) && sha256(readFileSync(localFile)) !== hash) problem('업데이트 파일 내용이 dist 결과와 다릅니다 — 다른 파일이 올라가 있습니다.');
      }
    } catch (error) {
      problem(`업데이트 파일을 확인하지 못했습니다(${error.cause?.code || error.message})`);
    }
  }
}

if (problems.length) {
  console.error(`\n✖ ${problems.length}개 문제 — 고친 뒤 다시 확인하세요. 급하면 latest.json 을 이전 내용으로 되돌립니다(docs/release.md).\n`);
  process.exit(1);
}
console.log(`\n✔ ${channel} 업데이트 게시 확인 완료 — 이전 ${channel} 버전 앱의 [업데이트 확인]에서 ${remote.version} 이 보여야 합니다.\n`);
