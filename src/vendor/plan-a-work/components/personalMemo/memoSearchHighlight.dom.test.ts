// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { visibleText, visibleTextRanges } from './memoSearchHighlight';

function view(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('열린 메모 본문 강조 — 서식 경계를 넘는 단어', () => {
  it.each([
    'A<strong>W</strong>S 비용',
    '<span>A</span><span>WS</span> 비용',
    '<em>A</em><u>w</u><span data-text-size="20">s</span> 비용',
  ])('인라인 서식으로 나뉜 단어를 한 Range 로 잡는다: %s', html => {
    const ranges = visibleTextRanges(view(`<p>${html}</p>`), ['aws']);
    expect(ranges.map(range => range.toString().toLowerCase())).toEqual(['aws']);
  });

  it.each([
    '<p>A</p><p>WS</p>',
    '<table><tbody><tr><td>A</td><td>WS</td></tr></tbody></table>',
    '<p>A<br>WS</p>',
    '<ul><li>A</li><li>WS</li></ul>',
    '<p>A<img src="x">WS</p>',
  ])('문단·칸·줄·이미지 경계는 잇지 않는다: %s', html => {
    expect(visibleTextRanges(view(html), ['aws'])).toEqual([]);
    expect(visibleTextRanges(view(html), ['ws']).map(r => r.toString())).toEqual(['WS']);
  });

  it('본문 DOM 을 바꾸지 않는다', () => {
    const el = view('<p>A<strong>W</strong>S</p>');
    const before = el.innerHTML;
    visibleTextRanges(el, ['aws']);
    expect(el.innerHTML).toBe(before);
    expect(visibleText(el).text.trim()).toBe('AWS');
  });
});
