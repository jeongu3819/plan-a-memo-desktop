/**
 * [PLAN-A Memo Desktop] 표 크기 도구('열 맞춤·균등·행 맞춤')와 행·열 핸들 덧그림의 자리 계산.
 *
 * 도구는 `position: fixed` 덧그림이라 레이아웃을 밀지 않는다. 대신 표 바깥 글자를 가리지 않는 자리를 고른다:
 * 표 위 왼쪽 → 위 오른쪽 → 아래 왼쪽 → 아래 오른쪽, 그중 화면(스크롤 영역) 안이고 글자·버튼·이미지가 없는 첫 자리.
 * 어디도 없으면 표 안쪽 오른쪽 위(표 밖 문단은 가리지 않는다). 표가 보이지 않으면 숨긴다.
 */

export interface PlainRect { left: number; top: number; right: number; bottom: number }
export type ToolbarSide = 'above-left' | 'above-right' | 'below-left' | 'below-right' | 'inside';

/** 위쪽 자리와 표 사이 — 열 선택 핸들(위 테두리 ±7px)을 가리지 않게. */
export const TOOLBAR_GAP_ABOVE = 10;
export const TOOLBAR_GAP_BELOW = 6;
/** 화면·스크롤 영역 가장자리 여백. */
export const TOOLBAR_EDGE = 4;

export const OUTSIDE_SIDES: ToolbarSide[] = ['above-left', 'above-right', 'below-left', 'below-right'];

/** 표가 실제로 보이는 영역 — 표에서 위로 overflow 상자들과 창을 겹친 범위(overhang 만큼 넓혀). */
export function visibleClip(el: HTMLElement, overhang = 0): PlainRect {
    let clip: PlainRect = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    let node: HTMLElement | null = el.parentElement;
    while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
            const r = node.getBoundingClientRect();
            clip = {
                left: Math.max(clip.left, r.left - overhang),
                top: Math.max(clip.top, r.top - overhang),
                right: Math.min(clip.right, r.right + overhang),
                bottom: Math.min(clip.bottom, r.bottom + overhang),
            };
        }
        node = node.parentElement;
    }
    return clip;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** 한 자리의 상자(가로는 보이는 영역 안으로 당긴다). */
export function toolbarBox(side: ToolbarSide, table: PlainRect, size: { width: number; height: number }, bounds: PlainRect): PlainRect {
    const minLeft = bounds.left + TOOLBAR_EDGE;
    const maxLeft = Math.max(minLeft, bounds.right - TOOLBAR_EDGE - size.width);
    let left: number;
    let top: number;
    if (side === 'inside') {
        left = clamp(table.right - size.width - TOOLBAR_EDGE, minLeft, maxLeft);
        top = Math.max(table.top, bounds.top) + TOOLBAR_GAP_ABOVE;
    } else {
        left = clamp(side.endsWith('left') ? table.left : table.right - size.width, minLeft, maxLeft);
        top = side.startsWith('above') ? table.top - TOOLBAR_GAP_ABOVE - size.height : table.bottom + TOOLBAR_GAP_BELOW;
    }
    return { left, top, right: left + size.width, bottom: top + size.height };
}

export interface ToolbarPlacement { side: ToolbarSide; left: number; top: number }

/**
 * 자리 고르기. `isFree(box)` = 그 상자 아래에 표 바깥 글자·버튼 등이 없는가.
 * `preferred` 가 주어지고 `trustPreferred` 면(같은 표·같은 배치 — 스크롤만 했다) 그 자리가 화면 안이면 다시 검사하지 않는다.
 */
export function placeTableToolbar({ table, size, bounds, isFree, preferred = null, trustPreferred = false }: {
    table: PlainRect;
    size: { width: number; height: number };
    bounds: PlainRect;
    isFree: (box: PlainRect) => boolean;
    preferred?: ToolbarSide | null;
    trustPreferred?: boolean;
}): ToolbarPlacement | null {
    // 표가 보이는 영역 밖이면 숨긴다(머리말 위에 떠 있지 않게).
    if (table.bottom <= bounds.top || table.top >= bounds.bottom || table.right <= bounds.left || table.left >= bounds.right) return null;
    const fits = (box: PlainRect) => box.top >= bounds.top + TOOLBAR_EDGE && box.bottom <= bounds.bottom - TOOLBAR_EDGE;
    const at = (side: ToolbarSide, box: PlainRect): ToolbarPlacement => ({ side, left: box.left, top: box.top });
    if (preferred && trustPreferred) {
        const box = toolbarBox(preferred, table, size, bounds);
        if (preferred === 'inside' || fits(box)) return at(preferred, box);
    }
    const order = preferred && preferred !== 'inside'
        ? [preferred, ...OUTSIDE_SIDES.filter(s => s !== preferred)]
        : OUTSIDE_SIDES;
    for (const side of order) {
        const box = toolbarBox(side, table, size, bounds);
        if (fits(box) && isFree(box)) return at(side, box);
    }
    return at('inside', toolbarBox('inside', table, size, bounds));
}

/**
 * 상자 아래에 보이는 글자·이미지·버튼이 있는가(점 몇 개를 찍어 본다). `ignore` 안의 요소(도구 자신·핸들)는 뺀다.
 * 글자는 caretRangeFromPoint 로 그 글자의 실제 상자에 점이 들어가는지까지 본다(빈 여백은 비어 있다고 본다).
 */
export function areaHasContent(box: PlainRect, ignore: (Element | null)[]): boolean {
    const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const xs: number[] = [];
    for (let x = box.left + 3; x <= box.right - 3; x += 14) xs.push(x);
    xs.push(box.right - 3);
    const ys = [box.top + 3, (box.top + box.bottom) / 2, box.bottom - 3];
    for (const y of ys) {
        for (const x of xs) {
            if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
            const el = document.elementFromPoint(x, y);
            if (!el || ignore.some(i => i && i.contains(el))) continue;
            if (el.closest('img, svg, button, input, textarea, select, [role="button"]')) return true;
            const range = doc.caretRangeFromPoint?.(x, y);
            const node = range?.startContainer;
            if (!range || !node || node.nodeType !== Node.TEXT_NODE) continue;
            const text = node.textContent || '';
            for (const i of [range.startOffset - 1, range.startOffset]) {
                if (i < 0 || i >= text.length || !text[i].trim()) continue;
                const probe = document.createRange();
                probe.setStart(node, i);
                probe.setEnd(node, i + 1);
                const hit = Array.from(probe.getClientRects())
                    .some(r => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1);
                if (hit) return true;
            }
        }
    }
    return false;
}
