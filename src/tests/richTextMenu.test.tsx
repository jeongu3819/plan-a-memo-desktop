import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RichTextContextMenu, { type RichTextMenuAction } from '../vendor/plan-a-work/components/RichTextContextMenu';
import {
  applyRichList,
  continuedListStart,
  effectiveListStyle,
  handleRichListStyleUndoKey,
  handleRichListTabKey,
  normalizeRichText,
  selectionExplicitTextSizePx,
  selectionLinkAnchor,
  selectionListState,
  selectionTextColor,
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

const keyEvent = (key: string, extra: Partial<KeyboardEvent> = {}) => ({
  key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault: vi.fn(), ...extra,
});

describe('메뉴 표시용 선택 상태', () => {
  it('지정이 없으면 기본 — 본문 기본 크기를 숫자로 강조하지 않는다', () => {
    const root = editor('<p>글자</p>');
    select(root.querySelector('p')!.firstChild!, 1);
    expect(selectionExplicitTextSizePx(root)).toBeNull();
    expect(selectionTextColor(root)).toBeNull();
  });

  it('저장 계약(span)과 편집 표식(font)의 크기를 읽는다 — 바깥 표식이 안쪽 span 을 이긴다', () => {
    const root = editor('<span data-text-size="18">가</span><font face="rich-size-20">나</font><font face="rich-size-22"><span data-text-size="13">다</span></font><font face="rich-size-base">라</font>');
    const text = (i: number) => root.childNodes[i];
    select(text(0).firstChild!, 0);
    expect(selectionExplicitTextSizePx(root)).toBe(18);
    select(text(1).firstChild!, 0);
    expect(selectionExplicitTextSizePx(root)).toBe(20);
    select(text(2).firstChild!.firstChild!, 0);
    expect(selectionExplicitTextSizePx(root)).toBe(22);
    select(text(3).firstChild!, 0);
    expect(selectionExplicitTextSizePx(root)).toBeNull();
  });

  it('예전 네 단계 크기는 메뉴의 숫자로, normal 은 기본으로 보인다', () => {
    const root = editor('<span data-text-size="large">가</span><span data-text-size="normal">나</span>');
    select(root.childNodes[0].firstChild!, 0);
    expect(selectionExplicitTextSizePx(root)).toBe(16);
    select(root.childNodes[1].firstChild!, 0);
    expect(selectionExplicitTextSizePx(root)).toBeNull();
  });

  it('글자 색을 소문자 hex 로 읽는다', () => {
    const root = editor('<font color="#EF4444">가</font><span style="color: rgb(34, 197, 94)">나</span>');
    select(root.childNodes[0].firstChild!, 0);
    expect(selectionTextColor(root)).toBe('#ef4444');
    select(root.childNodes[1].firstChild!, 0);
    expect(selectionTextColor(root)).toBe('#22c55e');
  });

  it('링크 안 커서와 링크에 걸친 선택을 찾고, 링크 없는 선택은 null', () => {
    const root = editor('<p>앞 <a href="https://a.example">링크</a> 뒤</p><p>다른 줄</p>');
    const paragraph = root.querySelector('p')!;
    const anchor = root.querySelector('a')!;
    select(anchor.firstChild!, 1);
    expect(selectionLinkAnchor(root)).toBe(anchor);
    select(paragraph.firstChild!, 0, paragraph.lastChild!, 1);
    expect(selectionLinkAnchor(root)).toBe(anchor);
    select(root.querySelectorAll('p')[1].firstChild!, 0, root.querySelectorAll('p')[1].firstChild!, 2);
    expect(selectionLinkAnchor(root)).toBeNull();
  });
});

describe('목록 표기', () => {
  it('표식이 없으면 깊이로 정한다 — 1단계 1. · 하위 1)', () => {
    const root = editor('<ol id="top"><li>가</li><ol id="sub"><li>나</li></ol></ol>');
    expect(effectiveListStyle(root.querySelector('#top')!, root)).toBe('decimal');
    expect(effectiveListStyle(root.querySelector('#sub')!, root)).toBe('paren');
    root.querySelector('#sub')!.setAttribute('data-list-style', 'circled');
    expect(effectiveListStyle(root.querySelector('#sub')!, root)).toBe('circled');
  });

  it('커서가 있는 목록의 종류를 알려 준다', () => {
    const root = editor('<ul><li>가</li></ul><ol data-list-style="paren"><li>나</li></ol><p>다</p>');
    select(root.querySelector('ul li')!.firstChild!, 0);
    expect(selectionListState(root).kind).toBe('bullet');
    select(root.querySelector('ol li')!.firstChild!, 0);
    expect(selectionListState(root).kind).toBe('paren');
    select(root.querySelector('p')!.firstChild!, 0);
    expect(selectionListState(root).kind).toBeNull();
  });

  it('전체 선택(시작점이 편집기 자신)도 목록 안으로 본다 — 표기만 바뀌고 목록이 꺼지지 않는다', () => {
    const root = editor('<ol data-list-style="decimal"><li>가</li><li>나</li></ol>');
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;
    select(root, 0, root, root.childNodes.length);
    expect(selectionListState(root).kind).toBe('decimal');
    expect(applyRichList(root, 'paren')).toBe(true);
    expect(execCommand).not.toHaveBeenCalled();
    expect(root.querySelector('ol')!.getAttribute('data-list-style')).toBe('paren');
  });

  it('번호 이어쓰기 — 바로 위 같은 표기 목록의 다음 번호, 사이에 다른 글이 있으면 1 부터', () => {
    const root = editor('<ol><li>가</li><li>나</li></ol><ol id="next"><li>다</li></ol><p>새 주제</p><ol id="far"><li>라</li></ol>');
    expect(continuedListStart(root, root.querySelector('#next')!, 'decimal')).toBe(3);
    expect(continuedListStart(root, root.querySelector('#far')!, 'decimal')).toBeNull();
  });

  it('표기만 바꾸면 글자·구조는 그대로이고 Ctrl+Z / Ctrl+Y 로 되돌린다', () => {
    const root = editor('<ol data-list-style="decimal"><li>가</li><li>나</li></ol>');
    const list = root.querySelector('ol')!;
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;
    select(list.querySelector('li')!.firstChild!, 0);
    const before = root.textContent;
    expect(applyRichList(root, 'circled')).toBe(true);
    expect(execCommand).not.toHaveBeenCalled();
    expect(list.getAttribute('data-list-style')).toBe('circled');
    expect(root.textContent).toBe(before);

    const undo = keyEvent('z', { ctrlKey: true });
    expect(handleRichListStyleUndoKey(undo, root)).toBe(true);
    expect(undo.preventDefault).toHaveBeenCalled();
    expect(list.getAttribute('data-list-style')).toBe('decimal');
    expect(handleRichListStyleUndoKey(keyEvent('y', { ctrlKey: true }), root)).toBe(true);
    expect(list.getAttribute('data-list-style')).toBe('circled');
    expect(handleRichListStyleUndoKey(keyEvent('y', { ctrlKey: true }), root)).toBe(false);
  });

  it('Tab 은 목록 안에서만 들여쓰기 — 목록 밖 Tab 은 그대로 둔다', () => {
    const root = editor('<ol><li>가</li></ol><p>나</p>');
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;
    select(root.querySelector('p')!.firstChild!, 0);
    const outside = keyEvent('Tab');
    expect(handleRichListTabKey(outside, root)).toBe(false);
    expect(outside.preventDefault).not.toHaveBeenCalled();
    select(root.querySelector('li')!.firstChild!, 0);
    expect(handleRichListTabKey(keyEvent('Tab'), root)).toBe(true);
    expect(handleRichListTabKey(keyEvent('Tab', { shiftKey: true }), root)).toBe(true);
    expect(execCommand.mock.calls.map(call => (call as unknown[])[0])).toEqual(['indent', 'outdent']);
  });
});

describe('저장 직렬화', () => {
  it('브라우저가 붙인 본문 기본 크기(소수 px)는 굳히지 않고, 고른 크기·네 단계 크기는 지킨다', () => {
    const root = editor('<ol><li><span style="font-size: 15.04px;">기본</span></li><li><span data-text-size="18">고름</span></li><li><span style="font-size: 13px;">정수</span></li><li><span data-text-size="large">단계</span></li></ol>');
    normalizeRichText(root);
    const spans = Array.from(root.querySelectorAll('li')).map(li => li.querySelector('span')?.getAttribute('data-text-size') ?? null);
    expect(spans).toEqual([null, '18', '13', 'large']);
    expect(root.textContent).toBe('기본고름정수단계');
  });

  it('붙여넣기는 원본 크기를 그대로 반올림한다(기존 규칙)', () => {
    const root = editor('<p><span style="font-size: 15.04px;">붙여넣음</span></p>');
    normalizeRichText(root, { paste: true });
    expect(root.querySelector('[data-text-size="15"]')?.textContent).toBe('붙여넣음');
  });
});

describe('저장 sanitizer', () => {
  it('번호 표기 세 값과 시작 번호·취소선·링크를 지키고, 그 밖의 표기는 버린다', () => {
    const { html } = sanitizeTaskDescriptionHtml(
      '<ol data-list-style="circled" start="3"><li><s>가</s></li></ol><ol data-list-style="evil"><li><a href="https://a.example">나</a></li></ol>',
    );
    expect(html).toContain('data-list-style="circled"');
    expect(html).toContain('start="3"');
    expect(html).toContain('<s>가</s>');
    expect(html).toContain('href="https://a.example');
    expect(html).not.toContain('evil');
  });
});

describe('서식 메뉴', () => {
  function renderMenu(state: Partial<React.ComponentProps<typeof RichTextContextMenu>['state']> = {}, actions?: RichTextMenuAction[]) {
    const root = editor('<p>글자</p>');
    const text = root.querySelector('p')!.firstChild!;
    const range = select(text, 0, text, 2);
    const editorRef = createRef<HTMLElement>() as { current: HTMLElement | null };
    editorRef.current = root;
    const onClose = vi.fn();
    const onFormat = vi.fn();
    const onLink = vi.fn();
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
          state={{ top: 10, left: 10, range, currentPx: null, ...state }}
          onClose={onClose}
          onFormat={onFormat}
          onLink={onLink}
          actions={actions}
        />,
      );
    });
    const menu = document.querySelector<HTMLElement>('[data-testid="rich-text-context-menu"]')!;
    const button = (label: string) => menu.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
    return { menu, button, onClose, onFormat, onLink };
  }

  it('영역 순서: 기본 서식 → 크기 → 색상 → 목록·들여쓰기 → 항목 명령', () => {
    const { menu } = renderMenu({}, [{ key: 'move-top', label: '맨 위로 보내기', onSelect: () => undefined }]);
    const labels = Array.from(menu.querySelectorAll('button')).map(b => b.getAttribute('aria-label'));
    expect(labels.slice(0, 4)).toEqual(['굵게', '밑줄', '취소선', '링크']);
    expect(labels.slice(4, 14)).toEqual(['기본 크기', ...['12', '13', '14', '15', '16', '18', '20', '22', '24'].map(s => `글자 크기 ${s}`)]);
    expect(labels.slice(14, 20)).toEqual(['기본 색', '글자 색 #EF4444', '글자 색 #F59E0B', '글자 색 #22C55E', '글자 색 #3B82F6', '글자 색 #8B5CF6']);
    expect(labels.slice(20)).toEqual(['글머리 기호', '번호 1.', '번호 1)', '원형 숫자 ①', '들여쓰기', '내어쓰기', '맨 위로 보내기']);
  });

  it('지금 서식을 강조한다 — 지정 없으면 기본 크기·기본 색', () => {
    const plain = renderMenu();
    expect(plain.button('기본 크기').getAttribute('aria-pressed')).toBe('true');
    expect(plain.button('글자 크기 15').getAttribute('aria-pressed')).toBe('false');
    expect(plain.button('기본 색').getAttribute('aria-pressed')).toBe('true');
  });

  it('지정된 크기·색·서식·목록을 강조한다', () => {
    const { button } = renderMenu({ currentPx: 18, currentColor: '#ef4444', bold: true, strike: true, link: true, listKind: 'paren' });
    expect(button('기본 크기').getAttribute('aria-pressed')).toBe('false');
    expect(button('글자 크기 18').getAttribute('aria-pressed')).toBe('true');
    expect(button('글자 색 #EF4444').getAttribute('aria-pressed')).toBe('true');
    expect(button('기본 색').getAttribute('aria-pressed')).toBe('false');
    for (const label of ['굵게', '취소선', '링크', '번호 1)']) expect(button(label).getAttribute('aria-pressed')).toBe('true');
    expect(button('밑줄').getAttribute('aria-pressed')).toBe('false');
    expect(button('들여쓰기').hasAttribute('disabled')).toBe(false);
  });

  it('들여쓰기는 목록 안에서만 켜진다', () => {
    const { button } = renderMenu();
    expect(button('들여쓰기').hasAttribute('disabled')).toBe(true);
    expect(button('내어쓰기').hasAttribute('disabled')).toBe(true);
  });

  it('서식을 적용하면 저장을 알리고 메뉴를 닫는다', () => {
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;
    const { button, onClose, onFormat } = renderMenu();
    act(() => button('취소선').click());
    expect(execCommand).toHaveBeenCalledWith('strikeThrough', false, undefined);
    expect(onFormat).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('링크는 선택을 되살린 뒤 편집기에 맡긴다', () => {
    const { button, onClose, onLink } = renderMenu();
    window.getSelection()!.removeAllRanges();
    act(() => button('링크').click());
    expect(window.getSelection()!.toString()).toBe('글자');
    expect(onLink).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('항목 명령은 실행되고, 꺼져 있으면 실행되지 않는다', () => {
    const onSelect = vi.fn();
    const on = renderMenu({}, [{ key: 'move-top', label: '맨 위로 보내기', onSelect }]);
    act(() => on.button('맨 위로 보내기').click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    cleanup.forEach(fn => fn());
    cleanup = [];
    const off = renderMenu({}, [{ key: 'move-top', label: '맨 위로 보내기', onSelect, disabled: true, disabledReason: '이미 맨 위에 있습니다' }]);
    act(() => off.button('맨 위로 보내기').click());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
