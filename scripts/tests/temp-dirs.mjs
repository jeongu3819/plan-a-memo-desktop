// 테스트 전용 임시 폴더 — 성공·실패와 상관없이 지우고, 강제 종료로 남은 것은 다음 실행이 치운다.
// 이 이름으로 만든 폴더만 지운다. %TEMP% 의 다른 폴더(plana-sign-*, .tmp* 등)는 건드리지 않는다.
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// plana-test-<종류>-<프로세스 번호>-<임의 6자> — Rust 테스트(src-tauri/tests/common)도 같은 이름을 쓴다.
const OWNED = /^plana-test-[a-z]+-(\d+)-[A-Za-z0-9]{6}$/;
export const STALE_AFTER_MS = 60 * 60 * 1000;

/** 지우지 못하면 경로와 이유를 남기고 넘어간다(Windows 파일 잠금은 몇 번 다시 시도한다). */
function removeOwned(dir, rm) {
  try {
    if (!OWNED.test(path.basename(dir))) throw new Error('테스트 임시 폴더 이름이 아닙니다');
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return null;
  } catch (error) {
    console.warn(`테스트 임시 폴더를 지우지 못했습니다: ${dir} — ${error.message}`);
    return { dir, reason: error.message };
  }
}

/** afterEach 에서 cleanup() 을 부른다. 지우지 못한 폴더는 기억해 두었다가 다음 cleanup 에서 다시 시도한다. */
export function createTempDirs({ root = tmpdir(), rm = rmSync } = {}) {
  let made = [];
  return {
    make(kind) {
      const dir = mkdtempSync(path.join(root, `plana-test-${kind}-${process.pid}-`));
      made.push(dir);
      return dir;
    },
    cleanup() {
      const failed = made.map(dir => removeOwned(dir, rm)).filter(Boolean);
      made = failed.map(f => f.dir);
      return failed;
    },
  };
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** 강제 종료로 남은 폴더 정리 — 이름이 맞고, 만든 프로세스가 끝났고, 한 시간 넘게 바뀌지 않은 폴더만. */
export function recoverStaleTempDirs({ root = tmpdir(), now = Date.now(), rm = rmSync, running = isRunning } = {}) {
  const removed = [];
  const failed = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const owned = entry.isDirectory() && OWNED.exec(entry.name);
    if (!owned || running(Number(owned[1]))) continue;
    const dir = path.join(root, entry.name);
    if (now - statSync(dir).mtimeMs < STALE_AFTER_MS) continue;
    const failure = removeOwned(dir, rm);
    if (failure) failed.push(failure);
    else removed.push(dir);
  }
  return { removed, failed };
}
