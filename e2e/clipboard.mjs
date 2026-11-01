// Windows 클립보드(실제 OS 클립보드) 읽기·쓰기 — 긴 텍스트 붙여넣기 E2E 용.
//
// 메모장에서 복사한 것과 같은 형식(CF_UNICODETEXT)으로 넣는다. html 을 주면 Word/브라우저에서 복사한 것처럼
// CF_HTML("HTML Format", UTF-8 바이트) 도 함께 넣는다. 내용은 임시 파일로 넘긴다(명령줄 길이 제한 없음).
// 시작할 때 사용자의 클립보드 텍스트를 보관했다가 끝나면 되돌린다(backupClipboard / restoreClipboard).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'plana-clip-'));

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** CF_HTML 머리(바이트 오프셋은 UTF-8 기준). */
function cfHtml(fragment) {
  const pre = '<html><body>\r\n<!--StartFragment-->';
  const post = '<!--EndFragment-->\r\n</body></html>';
  const header = n =>
    `Version:0.9\r\nStartHTML:${String(n.sh).padStart(10, '0')}\r\nEndHTML:${String(n.eh).padStart(10, '0')}\r\n` +
    `StartFragment:${String(n.sf).padStart(10, '0')}\r\nEndFragment:${String(n.ef).padStart(10, '0')}\r\n`;
  const bytes = s => Buffer.byteLength(s, 'utf8');
  const sh = bytes(header({ sh: 0, eh: 0, sf: 0, ef: 0 }));
  const sf = sh + bytes(pre);
  const ef = sf + bytes(fragment);
  const eh = ef + bytes(post);
  return header({ sh, eh, sf, ef }) + pre + fragment + post;
}

export function setClipboard(text, html = null) {
  const textFile = path.join(dir, 'text.txt');
  writeFileSync(textFile, text, 'utf8');
  let htmlPart = '';
  if (html) {
    const htmlFile = path.join(dir, 'html.bin');
    writeFileSync(htmlFile, cfHtml(html), 'utf8');
    htmlPart =
      `$h = [System.IO.File]::ReadAllBytes('${htmlFile}'); ` +
      `$d.SetData('HTML Format', (New-Object System.IO.MemoryStream(,$h))); `;
  }
  ps(
    'Add-Type -AssemblyName System.Windows.Forms; ' +
      `$t = [System.IO.File]::ReadAllText('${textFile}', [System.Text.Encoding]::UTF8); ` +
      '$d = New-Object System.Windows.Forms.DataObject; ' +
      '$d.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $t); ' +
      htmlPart +
      '[System.Windows.Forms.Clipboard]::SetDataObject($d, $true, 10, 100)',
  );
}

/** 클립보드에 실제로 들어간 텍스트(되읽기). */
export function readClipboardText() {
  const out = path.join(dir, 'read.txt');
  ps(
    'Add-Type -AssemblyName System.Windows.Forms; ' +
      `[System.IO.File]::WriteAllText('${out}', [System.Windows.Forms.Clipboard]::GetText(), (New-Object System.Text.UTF8Encoding($false)))`,
  );
  return readFileSync(out, 'utf8');
}

let saved = null;

export function backupClipboard() {
  try {
    const out = path.join(dir, 'backup.txt');
    const has = ps(
      'Add-Type -AssemblyName System.Windows.Forms; ' +
        'if ([System.Windows.Forms.Clipboard]::ContainsText()) { ' +
        `[System.IO.File]::WriteAllText('${out}', [System.Windows.Forms.Clipboard]::GetText(), (New-Object System.Text.UTF8Encoding($false))); 'yes' } else { 'no' }`,
    ).trim();
    saved = has === 'yes' ? readFileSync(out, 'utf8') : null;
  } catch {
    saved = null;
  }
}

export function restoreClipboard() {
  try {
    if (saved !== null) setClipboard(saved);
    else ps('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()');
  } catch {
    /* 되돌리지 못해도 테스트 결과에는 영향 없음 */
  }
  rmSync(dir, { recursive: true, force: true });
}
