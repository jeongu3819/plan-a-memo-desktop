/**
 * contentEditable 편집기에 HTML 을 넣는 공통 경로(Description · 작업노트 · 메모 공용).
 *
 * 붙여넣기 결과(표 포함)는 **편집 이력 한 단계**로 들어가야 Ctrl+Z 한 번에 통째로 취소된다.
 * execCommand 는 deprecated 지만 contentEditable 의 native undo 스택에 들어가는 유일한
 * 방법이라 이것을 먼저 쓰고, 실패할 때만 Range 로 직접 넣는다(이 경우 undo 는 안 된다).
 *
 * 방식 선택 Dialog 나 이미지 업로드 대기 때문에 캐럿이 사라질 수 있으므로, 붙여넣기
 * 시점에 붙잡아 둔 Range 가 아직 이 편집기 안에 살아 있으면 그 자리에, 아니면 본문 끝에 넣는다.
 */

/** 편집기에 포커스를 돌려주고 붙잡아 둔 위치(없으면 본문 끝)로 캐럿을 옮긴다. */
export function restoreEditorSelection(root: HTMLElement, saved: Range | null): void {
    root.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (!selection) return;
    if (saved && saved.startContainer.isConnected && root.contains(saved.startContainer)) {
        selection.removeAllRanges();
        selection.addRange(saved);
        return;
    }
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
}

/** 현재 선택 위치에 HTML 조각을 직접 넣는다(native undo 에는 남지 않는 fallback). */
export function insertHtmlAtSelection(root: HTMLElement, html: string): void {
    if (!html) return;
    const template = document.createElement('template');
    template.innerHTML = html;
    const fragment = template.content;
    const lastNode = fragment.lastChild;
    const selection = window.getSelection();
    const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    if (range && root.contains(range.commonAncestorContainer)) {
        range.deleteContents();
        range.insertNode(fragment);
        if (lastNode) {
            range.setStartAfter(lastNode);
            range.collapse(true);
            selection?.removeAllRanges();
            selection?.addRange(range);
        }
    } else {
        root.appendChild(fragment);
    }
}

/**
 * [PLAN-A Memo Desktop] 캐럿(넣은 내용의 끝)이 보이게 스크롤한다.
 * execCommand('insertHTML'/'insertText') 는 사용자가 직접 붙여넣을 때와 달리 캐럿으로 스크롤하지 않는다 —
 * 서식 있는 장문을 붙여넣으면 편집기(내부 스크롤)가 위쪽에 머문 채 커서가 화면 밖에 남았다.
 * DOM 은 건드리지 않고(Undo 이력 그대로) 캐럿을 담은 스크롤 영역들만 안쪽부터 움직인다.
 */
export function revealSelection(root: HTMLElement): void {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;
    const caret = selection.getRangeAt(0).cloneRange();
    caret.collapse(false);
    if (!root.contains(caret.endContainer)) return;
    const caretRect = (): DOMRect | null => {
        const rects = caret.getClientRects();
        if (rects.length) return rects[rects.length - 1];
        // 빈 줄(<br>) · 블록 경계에서는 접힌 Range 의 사각형이 없다 → 캐럿 바로 앞 노드로 잰다
        const container = caret.endContainer;
        const before = container.nodeType === Node.ELEMENT_NODE ? container.childNodes[caret.endOffset - 1] : container;
        if (!before) return (container as Element).getBoundingClientRect?.() ?? null;
        const probe = document.createRange();
        probe.selectNode(before);
        return probe.getBoundingClientRect();
    };
    const MARGIN = 24;
    for (let el: HTMLElement | null = root; el; el = el.parentElement) {
        if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY) || el.scrollHeight <= el.clientHeight) continue;
        const rect = caretRect();
        if (!rect) return;
        const box = el.getBoundingClientRect();
        if (rect.bottom > box.bottom - MARGIN) el.scrollTop += rect.bottom - box.bottom + MARGIN;
        else if (rect.top < box.top + MARGIN) el.scrollTop -= box.top + MARGIN - rect.top;
    }
    const rect = caretRect();
    if (rect && rect.bottom > window.innerHeight) window.scrollBy(0, rect.bottom - window.innerHeight + MARGIN);
}

/** HTML 을 편집기의 **한 단계**로 넣는다. */
export function insertHtmlAsSingleTransaction(root: HTMLElement, html: string, saved: Range | null): void {
    restoreEditorSelection(root, saved);
    let inserted = false;
    try {
        inserted = document.execCommand('insertHTML', false, html);
    } catch {
        inserted = false;
    }
    if (!inserted) insertHtmlAtSelection(root, html);
    revealSelection(root);
}
