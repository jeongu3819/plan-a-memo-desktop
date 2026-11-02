// Staging 업데이트 서버 확인(읽기만) — v0.2.4 서명 빌드 전에 이 경로가 정적 파일을 제대로 내주는지 본다.
//
//   npm run release:check-server              없는 파일 → 404(웹 화면 HTML 200 이면 실패) · latest.json → 404 또는 staging JSON
//   npm run release:check-server -- --probe   서버에 임시로 둔 staging/probe.json 이 200 · JSON · 약속한 본문으로 오는지(docs/release.md §4-2)
//
// PLANA_UPDATE_BASE_URL 로 다른 주소를 확인할 수 있다.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUpdateServer, loadStagingConfig } from './lib/release-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = (process.env.PLANA_UPDATE_BASE_URL || loadStagingConfig(root).baseUrl).replace(/\/+$/, '');
const probe = process.argv.includes('--probe');

const { problems, published } = await checkUpdateServer(baseUrl, { probe });
if (problems.length) {
  console.error(`\n✖ ${baseUrl} — 업데이트 서버가 준비되지 않았습니다.\n  - ${problems.join('\n  - ')}\n`);
  process.exit(1);
}
const state = published.state === 'published' ? `게시된 버전 v${published.version}` : '게시된 버전 없음(첫 게시 전)';
console.log(`\n✔ ${baseUrl} — 없는 파일은 404${probe ? ' · 확인 파일은 200 JSON' : ''} · ${state}\n`);
