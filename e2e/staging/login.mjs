// 승인 주소를 격리 Chrome 으로 연다. 로그인·동의는 사람이 한다. 주소는 출력하지 않는다.
import { spawn } from 'node:child_process';
import { connect, CHROME_PROFILE, ORIGIN } from './lib.mjs';

const { browser, invoke } = await connect();
const start = await invoke('auth_login_begin', {});
if (!start.authorizeUrl?.startsWith(`${ORIGIN}/`)) throw new Error('예상한 서버 주소가 아닙니다');
await browser.close();
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
spawn(chrome, [`--user-data-dir=${CHROME_PROFILE}`, '--no-first-run', '--no-default-browser-check', start.authorizeUrl], { detached: true, stdio: 'ignore' }).unref();
console.log('mode', start.mode, 'expiresIn', start.expiresIn);
