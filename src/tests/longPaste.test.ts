/**
 * 긴 문서 붙여넣기 — 편집기 붙여넣기 경로(서식 HTML 정규화 → sanitizer)와 저장 직렬화(emit)가 글자를 잃지 않는지.
 * 실제 앱·클립보드·SQLite 확인은 e2e/long-paste.mjs.
 */
import { describe, expect, it } from 'vitest';
import {
  extractImagePlaceholders,
  normalizeOfficePasteHtml,
  restoreImagePlaceholders,
} from '../vendor/plan-a-work/utils/officePaste';
import { sanitizeTaskDescriptionHtml } from '../vendor/plan-a-work/utils/taskDescription';
import { serializeRichHtml } from '../vendor/plan-a-work/utils/richImage';
import { linkifyPlainText } from '../vendor/plan-a-work/utils/richLink';

const END = '[END-OF-MEMO-PASTE-TEST-12345]';
// \s 는 NBSP 를 포함한다. 폭 없는 공백(U+200B)만 따로 더한다.
const WHITESPACE_RE = new RegExp(`[\\s${String.fromCharCode(0x200b)}]+`, 'g');
const signature = (text: string) => text.replace(WHITESPACE_RE, '');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function sourceLines(count: number): string[] {
  const kinds = [
    (i: number) => `${i}번째 문단. 오늘 회의에서 논의한 내용은 일정 조정, 예산 검토입니다.`,
    (i: number) => `Line ${i}: 한글 English 12345 !@#$%^&*()_+-=[]{};':",./<>? ✅🚀👍🏽 👨‍👩‍👧‍👦 🇰🇷 家族 é ₩€`,
    (i: number) => `https://example.com/docs/${i}/very/long/path?query=${'abc'.repeat(40)}&n=${i}#s${i}`,
    (i: number) => `- [ ] 체크리스트 ${i} · ${i}. 번호 · | 표 | 형태 | ${i} |`,
  ];
  const lines = ['[FIRST] 첫 문장입니다.'];
  for (let i = 1; i <= count; i += 1) {
    if (i === Math.floor(count / 2)) lines.push('[MID] 중간 검증 문장입니다.');
    lines.push(kinds[i % kinds.length](i));
  }
  lines.push(`마지막 검증 문장입니다. ${END}`);
  return lines;
}

/** Word·웹 문서에서 복사한 것 같은 서식 HTML(문단·제목·목록·표·코드·색·굵게·링크·빈 문단). */
function richHtml(lines: string[]): string {
  const out: string[] = ['<meta charset="utf-8"><style>p{margin:0}</style>'];
  lines.forEach((line, i) => {
    const t = esc(line);
    switch (i % 9) {
      case 1: out.push(`<h2 style="font-size:18pt">${t}</h2>`); break;
      case 2: out.push(`<ul><li><span style="color:#c00;font-weight:bold">${t}</span></li></ul>`); break;
      case 3: out.push(`<ol><li><p class="MsoListParagraph"><b>${t}</b></p></li></ol>`); break;
      case 4: out.push(`<table><tbody><tr><td>${t}</td></tr></tbody></table>`); break;
      case 5: out.push(`<pre><code>${t}</code></pre>`); break;
      case 6: out.push(`<p><a href="https://example.com/${i}">${t}</a></p><p><br></p>`); break;
      case 7: out.push(`<div><font face="Malgun Gothic"><i>${t}</i></font></div>`); break;
      default: out.push(`<p class="MsoNormal" style="margin:0cm"><span lang="KO">${t}</span></p>`);
    }
  });
  return out.join('\n');
}

/** RichDescriptionEditor.prepareDocumentPaste 와 같은 순서. */
function pastePipeline(html: string): string {
  const result = normalizeOfficePasteHtml(html);
  expect(result.limitExceeded ?? null).toBeNull();
  const extracted = extractImagePlaceholders(result.html);
  const sanitized = sanitizeTaskDescriptionHtml(extracted.html);
  return restoreImagePlaceholders(sanitized.html, extracted.refs, new Set(), 'about:blank');
}

/** 편집기 안의 DOM → 저장 HTML(RichDescriptionEditor.emit 과 같은 경로). */
function emitFrom(innerHtml: string): string {
  const el = document.createElement('div');
  el.innerHTML = innerHtml;
  return sanitizeTaskDescriptionHtml(serializeRichHtml(el)).html;
}

const textOf = (html: string) => {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el.textContent || '';
};

describe('긴 문서 붙여넣기 — 글자 보존', () => {
  it('서식 있는 장문(수천 줄) HTML 붙여넣기 → 저장 HTML 에 첫·중간·마지막과 모든 글자가 남는다', () => {
    const lines = sourceLines(3000);
    const pasted = pastePipeline(richHtml(lines));
    const stored = emitFrom(pasted);
    const text = textOf(stored);
    expect(text).toContain('[FIRST]');
    expect(text).toContain('[MID]');
    expect(text.trimEnd().endsWith(END)).toBe(true);
    expect(signature(text)).toBe(signature(lines.join('\n')));
    // 다시 열어(저장 HTML → 편집기) 저장해도 같은 HTML(정규화가 반복되며 줄어들지 않는다)
    expect(emitFrom(stored)).toBe(stored);
  }, 60_000); // jsdom 에서 3천 줄 정규화는 수 초 걸린다(실제 WebView 는 E2E 에서 측정)

  it('텍스트만 붙여넣기(링크 포함) — 줄바꿈과 모든 글자가 남는다', () => {
    const lines = sourceLines(2000);
    const html = linkifyPlainText(lines.join('\n'));
    const stored = emitFrom(html);
    const el = document.createElement('div');
    el.innerHTML = stored;
    el.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    const text = el.textContent || '';
    expect(text.split('\n').map(l => l.trim())).toEqual(lines.map(l => l.trim()));
    expect(stored).toContain('<a ');
  });

  it('줄바꿈 없는 아주 긴 한 줄(수십만 자)도 그대로', () => {
    const line = `[FIRST] ${'줄바꿈없는긴한줄 LongLine 0123456789 '.repeat(8000)}${END}`;
    const stored = emitFrom(esc(line));
    expect(textOf(stored)).toBe(line);
  });
});
