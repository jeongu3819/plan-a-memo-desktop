// 실제 Staging 재연결 시험 공용 — 이미 떠 있는 격리 앱에 CDP 로 붙는다. 토큰·쿠키는 출력하지 않는다.
// 절차: e2e/README.md '실제 Staging 재연결 시험 재개'
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright-core');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// 저장소 밖 — 시험 저장소·Chrome 프로필(로그인 정보)이 저장소에 섞이지 않게
export const RUN = process.env.PLANA_STAGING_RUN ?? path.join(os.tmpdir(), 'plana-staging-run');
export const CONFIG = path.join(RUN, 'config');
export const STORE = path.join(RUN, 'store');
export const CHROME_PROFILE = path.join(RUN, 'chrome');
export const PORT = 9333;
export const ORIGIN = 'https://staging.planawork.com';
export const EXE = path.join(repoRoot, 'src-tauri', 'target', 'debug', 'PLAN-A Memo.exe');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET = /pms_[A-Za-z0-9_-]+|"(access_?token|token|code|verifier|cookie)"\s*:\s*"[^"]*"/gi;
export const redact = (v) => JSON.stringify(v, null, 1).replace(SECRET, '"<redacted>"');

export async function connect({ guard = true } = {}) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = browser.contexts()[0].pages()[0];
  const invoke = (c, a = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [c, a]);
  if (guard) {
    const info = await invoke('app_info');
    const auth = await invoke('auth_status');
    // 잘못된 앱·서버·저장 위치면 아무것도 하지 않는다
    if (info.env !== 'development' || auth.webOrigin !== ORIGIN) throw new Error(`격리 앱이 아닙니다: env=${info.env} origin=${auth.webOrigin}`);
    if (info.storage.path && !path.resolve(info.storage.path).startsWith(path.resolve(STORE))) throw new Error(`시험 폴더가 아닙니다: ${info.storage.path}`);
  }
  return { browser, page, invoke };
}
