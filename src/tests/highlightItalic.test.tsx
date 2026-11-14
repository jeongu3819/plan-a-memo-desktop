/**
 * 배경색(형광펜) 적용·제거와 기울임꼴 정리 — 저장 계약(span background-color) · 붙여넣기 입구에서만 기울임 제거 ·
 * 저장된 메모는 다시 저장해도 HTML 그대로 · Ctrl+I 없음.
 * (실제 Chromium 편집 명령 결과는 Windows E2E e2e/highlight-italic.mjs 가 확인한다.)
 */
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RichTextContextMenu from '../vendor/plan-a-work/components/RichTextContextMenu';
import {
  HIGHLIGHT_COLORS,
  HIGHLIGHT_NONE,
  handleRichTextShortcut,
  selectionHighlightColor,
} from '../vendor/plan-a-work/utils/richTextFormatting';
import { sanitizeTaskDescriptionHtml } from '../vendor/plan-a-work/utils/taskDescription';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach(fn => fn());
  cleanup = [];
  window.getSelection()?.removeAllRanges();
});

function editor(html: string): HTMLDivElement {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  root.innerHTML = html;
  document.body.appendChild(root);
  cleanup.push(() => root.remove());
  return root;
}

function select(start: Node, startOffset: number, end: Node = start, endOffset: number = startOffset): Range {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return range;
}

const clean = (html: string, dropItalic = false) => sanitizeTaskDescriptionHtml(html, { dropItalic }).html;

describe('배경색 팔레트', () => {
  it('요청한 여섯 가지 옅은 색 — Web 과 같은 값(연보라만 추가)', () => {
    expect(HIGHLIGHT_COLORS.map(c => c.label)).toEqual(['연노랑', '연주황', '연분홍', '연초록', '연파랑', '연보라']);
    expect(HIGHLIGHT_COLORS.map(c => c.value)).toEqual(['#FEF08A', '#FED7AA', '#FBCFE8', '#BBF7D0', '#BFDBFE', '#DDD6FE']);
    expect(HIGHLIGHT_NONE).toBe('transparent');
  });

  it('선택 위치의 배경색을 읽는다(흰색·투명은 배경 없음)', () => {
    const root = editor('<p><span style="background-color: #fef08a">노랑</span> <span style="background-color: white">흰</span> 기본</p>');
    const spans = root.querySelectorAll('span');
    select(spans[0].firstChild!, 1);
    expect(selectionHighlightColor(root)).toBe('#fef08a');
    select(spans[1].firstChild!, 1);
    expect(selectionHighlightColor(root)).toBeNull();
    select(root.querySelector('p')!.lastChild!, 1);
    expect(selectionHighlightColor(root)).toBeNull();
  });
});

describe('배경색 메뉴', () => {
  function renderMenu(currentHighlight: string | null = null) {
    const root = editor('<p>배경을 칠할 글자</p>');
    const text = root.querySelector('p')!.firstChild!;
    const range = select(text, 0, text, 3);
    const editorRef = createRef<HTMLElement>() as { current: HTMLElement | null };
    editorRef.current = root;
    const onClose = vi.fn();
    const onFormat = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const reactRoot = createRoot(host);
    cleanup.push(() => {
      act(() => reactRoot.unmount());
      host.remove();
    });
    act(() => {
      reactRoot.render(
        <RichTextContextMenu
          editorRef={editorRef as React.RefObject<HTMLElement>}
          state={{ top: 10, left: 10, range, currentPx: null, currentHighlight }}
          onClose={onClose}
          onFormat={onFormat}
        />,
      );
    });
    const menu = document.querySelector<HTMLElement>('[data-testid="rich-text-context-menu"]')!;
    const button = (label: string) => menu.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
    return { button, onClose, onFormat };
  }

  it('색을 누르면 메뉴를 연 순간의 선택에 배경색 명령 한 번(CSS) — 저장을 알리고 닫는다', () => {
    const calls: unknown[][] = [];
    document.execCommand = vi.fn((...args: unknown[]) => {
      calls.push(args);
      return true;
    }) as typeof document.execCommand;
    const { button, onClose, onFormat } = renderMenu();
    window.getSelection()!.removeAllRanges(); // 메뉴를 누르는 동안 선택이 흔들려도
    act(() => button('배경색 연초록').click());
    expect(calls).toEqual([
      ['styleWithCSS', false, 'true'],
      ['hiliteColor', false, '#BBF7D0'],
      ['styleWithCSS', false, 'false'],
    ]);
    expect(window.getSelection()!.toString()).toBe('배경을');
    expect(onFormat).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('배경색 제거 = 투명(흰색을 칠하지 않는다)', () => {
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;
    const { button } = renderMenu('#fef08a');
    act(() => button('배경색 제거').click());
    expect(execCommand).toHaveBeenCalledWith('hiliteColor', false, 'transparent');
    expect(execCommand).not.toHaveBeenCalledWith('hiliteColor', false, expect.stringMatching(/^#fff|white/i));
  });

  it('지금 배경색을 강조한다', () => {
    const { button } = renderMenu('#fef08a');
    expect(button('배경색 연노랑').getAttribute('aria-pressed')).toBe('true');
    expect(button('배경색 연파랑').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('배경색 저장 계약', () => {
  it('편집기가 만든 배경 span 은 다른 서식과 함께 저장된다', () => {
    const html = clean('<p><span style="background-color: rgb(254, 240, 138);"><strong>굵게</strong> <span style="color: rgb(239, 68, 68);">빨강</span></span> 보통</p>');
    expect(html).toContain('background-color');
    expect(html).toContain('<strong>굵게</strong>');
    expect(html).toContain('color: rgb(239, 68, 68)');
    // 다시 정리해도 같은 HTML(저장할 때마다 바뀌지 않는다)
    expect(clean(html)).toBe(html);
  });

  it('제거(투명)한 자리에는 배경 속성이 남지 않고 다른 서식은 남는다', () => {
    const html = clean(
      '<p><span style="background-color: transparent;"><strong>굵게</strong><u>밑줄</u></span>'
      + '<span style="background-color: transparent; color: rgb(59, 130, 246);">파랑</span></p>',
    );
    expect(html).not.toMatch(/background/);
    expect(html).toContain('<strong>굵게</strong>');
    expect(html).toContain('<u>밑줄</u>');
    expect(html).toContain('color: rgb(59, 130, 246)');
  });
});

describe('기울임꼴', () => {
  it('붙여넣기 입구 — <i>·<em>·font-style italic/oblique 는 글자만 남고 다른 서식은 그대로', () => {
    const pasted = clean(
      '<p><i>기울임</i> <em>강조</em> <span style="font-style: italic; color: #ef4444">빨간 기울임</span> '
      + '<span style="font-style: oblique">비스듬</span> <b><i>굵은 기울임</i></b> '
      + '<span style="background-color: #fef08a; font-style: italic">노랑 기울임</span> <a href="https://example.com"><i>링크</i></a></p>',
      true,
    );
    expect(pasted).not.toMatch(/<(i|em)\b|italic|oblique/i);
    for (const text of ['기울임', '강조', '빨간 기울임', '비스듬', '굵은 기울임', '노랑 기울임', '링크']) expect(pasted).toContain(text);
    expect(pasted).toMatch(/<(b|strong)>굵은 기울임<\/(b|strong)>/);
    expect(pasted).toContain('color: rgb(239, 68, 68)');
    expect(pasted).toContain('background-color');
    expect(pasted).toContain('href="https://example.com"');
  });

  it('붙여넣기 입구 — 중첩 span · Word 표 칸 기울임', () => {
    const pasted = clean(
      '<div><span style="font-style: italic"><span style="font-weight: bold"><span style="text-decoration: underline">셋 다</span></span></span></div>'
      + '<table><tbody><tr><td style="font-style: italic; background-color: #fef08a">칸</td></tr></tbody></table>',
      true,
    );
    expect(pasted).not.toMatch(/<(i|em)\b|italic/i);
    expect(pasted).toContain('<strong>');
    expect(pasted).toContain('<u>');
    expect(pasted).toMatch(/<td[^>]*background/);
  });

  it('저장된 메모를 다시 저장할 때는 HTML 을 바꾸지 않는다(열기·닫기로 저장·Sync 가 생기지 않게)', () => {
    const stored = '<p><em>예전 기울임</em> 글자</p>';
    expect(clean(stored)).toBe(stored);
  });

  it('Ctrl+I 는 아무 서식도 만들지 않는다(브라우저 기본 기울임 막음)', () => {
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;
    const root = editor('<p>글자</p>');
    select(root.querySelector('p')!.firstChild!, 0, root.querySelector('p')!.firstChild!, 2);
    const event = { key: 'i', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, preventDefault: vi.fn() };
    expect(handleRichTextShortcut(event, root)).toBe(false); // 바뀐 것이 없으니 저장을 알리지 않는다
    expect(event.preventDefault).toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
    expect(root.innerHTML).toBe('<p>글자</p>');
  });
});
