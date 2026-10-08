// PLAN-A Memo E2E harness — 실제 앱(exe)을 띄우고 WebView2 원격 디버깅(CDP)으로 화면·명령을 조작한다.
//
// * 앱: development debug 빌드(`npm run e2e:build`) — 서버 주소가 없으므로 **개발용 Mock 서버**를 쓴다.
//   PLANA_SERVER_ORIGIN 을 주면(예: http://127.0.0.1:8000) 같은 시나리오를 실제 PLAN-A Work Backend 로 돌릴 수 있다
//   (Mock 전용 단계는 건너뜀 — 실제 서버 E2E 는 브라우저 로그인 동의를 사람이 한다).
// * 격리: 앱 설정(PLANA_CONFIG_DIR)·저장 위치 모두 이번 실행의 임시 폴더. 사용자의 실제 설정·메모를 건드리지 않는다.
// * 재실행: 프로세스를 강제 종료(taskkill /F)했다가 다시 띄운다 — 강제 종료 후 복원·Outbox 유지 확인용.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..');
export const exePath = process.env.PLANA_E2E_EXE || path.join(repoRoot, 'src-tauri', 'target', 'debug', 'PLAN-A Memo.exe');
const PORT = Number(process.env.PLANA_E2E_CDP_PORT || 9333);

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class App {
  constructor() {
    this.workDir = mkdtempSync(path.join(tmpdir(), 'plana-e2e-'));
    this.configDir = path.join(this.workDir, 'config');
    this.storeDir = path.join(this.workDir, 'store');
    this.shotDir = path.join(repoRoot, 'e2e', 'output');
    mkdirSync(this.configDir, { recursive: true });
    mkdirSync(this.shotDir, { recursive: true });
    this.consoleErrors = [];
  }

  async start() {
    if (!existsSync(exePath)) throw new Error(`앱 실행 파일이 없습니다: ${exePath}\n먼저 npm run e2e:build`);
    this.proc = spawn(exePath, [], {
      env: {
        ...process.env,
        PLANA_CONFIG_DIR: this.configDir,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      },
      stdio: 'ignore',
      detached: false,
    });
    for (let i = 0; i < 120; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
        if (res.ok) break;
      } catch {
        /* 아직 */
      }
      await sleep(500);
    }
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    for (let i = 0; i < 40 && !this.page; i++) {
      this.page = this.browser.contexts()[0]?.pages()[0];
      if (!this.page) await sleep(250);
    }
    if (!this.page) throw new Error('WebView 페이지를 찾지 못했습니다');
    this.page.on('console', m => {
      if (m.type() === 'error') this.consoleErrors.push(m.text().slice(0, 300));
    });
    this.page.on('requestfailed', r => this.consoleErrors.push(`requestfailed ${r.url().slice(0, 120)} ${r.failure()?.errorText ?? ''}`));
    await this.page.waitForFunction(() => '__TAURI_INTERNALS__' in window, null, { timeout: 30000 });
    return this;
  }

  /** 강제 종료(정상 종료 절차 없이) */
  async kill() {
    try {
      await this.browser?.close();
    } catch {
      /* 연결이 이미 끊김 */
    }
    if (this.proc?.pid) {
      try {
        execFileSync('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* 이미 종료 */
      }
    }
    this.page = undefined;
    await sleep(1500);
  }

  async restart() {
    await this.kill();
    return this.start();
  }

  invoke(command, args = {}) {
    return this.page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
  }

  /** 실패를 기대하는 명령 — 앱 오류({code, message})를 그대로 돌려준다(성공하면 null). */
  invokeError(command, args = {}) {
    return this.page.evaluate(
      ([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a).then(() => null, error => error),
      [command, args],
    );
  }

  async shot(name) {
    await this.page.screenshot({ path: path.join(this.shotDir, `${name}.png`) });
  }

  cleanup() {
    if (!process.env.PLANA_E2E_KEEP) rmSync(this.workDir, { recursive: true, force: true });
  }
}

export const isMockRun = () => !process.env.PLANA_SERVER_ORIGIN;

/** E2E 전용 credential(Windows 자격 증명 관리자) 정리 — 평소 개발·운영 항목은 건드리지 않는다. */
export function clearE2eCredential() {
  // cmdkey 는 괄호·공백이 든 이름을 지우지 못하면서 성공 코드를 돌려준다 — Windows API(CredDeleteW)를 직접 부른다.
  const script =
    "Add-Type -Namespace PlanaE2e -Name Cred -MemberDefinition '[DllImport(\"advapi32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredDeleteW(string target, int type, int flags);';" +
    " [void][PlanaE2e.Cred]::CredDeleteW('memo-sync-v1-desktop-credential.PLAN-A Memo (development-e2e)', 1, 0)";
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
  } catch {
    /* 없음 */
  }
}
