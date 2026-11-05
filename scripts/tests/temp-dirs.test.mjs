// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STALE_AFTER_MS, createTempDirs, recoverStaleTempDirs } from './temp-dirs.mjs';

const sandbox = createTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  sandbox.cleanup();
});
const later = () => Date.now() + STALE_AFTER_MS + 60_000;

describe('테스트 임시 폴더', () => {
  it('cleanup 은 만든 폴더만 내용까지 지운다', () => {
    const root = sandbox.make('root');
    const other = path.join(root, 'other');
    mkdirSync(other);
    const temp = createTempDirs({ root });
    const dir = temp.make('art');
    expect(path.basename(dir)).toMatch(new RegExp(`^plana-test-art-${process.pid}-[A-Za-z0-9]{6}$`));
    writeFileSync(path.join(dir, 'file.txt'), 'x');
    expect(temp.cleanup()).toEqual([]);
    expect(readdirSync(root)).toEqual(['other']);
  });

  it('지우지 못하면 경로와 이유를 남기고, 다음 cleanup 에서 다시 시도한다', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = sandbox.make('root');
    const locked = () => {
      throw new Error('EBUSY');
    };
    const attempts = [locked];
    const temp = createTempDirs({ root, rm: (...args) => attempts.shift()?.(...args) });
    const dir = temp.make('art');
    expect(temp.cleanup()).toEqual([{ dir, reason: 'EBUSY' }]);
    expect(warn.mock.calls[0][0]).toContain(dir);
    expect(temp.cleanup()).toEqual([]);
    expect(temp.cleanup()).toEqual([]);
  });
});

describe('강제 종료 뒤 정리', () => {
  const dead = () => false;

  it('이름이 맞고 프로세스가 끝났고 오래된 폴더만 지운다', () => {
    const root = sandbox.make('root');
    const stale = path.join(root, 'plana-test-art-999999-aBc123');
    const keep = [
      'plana-art-aBc123',
      'plana-sign-aBc123',
      '.tmpaBc123',
      'PLAN-A Memo Staging-0.2.6-updater-aBc123',
      'personal-memo-browser-aBc123',
      'plana-test-art-999999-short',
      'plana-test-art-notpid-aBc123',
      'x-plana-test-art-999999-aBc123',
    ];
    for (const name of [path.basename(stale), ...keep]) mkdirSync(path.join(root, name));
    writeFileSync(path.join(root, 'plana-test-art-999999-file00'), '폴더가 아닌 파일');
    expect(recoverStaleTempDirs({ root, now: later(), running: dead })).toEqual({ removed: [stale], failed: [] });
    expect(readdirSync(root).sort()).toEqual([...keep, 'plana-test-art-999999-file00'].sort());
  });

  it('실행 중인 프로세스의 폴더와 최근 폴더는 지우지 않는다', () => {
    const root = sandbox.make('root');
    const dir = path.join(root, 'plana-test-art-999999-aBc123');
    mkdirSync(dir);
    expect(recoverStaleTempDirs({ root, now: later(), running: () => true }).removed).toEqual([]);
    expect(recoverStaleTempDirs({ root, running: dead }).removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('지우지 못해도 멈추지 않고 경로와 이유를 돌려준다', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = sandbox.make('root');
    const dir = path.join(root, 'plana-test-art-999999-aBc123');
    mkdirSync(dir);
    const rm = () => {
      throw new Error('EPERM');
    };
    expect(recoverStaleTempDirs({ root, now: later(), running: dead, rm })).toEqual({ removed: [], failed: [{ dir, reason: 'EPERM' }] });
  });

  it('실제로 강제 종료된 프로세스의 폴더를 다음 실행이 치운다', () => {
    const root = sandbox.make('root');
    const helper = pathToFileURL(path.resolve('scripts/tests/temp-dirs.mjs')).href;
    const script = `
      import { writeFileSync } from 'node:fs';
      import path from 'node:path';
      import { createTempDirs } from ${JSON.stringify(helper)};
      const dir = createTempDirs({ root: process.argv[1] }).make('crash');
      writeFileSync(path.join(dir, 'file.txt'), 'x');
      process.kill(process.pid, 'SIGKILL');
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, root]);
    expect(child.status).not.toBe(0);
    const [left] = readdirSync(root);
    expect(left).toMatch(new RegExp(`^plana-test-crash-${child.pid}-`));
    expect(recoverStaleTempDirs({ root }).removed).toEqual([]);
    expect(recoverStaleTempDirs({ root, now: later() }).removed).toEqual([path.join(root, left)]);
    expect(readdirSync(root)).toEqual([]);
  });

  it('기본 위치는 %TEMP% 이다', () => {
    const dir = sandbox.make('where');
    expect(path.dirname(dir)).toBe(tmpdir());
  });
});
