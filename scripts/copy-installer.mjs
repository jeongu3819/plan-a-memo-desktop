// Tauri NSIS 결과물(PLAN-A Memo_<버전>_x64-setup.exe)을 release/PLAN-A-Memo-Setup.exe 로 복사한다.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = join('src-tauri', 'target', 'release', 'bundle', 'nsis');
if (!existsSync(dir)) {
  console.error(`설치 파일 폴더가 없습니다: ${dir} (먼저 npm run tauri build)`);
  process.exit(1);
}
const setups = readdirSync(dir)
  .filter(name => name.endsWith('-setup.exe'))
  .map(name => ({ name, time: statSync(join(dir, name)).mtimeMs }))
  .sort((a, b) => b.time - a.time);
if (!setups.length) {
  console.error('NSIS 설치 파일을 찾지 못했습니다.');
  process.exit(1);
}
mkdirSync('release', { recursive: true });
const target = join('release', 'PLAN-A-Memo-Setup.exe');
copyFileSync(join(dir, setups[0].name), target);
console.log(`${setups[0].name} → ${target}`);
