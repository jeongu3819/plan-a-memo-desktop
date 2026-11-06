/**
 * 읽기 화면에서 누른 글자 자리 → 편집기의 같은 자리(캐럿).
 *
 * 읽기 화면(PersonalMemoContentView)과 편집기(RichDescriptionEditor)는 같은 저장 HTML 을 그리므로 DOM 구조가 같다.
 * 누른 자리를 '루트에서의 자식 번호 경로 + 오프셋' 으로 기억했다가 편집기에서 같은 경로를 찾는다.
 * 두 DOM 이 조금이라도 다르면(이미지 자리 표시 등) 경로 대신 '앞에 있는 글자 수' 로 찾는다.
 * 어느 쪽도 저장 HTML 을 바꾸지 않는다 — 선택(Selection)만 놓는다.
 */

export interface CaretSpot {
  /** 루트에서 캐럿이 있는 노드까지의 자식 번호. */
  path: number[];
  offset: number;
  /** 루트 처음부터 캐럿까지의 글자 수(경로가 맞지 않을 때 쓰는 대안). */
  text: number;
  /** 문단 경계(앞 문단 끝 = 다음 문단 처음)에서 다음 글 쪽에 놓는다. */
  forward: boolean;
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function textBefore(root: Node, node: Node, offset: number): number {
  const range = root.ownerDocument!.createRange();
  range.setStart(root, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

function maxOffset(node: Node): number {
  return node.nodeType === Node.TEXT_NODE ? (node as Text).data.length : node.childNodes.length;
}

/** 루트 안의 (노드, 오프셋) 자리를 기억할 수 있는 형태로. 루트 밖이면 null. */
export function caretSpotAt(root: Node, node: Node, offset: number): CaretSpot | null {
  if (!root.contains(node)) return null;
  const path: number[] = [];
  for (let current: Node = node; current !== root; current = current.parentNode!) {
    const parent = current.parentNode;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
  }
  const clamped = Math.max(0, Math.min(offset, maxOffset(node)));
  const forward = node.nodeType === Node.TEXT_NODE ? clamped === 0 : clamped < node.childNodes.length;
  return { path, offset: clamped, text: textBefore(root, node, clamped), forward };
}

/** 화면 좌표(누른 자리)의 글자 자리. 루트 밖이거나 브라우저가 알려 주지 않으면 null. */
export function caretSpotFromPoint(root: HTMLElement, x: number, y: number): CaretSpot | null {
  const doc = root.ownerDocument as CaretDocument;
  let node: Node | null = null;
  let offset = 0;
  if (typeof doc.caretPositionFromPoint === 'function') {
    const position = doc.caretPositionFromPoint(x, y);
    if (position) {
      node = position.offsetNode;
      offset = position.offset;
    }
  } else if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  return node ? caretSpotAt(root, node, offset) : null;
}

/** 기억한 자리를 다른 루트(같은 HTML 을 그린 편집기)에서 찾는다. */
export function resolveCaretSpot(root: Node, spot: CaretSpot): { node: Node; offset: number } {
  let node: Node | null = root;
  for (const index of spot.path) {
    node = node?.childNodes[index] ?? null;
    if (!node) break;
  }
  // 같은 구조인지는 앞의 글자 수로 확인한다 — 경로가 같아도 내용이 다르면 대안으로.
  if (node && spot.offset <= maxOffset(node) && textBefore(root, node, spot.offset) === spot.text) {
    return { node, offset: spot.offset };
  }
  return textPosition(root, spot.text, spot.forward);
}

function textPosition(root: Node, target: number, forward: boolean): { node: Node; offset: number } {
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const end = seen + node.data.length;
    if (forward ? target < end : target <= end) return { node, offset: target - seen };
    seen = end;
    last = node;
  }
  return last ? { node: last, offset: last.data.length } : { node: root, offset: root.childNodes.length };
}

/** 편집기에 캐럿을 놓는다(스크롤하지 않는다). spot 이 없으면 끝에. */
export function placeCaret(editable: HTMLElement, spot: CaretSpot | null): void {
  editable.focus({ preventScroll: true });
  const range = editable.ownerDocument.createRange();
  if (spot) {
    const { node, offset } = resolveCaretSpot(editable, spot);
    range.setStart(node, offset);
    range.collapse(true);
  } else {
    range.selectNodeContents(editable);
    range.collapse(false);
  }
  const selection = editable.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
