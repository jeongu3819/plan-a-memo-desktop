import { describe, expect, it } from 'vitest';
import { caretSpotAt, caretSpotFromPoint, placeCaret, resolveCaretSpot } from '../editor/caretSpot';

const HTML = '<p>첫 줄 <b>굵게</b> 끝</p><p><br></p><ul><li>목록 하나</li><li>목록 <u>둘</u></li></ul><p>마지막 문장</p>';

function root(html = HTML): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}
function textNode(el: HTMLElement, includes: string): Text {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (node.data.includes(includes)) return node;
  }
  throw new Error(`no text ${includes}`);
}
/** 캐럿 앞의 글 — 같은 자리인지 확인용. */
function before(el: HTMLElement, node: Node, offset: number): string {
  const range = document.createRange();
  range.setStart(el, 0);
  range.setEnd(node, offset);
  return range.toString();
}

describe('caretSpot — 읽기 화면에서 누른 자리 → 편집기의 같은 자리', () => {
  it('같은 HTML 이면 같은 노드·오프셋', () => {
    const view = root();
    const editor = root();
    const spot = caretSpotAt(view, textNode(view, '목록 하나'), 3)!;
    const found = resolveCaretSpot(editor, spot);
    expect(found.node).toBe(textNode(editor, '목록 하나'));
    expect(found.offset).toBe(3);
  });

  it('굵게·밑줄 안쪽, 마지막 문장 끝', () => {
    const view = root();
    const editor = root();
    for (const [text, offset] of [['굵게', 1], ['둘', 1], ['마지막 문장', 6]] as const) {
      const found = resolveCaretSpot(editor, caretSpotAt(view, textNode(view, text), offset)!);
      expect(before(editor, found.node, found.offset)).toBe(before(view, textNode(view, text), offset));
    }
  });

  it('빈 줄(<p><br></p>)을 누르면 그 빈 줄에', () => {
    const view = root();
    const editor = root();
    const empty = view.childNodes[1];
    const spot = caretSpotAt(view, empty, 0)!;
    const found = resolveCaretSpot(editor, spot);
    expect(found.node).toBe(editor.childNodes[1]);
    expect(found.offset).toBe(0);
  });

  it('구조가 달라도(편집기에만 있는 노드) 앞 글자 수로 찾고, 문단 처음이면 다음 문단 쪽', () => {
    const view = root();
    const editor = root(`<span data-extra="1"></span>${HTML}`);
    const spot = caretSpotAt(view, textNode(view, '마지막 문장'), 0)!;
    expect(spot.forward).toBe(true);
    const found = resolveCaretSpot(editor, spot);
    expect(found.node).toBe(textNode(editor, '마지막 문장'));
    expect(found.offset).toBe(0);
  });

  it('문단 끝은 그 문단 끝(다음 문단으로 넘어가지 않음)', () => {
    const view = root();
    const editor = root(`<span data-extra="1"></span>${HTML}`);
    const tail = textNode(view, ' 끝');
    const spot = caretSpotAt(view, tail, tail.data.length)!;
    expect(spot.forward).toBe(false);
    const found = resolveCaretSpot(editor, spot);
    expect(found.node).toBe(textNode(editor, ' 끝'));
    expect(found.offset).toBe(tail.data.length);
  });

  it('내용이 바뀌어 글자 수가 넘치면 끝에', () => {
    const view = root();
    const editor = root('<p>짧음</p>');
    const found = resolveCaretSpot(editor, caretSpotAt(view, textNode(view, '마지막 문장'), 4)!);
    expect(found.node).toBe(textNode(editor, '짧음'));
    expect(found.offset).toBe(2);
  });

  it('루트 밖 노드·좌표 함수가 없는 환경은 null', () => {
    const view = root();
    const other = root('<p>다른 곳</p>');
    expect(caretSpotAt(view, textNode(other, '다른'), 0)).toBeNull();
    expect(caretSpotFromPoint(view, 10, 10)).toBeNull();
  });

  it('placeCaret — 그 자리에 접힌 선택, 저장 HTML 은 그대로', () => {
    const view = root();
    const editor = root();
    editor.contentEditable = 'true';
    const html = editor.innerHTML;
    placeCaret(editor, caretSpotAt(view, textNode(view, '둘'), 1)!);
    const selection = document.getSelection()!;
    expect(selection.isCollapsed).toBe(true);
    expect(selection.anchorNode).toBe(textNode(editor, '둘'));
    expect(before(editor, selection.anchorNode!, selection.anchorOffset).endsWith('목록 하나목록 둘')).toBe(true);
    expect(editor.innerHTML).toBe(html);
  });

  it('placeCaret — 자리가 없으면(키보드로 열기) 끝에', () => {
    const editor = root();
    editor.contentEditable = 'true';
    placeCaret(editor, null);
    const selection = document.getSelection()!;
    expect(before(editor, selection.anchorNode!, selection.anchorOffset)).toBe(editor.textContent);
  });
});
