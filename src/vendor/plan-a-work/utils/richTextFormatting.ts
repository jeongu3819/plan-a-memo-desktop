/** The small shared Description/Worknote formatting contract. No layout CSS. */
export const TEXT_SIZES = ['small', 'normal', 'large', 'xlarge'] as const;
export const TEXT_SIZE_PX = [12, 14.4, 16, 20] as const;
/**
 * 숫자 글자 크기(px, 정수) — 저장 계약의 **단일 원천**. 네 단계 preset 을 대체하지 않고 더한다
 * (기존 본문의 small/normal/large/xlarge 는 그대로 렌더·저장된다).
 *   · 저장 가능 범위: TEXT_SIZE_MIN_PX ~ TEXT_SIZE_MAX_PX 의 모든 정수(백엔드 TEXT_SIZE_VALUES,
 *     index.css 의 [data-text-size="N"] 규칙과 같은 범위여야 한다).
 *   · 붙여넣기는 원본 크기를 반올림해 그대로 쓰고, 범위 밖이면 가장 가까운 끝값으로 맞춘다
 *     (30px → 24px). 줄 높이·카드 폭을 깨지 않는 상한이다.
 *   · 우클릭 메뉴가 보여 주는 값은 그중 일부(NUMERIC_TEXT_SIZES)다.
 */
export const TEXT_SIZE_MIN_PX = 12;
export const TEXT_SIZE_MAX_PX = 24;
export const NUMERIC_TEXT_SIZES = ['12', '13', '14', '15', '16', '18', '20', '22', '24'] as const;
export type PresetTextSize = typeof TEXT_SIZES[number];
export type NumericTextSize = `${number}`;
export type TextSize = PresetTextSize | NumericTextSize;
export const TEXT_COLORS = ['#374151', '#EF4444', '#F59E0B', '#22C55E', '#3B82F6', '#8B5CF6'];
export const isNumericTextSize = (value: string | null): value is NumericTextSize =>
    !!value && /^\d{1,2}$/.test(value) && Number(value) >= TEXT_SIZE_MIN_PX && Number(value) <= TEXT_SIZE_MAX_PX;
export const isTextSize = (value: string | null): value is TextSize =>
    TEXT_SIZES.includes(value as PresetTextSize) || isNumericTextSize(value);
/** 원본 px → 저장 가능한 숫자 크기(반올림, 범위 밖은 끝값). */
export const clampTextSizePx = (px: number): NumericTextSize =>
    String(Math.min(TEXT_SIZE_MAX_PX, Math.max(TEXT_SIZE_MIN_PX, Math.round(px)))) as NumericTextSize;

/** CSS 길이 → px. 해석할 수 없으면 null. (em 은 본문 0.9rem 기준) */
export function cssLengthPx(value: string): number | null {
    const match = /^(\d+(?:\.\d+)?)(px|pt|rem|em|%)$/i.exec((value || '').trim());
    if (!match) return null;
    return Number(match[1]) * ({ px: 1, pt: 4 / 3, rem: 16, em: 14.4, '%': 0.144 }[match[2].toLowerCase()] || 1);
}

export function normalizeTextSize(value: string, source: 'paste' | 'editor' = 'paste'): TextSize {
    const px = cssLengthPx(value);
    if (px === null || px <= 0) return 'normal';
    // Chromium insertHTML can replace a preset span with its computed inline size.
    // Recognize our exact rendered sizes when serializing native editor output.
    if (source === 'editor') {
        const preset = TEXT_SIZE_PX.findIndex(size => Math.abs(size - px) < 0.01);
        if (preset !== -1) return TEXT_SIZES[preset];
    }
    // 원본 크기를 유지하되 저장 범위로만 맞춘다(단계로 뭉개지 않는다).
    return clampTextSizePx(px);
}

/** 문단 정렬(data-align) — 문단·제목·목록 항목. 왼쪽(기본)은 표 셀 안에서만 적는다. */
const BLOCK_ALIGN_TAGS = /^(P|DIV|H[1-6]|LI|BLOCKQUOTE)$/;
/** 들여쓰기 단계(data-indent) 상한과 한 단계 폭(px). index.css · 백엔드와 같다. */
export const MAX_INDENT_LEVEL = 6;
const INDENT_STEP_PX = 40;

/** 부모 블록이 물려주는 기본 글자 서식(작업용 임시 속성, 저장되지 않는다). */
const INHERITED_STYLE_ATTR = 'data-inherited-style';
const BLOCK_CHILD_TAGS = /^(P|DIV|UL|OL|LI|TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|H[1-6]|BLOCKQUOTE|PRE|HR|COLGROUP)$/;

/** 자식들을 블록 요소 기준으로 끊은 **인라인 덩어리** 목록. 보이는 내용이 없는 덩어리는 뺀다. */
function inlineRuns(node: Element): Node[][] {
    const runs: Node[][] = [];
    let current: Node[] = [];
    const flush = () => {
        const visible = current.some(child => (child.textContent || '').trim()
            || (child instanceof Element && (child.matches('img,br') || !!child.querySelector('img'))));
        if (visible) runs.push(current);
        current = [];
    };
    for (const child of Array.from(node.childNodes)) {
        if (child instanceof Element && BLOCK_CHILD_TAGS.test(child.tagName)) flush();
        else current.push(child);
    }
    flush();
    return runs;
}

/** 하이라이트로 보지 않는 배경 — 흰 바탕·투명(Office/웹 문서가 습관적으로 붙인다). */
function highlightColor(value: string): string | null {
    const color = normalizeTextColor(value || '');
    if (!color || /^(?:#fff(?:fff)?|white)$/i.test(color)) return null;
    return color;
}

/** Canonical safe color; reuse the existing color tool's arbitrary solid colors. */
export function normalizeTextColor(value: string): string | null {
    if (!/^(?:#[\da-f]{3,8}|[a-z]{3,20}|rgba?\([\d.,\s]+\))$/i.test(value.trim())) return null;
    if (/^(?:inherit|initial|unset|transparent|currentcolor)$/i.test(value.trim())) return null;
    const probe = document.createElement('span');
    probe.style.color = value;
    const channels = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/.exec(probe.style.color);
    if (channels) return '#' + channels.slice(1).map(c => Number(c).toString(16).padStart(2, '0')).join('');
    // Named colors are resolved without attaching source content or fetching CSS.
    if (/^[a-z]+$/i.test(probe.style.color)) return probe.style.color.toLowerCase();
    return null;
}

const DECLARATION_KEYS = ['fontWeight', 'textDecoration', 'textDecorationLine', 'fontSize', 'color', 'textAlign',
    'fontStyle', 'backgroundColor', 'marginLeft'] as const;
type Declarations = Pick<CSSStyleDeclaration, typeof DECLARATION_KEYS[number]>;
function declarations(css: string): Declarations {
    const probe = document.createElement('span');
    probe.setAttribute('style', css.split(';').map(part => part.trim()).filter(Boolean).join(';'));
    return Object.fromEntries(DECLARATION_KEYS
        .map(key => [key, probe.style[key as keyof CSSStyleDeclaration]])) as Declarations;
}

/** Extract only simple Office class/tag rules. Never attach a source stylesheet. */
export function officeTextRules(doc: Document): Map<string, string> {
    const rules = new Map<string, string>();
    doc.querySelectorAll('style').forEach(style => {
        // Office 는 규칙 전체를 <!-- --> 로 감싼다 — 그대로 두면 첫 규칙의 선택자가 '<!--p.MsoNormal' 이 되어 빠진다.
        const css = (style.textContent || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--|-->/g, '');
        for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            for (const selector of rule[1].split(',')) {
                const key = selector.trim();
                if (/^(?:[a-z][\w-]*)?(?:\.[\w-]+)?$/i.test(key) && key) {
                    rules.set(key.toLowerCase(), (rules.get(key.toLowerCase()) || '') + ';' + rule[2]);
                }
            }
        }
    });
    return rules;
}

/** Convert formatting to semantic tags / a four-value attribute on a detached tree.
 * Live editor DOM is left to native editing so caret and undo keep working.
 */
export function normalizeRichText(root: ParentNode, options: { paste?: boolean; rules?: Map<string, string> } = {}): void {
    // 편집기의 글자 크기 표식(메모 우클릭)을 먼저 저장 계약으로 정리한다(표식이 없으면 아무 일 없음).
    if (!options.paste) canonicalizeRichSizes(root);
    if (options.paste) {
        for (const child of Array.from(root.childNodes)) {
            if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
                const span = child.ownerDocument!.createElement('span');
                span.setAttribute('data-text-size', 'normal');
                child.replaceWith(span);
                span.append(child);
            } else if (child instanceof HTMLElement && /^(UL|OL)$/.test(child.tagName)) {
                // 목록 자체를 감싸면 <ol><span><li> 가 된다 — 항목에 준다.
                for (const item of Array.from(child.children)) {
                    if (item.tagName === 'LI' && !item.hasAttribute('data-text-size')) item.setAttribute('data-text-size', 'normal');
                }
            } else if (child instanceof HTMLElement && !/^(TABLE|THEAD|TBODY|TFOOT|TR|STYLE|SCRIPT)$/.test(child.tagName)
                && !child.hasAttribute('data-text-size')) child.setAttribute('data-text-size', 'normal');
        }
    }
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('*'));
    for (const node of nodes) {
        if (node.closest('[data-mention-user-id]') || /^(IMG|STYLE|SCRIPT|COL|COLGROUP)$/.test(node.tagName)) continue;
        const tag = node.tagName.toLowerCase();
        // 부모가 물려준 기본값 → 태그/클래스 규칙 → 인라인 style 순서(뒤가 이긴다).
        let css = (node.getAttribute(INHERITED_STYLE_ATTR) || '') + ';' + (options.rules?.get(tag) || '');
        node.removeAttribute(INHERITED_STYLE_ATTR);
        for (const name of Array.from(node.classList)) {
            css += ';' + (options.rules?.get('.' + name.toLowerCase()) || '');
            css += ';' + (options.rules?.get(tag + '.' + name.toLowerCase()) || '');
        }
        const style = declarations(css + ';' + (node.getAttribute('style') || ''));
        if (/^(TABLE|THEAD|TBODY|TFOOT|TR)$/.test(node.tagName)) {
            // Inherited table text styles belong on cells, never wrappers around rows.
            for (const child of Array.from(node.children) as HTMLElement[]) {
                for (const property of ['fontWeight', 'fontSize', 'color', 'textDecoration', 'textAlign'] as const) {
                    if (style[property] && !child.style[property]) child.style[property] = style[property];
                }
            }
            continue;
        }
        const sourceSize = node.getAttribute('data-text-size');
        const nativeSize = node.tagName === 'FONT' ? Number(node.getAttribute('size')) : 0;
        let size: TextSize | null = isTextSize(sourceSize) ? sourceSize : null;
        if (style.fontSize) size = normalizeTextSize(style.fontSize, options.paste ? 'paste' : 'editor');
        if (nativeSize) size = options.paste
            ? normalizeTextSize(`${[10, 13, 16, 18, 24, 32, 48][Math.min(6, Math.max(0, nativeSize - 1))]}px`)
            : TEXT_SIZES[Math.min(3, Math.max(0, nativeSize - 1))];
        if (options.paste && /^H[1-6]$/.test(node.tagName)) {
            size = style.fontSize ? normalizeTextSize(style.fontSize) : 'normal';
        }
        const isCell = /^(TD|TH)$/.test(node.tagName);
        const color = isCell ? null : normalizeTextColor(style.color || node.getAttribute('color') || '');
        // 형광펜(글자 배경). 표 셀 배경은 셀 style 계약이 따로 담는다.
        const highlight = isCell ? null : highlightColor(style.backgroundColor);
        const bold = /^(bold|bolder|[6-9]00)$/i.test(style.fontWeight)
            || (options.paste && /^H[1-6]$/.test(node.tagName));
        const decoration = style.textDecoration + ' ' + style.textDecorationLine;
        const underline = !isCell && /\bunderline\b/i.test(decoration);
        const strike = !isCell && /\bline-through\b/i.test(decoration);
        const italic = !isCell && /^(?:italic|oblique)/i.test(style.fontStyle);
        node.style.removeProperty('font-size');
        node.style.removeProperty('font-weight');
        if (!isCell) {
            node.style.removeProperty('text-decoration');
            node.style.removeProperty('text-decoration-line');
            node.style.removeProperty('color');
            node.style.removeProperty('font-style');
            node.style.removeProperty('background-color');
            node.style.removeProperty('background');
        }
        if (/^(TD|TH)$/.test(node.tagName)) {
            const align = style.textAlign || node.getAttribute('align');
            if (align && /^(left|center|right)$/.test(align)) node.setAttribute('data-align', align);
        } else if (BLOCK_ALIGN_TAGS.test(node.tagName)) {
            const align = (style.textAlign || node.getAttribute('align') || '').toLowerCase();
            const cell = node.closest('td,th');
            // Word often puts a cell's alignment on its single paragraph.
            if (node.tagName === 'P' && cell && !cell.hasAttribute('data-align') && cell.querySelectorAll('p').length === 1
                && /^(left|center|right)$/.test(align)) cell.setAttribute('data-align', align);
            // 문단 자체 정렬. 왼쪽은 기본이라 표 셀(가운데 정렬 셀 안의 왼쪽 문단) 안에서만 적는다.
            if (/^(center|right)$/.test(align) || (align === 'left' && cell)) node.setAttribute('data-align', align);
            if (/^(P|DIV)$/.test(node.tagName) && !cell) {
                const indent = cssLengthPx(style.marginLeft);
                if (indent !== null && indent >= INDENT_STEP_PX / 2) {
                    node.setAttribute('data-indent',
                        String(Math.min(MAX_INDENT_LEVEL, Math.max(1, Math.round(indent / INDENT_STEP_PX)))));
                }
            }
        }
        // Put text formatting inside structural nodes; do not style the table itself.
        // 글자 서식 wrapper(span > strong > em > u > s)는 **인라인 덩어리에만** 씌운다 — 목록·표·문단
        // 같은 블록을 span 으로 감싸면 <span><table>, <ol><span><li> 같은 깨진 구조가 된다.
        const wrappers: string[] = [];
        if (bold && !/^(B|STRONG)$/.test(node.tagName)) wrappers.push('strong');
        if (italic && !/^(I|EM)$/.test(node.tagName)) wrappers.push('em');
        if (underline && node.tagName !== 'U') wrappers.push('u');
        if (strike && !/^(S|STRIKE|DEL)$/.test(node.tagName)) wrappers.push('s');
        const inlineNode = node.tagName === 'SPAN' || node.tagName === 'FONT';
        if (!inlineNode) node.removeAttribute('data-text-size');
        if (size || color || highlight || wrappers.length) {
            const doc = node.ownerDocument;
            const runs = inlineNode ? [Array.from(node.childNodes)] : inlineRuns(node);
            for (const run of runs) {
                let outer: HTMLElement | null = null;
                let inner: HTMLElement | null = null;
                const add = (el: HTMLElement) => {
                    if (inner) inner.append(el); else outer = el;
                    inner = el;
                };
                if (!inlineNode && (size || color || highlight)) {
                    const span = doc.createElement('span');
                    if (size) span.setAttribute('data-text-size', size);
                    if (color) span.style.color = color;
                    if (highlight) span.style.backgroundColor = highlight;
                    add(span);
                }
                wrappers.forEach(tag => add(doc.createElement(tag)));
                if (!outer || !inner) continue;
                if (run.length) run[0].parentNode!.insertBefore(outer, run[0]); else node.append(outer);
                (inner as HTMLElement).append(...run);
            }
            if (inlineNode) {
                if (size) node.setAttribute('data-text-size', size);
            } else if (size || color) {
                // 블록 자식(셀 안 문단·목록 항목)은 감싸지 않았으니 원본처럼 물려준다 — 자기 규칙이 있으면 그쪽이 이긴다.
                for (const child of Array.from(node.children) as HTMLElement[]) {
                    if (!/^(P|DIV|UL|OL|LI|H[1-6]|BLOCKQUOTE)$/.test(child.tagName)) continue;
                    const inherited = [
                        size && style.fontSize ? `font-size:${style.fontSize}` : '',
                        color ? `color:${color}` : '',
                    ].filter(Boolean).join(';');
                    if (inherited) child.setAttribute(INHERITED_STYLE_ATTR, inherited);
                    if (size && !style.fontSize && !child.hasAttribute('data-text-size')) child.setAttribute('data-text-size', size);
                }
            }
        }
        if (node.tagName === 'FONT') {
            const replacement = node.ownerDocument.createElement('span');
            if (size) replacement.setAttribute('data-text-size', size);
            if (color) replacement.style.color = color;
            if (highlight) replacement.style.backgroundColor = highlight;
            replacement.append(...Array.from(node.childNodes));
            node.replaceWith(replacement);
        } else if (node.tagName === 'SPAN') {
            // Canonical span styles contain only color and highlight. Layout and font family never survive.
            node.removeAttribute('style');
            if (color) node.style.color = color;
            if (highlight) node.style.backgroundColor = highlight;
        } else if (/^(STRIKE|DEL)$/.test(node.tagName)) {
            // 취소선의 저장 표현은 <s> 하나다.
            const replacement = node.ownerDocument.createElement('s');
            replacement.append(...Array.from(node.childNodes));
            node.replaceWith(replacement);
        }
    }
}

export function validTableSpan(value: string | null): number {
    const text = value?.trim();
    return text && /^\d{1,2}$/.test(text) && Number(text) >= 1 && Number(text) <= 64 ? Number(text) : 1;
}

/** Occupancy by column, O(cells * bounded colspan), including malformed overlaps. */
export function normalizeTableSpans(root: ParentNode): void {
    root.querySelectorAll('table').forEach(table => {
        const rows = Array.from(table.rows);
        const occupiedUntil: number[] = [];
        rows.forEach((row, rowIndex) => {
            let col = 0;
            const group = row.parentElement as HTMLTableSectionElement;
            const rowsLeft = group.rows.length - row.sectionRowIndex;
            Array.from(row.cells).forEach(cell => {
                while ((occupiedUntil[col] || 0) > rowIndex) col += 1;
                let cols = validTableSpan(cell.getAttribute('colspan'));
                const spans = Math.min(validTableSpan(cell.getAttribute('rowspan')), rowsLeft);
                for (let offset = 1; offset < cols; offset += 1) {
                    if ((occupiedUntil[col + offset] || 0) > rowIndex) { cols = offset; break; }
                }
                for (const [name, value] of [['colspan', cols], ['rowspan', spans]] as const) {
                    if (value > 1) cell.setAttribute(name, String(value));
                    else cell.removeAttribute(name);
                }
                for (let i = 0; i < cols; i += 1) occupiedUntil[col + i] = rowIndex + spans;
                col += cols;
            });
        });
    });
}

export type RichTextCommand = 'bold' | 'underline' | 'fontSize' | 'foreColor';
export function applyRichTextCommand(root: HTMLElement | null, command: RichTextCommand, value?: string): boolean {
    const selection = window.getSelection();
    if (!root || !selection?.rangeCount || !root.contains(selection.getRangeAt(0).commonAncestorContainer)) return false;
    const anchor = selection.anchorNode?.parentElement;
    if (anchor?.closest('[data-mention-user-id]')) return false;
    root.focus({ preventScroll: true });
    // Native commands retain undo and collapsed-selection typing semantics.
    document.execCommand('styleWithCSS', false, 'false');
    document.execCommand(command, false, value);
    return true;
}

/**
 * 편집 중 글자 크기 표식 — `<font face="rich-size-20">`.
 *
 * 글자 크기 변경은 **브라우저의 네이티브 fontName 명령 한 번**으로 한다. 그래야 변경 전체가
 * 편집기의 기본 실행 취소(Ctrl+Z)·다시 실행(Ctrl+Shift+Z / Ctrl+Y) 한 단계가 되고, 앞뒤의 타이핑
 * 이력과 섞이지 않는다(명령 뒤에 DOM 을 손으로 고치면 브라우저의 실행 취소 기록이 어긋나 엉뚱한
 * 글자가 지워진다). 같은 속성(font-family)끼리는 브라우저가 부모 표식을 선택 바깥으로 쪼개 주므로,
 * 큰 글자 문장 일부만 '기본' 으로 바꿔도 부모 크기가 상속되지 않는다.
 *
 * 표식은 편집기 안에만 존재한다 — 글꼴은 CSS 가 되돌리고(index.css), 저장 직렬화
 * (canonicalizeRichSizes)가 `span[data-text-size]` 계약으로 바꾼다.
 */
export const RICH_SIZE_FACE_PREFIX = 'rich-size-';
/** 크기 지정 해제 — 편집기 기본 글자 크기(CSS 변수 --rich-base-font-size)로 보인다. 저장 시 사라진다. */
export const RICH_SIZE_BASE_FACE = `${RICH_SIZE_FACE_PREFIX}base`;
const RICH_SIZE_FONT = `font[face^="${RICH_SIZE_FACE_PREFIX}"]`;
const SIZED_SELECTOR = `${RICH_SIZE_FONT}, span[data-text-size]`;

/** 선택한 글자에 숫자 크기(또는 null = 기본 크기)를 준다. 되돌리기는 브라우저 기본 실행 취소가 맡는다. */
export function applyTextSize(root: HTMLElement | null, size: TextSize | null): boolean {
    const selection = window.getSelection();
    if (!root || !selection?.rangeCount || selection.isCollapsed) return false;
    if (!root.contains(selection.getRangeAt(0).commonAncestorContainer)) return false;
    root.focus({ preventScroll: true });
    document.execCommand('styleWithCSS', false, 'false');
    return document.execCommand('fontName', false, size ? `${RICH_SIZE_FACE_PREFIX}${size}` : RICH_SIZE_BASE_FACE);
}

const isRichSizeFont = (el: Element) =>
    el.tagName === 'FONT' && (el.getAttribute('face') || '').startsWith(RICH_SIZE_FACE_PREFIX);

function nearestSizedAncestor(el: Element): Element | null {
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (parent.matches(SIZED_SELECTOR)) return parent;
    }
    return null;
}

function hasVisibleContent(node: ParentNode): boolean {
    return (node.textContent || '') !== '' || !!node.querySelector?.('img,br,table');
}

function unwrap(el: Element) {
    el.replaceWith(...Array.from(el.childNodes));
}

/** 크기 표시만 지운다. 색 같은 다른 서식이 없으면 껍데기도 없앤다. */
function dropSize(el: Element) {
    el.removeAttribute(isRichSizeFont(el) ? 'face' : 'data-text-size');
    if (!el.attributes.length) unwrap(el);
}

/** `el` 을 크기 조상 `ancestor` 밖으로 꺼낸다 — 조상을 앞/뒤 조각으로 쪼개 선택 부분만 조상 크기를 벗는다. */
function hoistOutOf(el: Element, ancestor: Element) {
    const doc = ancestor.ownerDocument;
    const parent = ancestor.parentNode!;
    const head = doc.createRange();
    head.setStart(ancestor, 0);
    head.setEndBefore(el);
    const tail = doc.createRange();
    tail.setStartAfter(el);
    tail.setEnd(ancestor, ancestor.childNodes.length);
    const headPart = head.extractContents();
    const tailPart = tail.extractContents();
    const wrap = (part: DocumentFragment) => {
        const clone = ancestor.cloneNode(false) as Element;
        clone.append(part);
        return clone;
    };
    if (hasVisibleContent(headPart)) parent.insertBefore(wrap(headPart), ancestor);
    if (hasVisibleContent(tailPart)) parent.insertBefore(wrap(tailPart), ancestor.nextSibling);
    dropSize(ancestor);   // 가운데(= el 로 가는 길)는 조상 크기를 갖지 않는다
}

function sameSpan(a: Element, b: Element) {
    if (a.tagName !== 'SPAN' || b.tagName !== 'SPAN' || a.attributes.length !== b.attributes.length) return false;
    return Array.from(a.attributes).every(attr => b.getAttribute(attr.name) === attr.value);
}

/**
 * 편집 중 크기 표식(font face)을 저장 계약(`span[data-text-size]`)으로 바꾸고, 크기 지정이
 * **중첩되지 않는** 평평한 구조로 정리한다. 화면(CSS)과 같은 우선순위를 쓴다:
 *   · 안쪽 크기가 이긴다 — 단, 나중에 바깥에 덮은 크기 표식(font) 안의 예전 span 크기는 진다
 *     (index.css 의 `font[face^=rich-size-] span[data-text-size] { font-size: inherit }` 와 같다).
 *   · '기본'(rich-size-base)은 조상 크기를 쪼개 벗긴 뒤 표식 없이 남는다.
 *   · 같은 서식의 이웃 span 은 합치고, 빈 크기 span 은 지운다(반복 변경해도 구조가 쌓이지 않게).
 * 크기 표식이 없는 본문(Task Description 등 도구모음 화면)은 건드리지 않는다.
 */
export function canonicalizeRichSizes(root: ParentNode): void {
    // 도구모음(Description·작업노트)의 네이티브 fontSize 결과(<font size=N>)도 같은 표식으로 본다 —
    // 붙여넣은 크기 span 을 통째로 골라 크기를 바꿔도 안쪽 span 이 이기지 않게(index.css 와 같은 규칙).
    root.querySelectorAll('font[size]:not([face])').forEach(font => {
        const size = Number(font.getAttribute('size'));
        if (!(size >= 1 && size <= 7)) return;
        font.setAttribute('face', `${RICH_SIZE_FACE_PREFIX}${TEXT_SIZES[Math.min(3, size - 1)]}`);
        font.removeAttribute('size');
    });
    if (!root.querySelector(RICH_SIZE_FONT)) return;
    for (let guard = 0; guard < 2000; guard += 1) {
        const nested = Array.from(root.querySelectorAll(SIZED_SELECTOR)).find(el => nearestSizedAncestor(el));
        if (!nested) break;
        const ancestor = nearestSizedAncestor(nested)!;
        if (nested.tagName === 'SPAN' && isRichSizeFont(ancestor)) dropSize(nested);
        else hoistOutOf(nested, ancestor);
    }
    root.querySelectorAll(RICH_SIZE_FONT).forEach(font => {
        const size = (font.getAttribute('face') || '').slice(RICH_SIZE_FACE_PREFIX.length);
        const color = normalizeTextColor(font.getAttribute('color') || (font as HTMLElement).style.color || '');
        if (!isTextSize(size) && !color) {
            unwrap(font);
            return;
        }
        const span = font.ownerDocument.createElement('span');
        if (isTextSize(size)) span.setAttribute('data-text-size', size);
        if (color) span.style.color = color;
        span.append(...Array.from(font.childNodes));
        font.replaceWith(span);
    });
    root.querySelectorAll('span[data-text-size]').forEach(span => {
        if (!span.isConnected && !span.parentNode) return;
        if (!hasVisibleContent(span)) {
            span.remove();
            return;
        }
        let next = span.nextSibling;
        while (next instanceof Element && sameSpan(span, next)) {
            span.append(...Array.from(next.childNodes));
            next.remove();
            next = span.nextSibling;
        }
    });
}

/** 선택 위치의 글자 크기(px, 반올림). 우클릭 메뉴가 지금 크기를 표시하는 데만 쓴다. */
export function selectionTextSizePx(root: HTMLElement | null): number | null {
    const selection = window.getSelection();
    const node = selection?.rangeCount ? selection.getRangeAt(0).startContainer : null;
    const element = node instanceof HTMLElement ? node : node?.parentElement;
    if (!root || !element || !root.contains(element)) return null;
    const px = parseFloat(window.getComputedStyle(element).fontSize);
    return Number.isFinite(px) ? Math.round(px) : null;
}

export function handleRichTextShortcut(e: {
    key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean;
    preventDefault(): void;
}, root: HTMLElement | null): boolean {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;
    const key = e.key.toLowerCase();
    if (key !== 'b' && key !== 'u') return false;
    e.preventDefault();
    applyRichTextCommand(root, key === 'b' ? 'bold' : 'underline');
    return true;
}
