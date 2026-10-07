/**
 * Description 표 크기 조절 — 저장 계약과 순수 DOM 유틸의 단일 출처.
 *
 * 왜 이 모듈이 따로 있는가:
 *   붙여넣은 표는 "그대로 끝나는 결과물"이 아니라 사용자가 조금씩 다듬는 대상이다.
 *   그런데 Description 의 HTML 은 프론트(`sanitizeTaskDescriptionHtml`)와 백엔드
 *   (`app/services/task_description.py`) 두 sanitizer 를 통과하며 **inline style 이 전부
 *   지워진다**. 그래서 크기를 style 로 저장하면 새로고침 한 번에 사라진다.
 *
 * 저장 계약(= 두 sanitizer 가 허용하는 유일한 형태):
 *
 *     <table data-resizable-table="true">
 *       <colgroup>
 *         <col data-col-width="180">
 *         <col data-col-width="320">
 *       </colgroup>
 *       <tbody>
 *         <tr data-row-min-height="48"> … </tr>
 *       </tbody>
 *     </table>
 *
 * 화면에 실제로 보이는 폭/높이는 `applyTableSizingStyles()` 가 이 데이터 속성을 읽어
 * **런타임에만** inline style 로 펼친 것이다. 저장 HTML 에는 숫자만 남는다.
 *
 * 행 높이는 `height` 로 적용하지만 의미는 **최소 높이**다. CSS 에서 `tr { height: N }`
 * 는 하한으로 동작하므로(내용이 많아지면 행이 더 커진다) 텍스트가 잘리지 않는다.
 * 그래서 `overflow: hidden` 을 절대 쓰지 않는다.
 */

export const TABLE_SIZING_LIMITS = {
    /** 열 너비 하한 — 이보다 좁으면 한글 두 글자도 못 들어간다. */
    minColWidth: 48,
    maxColWidth: 2000,
    /** 행 최소 높이 하한. */
    minRowHeight: 24,
    maxRowHeight: 1000,
    /** 방어적 상한(비정상 표에서 무한 루프를 막는 용도). */
    maxColumns: 64,
} as const;

export const RESIZABLE_TABLE_ATTR = 'data-resizable-table';
export const COL_WIDTH_ATTR = 'data-col-width';
export const ROW_MIN_HEIGHT_ATTR = 'data-row-min-height';
/**
 * 편집 폭보다 넓어진 표를 감싸는 스크롤 상자.
 * 이 wrapper 만 가로로 스크롤하므로 편집기 전체(문단·이미지)가 밀려나지 않는다.
 * 저장 HTML 에도 그대로 남는다(살아 있는 DOM 과 저장본이 갈라지지 않게).
 */
export const TABLE_SCROLL_ATTR = 'data-table-scroll';
export const TABLE_SCROLL_SELECTOR = `[${TABLE_SCROLL_ATTR}="1"]`;

/** 경계를 잡았다고 보는 마우스 허용 오차(px). */
export const BOUNDARY_HIT_SLOP = 4;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function toFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value ?? '').trim();
    // 저장 계약은 "숫자만"이다. 12px, calc(...), 1e5 같은 값은 받지 않는다.
    if (!/^\d{1,5}(?:\.\d{1,3})?$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
}

/** 저장/적용 전 열 너비 검증. 범위를 벗어나면 잘라내고, 숫자가 아니면 null. */
export function clampColWidth(value: unknown): number | null {
    const parsed = toFiniteNumber(value);
    if (parsed === null) return null;
    return Math.round(clamp(parsed, TABLE_SIZING_LIMITS.minColWidth, TABLE_SIZING_LIMITS.maxColWidth));
}

/** 저장/적용 전 행 최소 높이 검증. */
export function clampRowMinHeight(value: unknown): number | null {
    const parsed = toFiniteNumber(value);
    if (parsed === null) return null;
    return Math.round(clamp(parsed, TABLE_SIZING_LIMITS.minRowHeight, TABLE_SIZING_LIMITS.maxRowHeight));
}

// ────────────────────────────── 격자 ──────────────────────────────

export interface TableGridCell {
    el: HTMLTableCellElement;
    row: number;
    col: number;
    colSpan: number;
    rowSpan: number;
}

export interface TableGrid {
    rows: HTMLTableRowElement[];
    grid: (TableGridCell | null)[][];
    columns: number;
}

/** 중첩 표의 행을 빨아들이지 않도록 "이 표에 직접 속한" 행만 고른다. */
export function ownTableRows(table: Element): HTMLTableRowElement[] {
    return Array.from(table.querySelectorAll('tr'))
        .filter((row) => row.closest('table') === table) as HTMLTableRowElement[];
}

function ownRowCells(row: Element): HTMLTableCellElement[] {
    return Array.from(row.children)
        .filter((c) => c.tagName === 'TD' || c.tagName === 'TH') as HTMLTableCellElement[];
}

/**
 * rowspan/colspan 을 펼친 좌표 격자.
 * 병합 셀이 있는 Excel 표에서도 "몇 번째 열인가"를 틀리지 않게 판단하기 위한 근거다.
 */
export function buildTableGrid(table: Element): TableGrid {
    const rows = ownTableRows(table);
    const grid: (TableGridCell | null)[][] = rows.map(() => []);
    let columns = 0;
    rows.forEach((row, r) => {
        let c = 0;
        ownRowCells(row).forEach((cell) => {
            while (grid[r][c]) c += 1;
            const colSpan = Math.max(1, Math.min(
                TABLE_SIZING_LIMITS.maxColumns,
                parseInt(cell.getAttribute('colspan') || '1', 10) || 1,
            ));
            const rowSpan = Math.max(1, Math.min(
                TABLE_SIZING_LIMITS.maxColumns,
                parseInt(cell.getAttribute('rowspan') || '1', 10) || 1,
            ));
            const entry: TableGridCell = { el: cell, row: r, col: c, colSpan, rowSpan };
            for (let dr = 0; dr < rowSpan && r + dr < rows.length; dr += 1) {
                for (let dc = 0; dc < colSpan; dc += 1) grid[r + dr][c + dc] = entry;
            }
            c += colSpan;
            columns = Math.max(columns, c);
        });
    });
    return { rows, grid, columns: Math.min(columns, TABLE_SIZING_LIMITS.maxColumns) };
}

export function tableColumnCount(table: Element): number {
    return buildTableGrid(table).columns;
}

// ────────────────────────────── colgroup ──────────────────────────────

function ownColgroup(table: HTMLTableElement): HTMLElement | null {
    return Array.from(table.children).find((c) => c.tagName === 'COLGROUP') as HTMLElement | null;
}

function ownColElements(table: HTMLTableElement): HTMLElement[] {
    const colgroup = ownColgroup(table);
    if (!colgroup) return [];
    return Array.from(colgroup.children).filter((c) => c.tagName === 'COL') as HTMLElement[];
}

/** `<colgroup>` 을 표 맨 앞에 두고 `count` 개의 `<col>` 을 맞춰 둔다. */
function ensureColgroup(table: HTMLTableElement, count: number): HTMLElement[] {
    let colgroup = ownColgroup(table);
    if (!colgroup) {
        colgroup = table.ownerDocument.createElement('colgroup');
        table.insertBefore(colgroup, table.firstChild);
    }
    const cols = ownColElements(table);
    while (cols.length > count) {
        cols.pop()?.remove();
    }
    while (cols.length < count) {
        const col = table.ownerDocument.createElement('col');
        colgroup.appendChild(col);
        cols.push(col);
    }
    return cols;
}

function removeColgroup(table: HTMLTableElement): void {
    ownColgroup(table)?.remove();
}

// ────────────────────────────── 가로 스크롤 wrapper ──────────────────────────────

function scrollWrapperOf(table: HTMLTableElement): HTMLElement | null {
    const parent = table.parentElement;
    return parent?.getAttribute(TABLE_SCROLL_ATTR) === '1' ? parent : null;
}

/**
 * 수동 폭이 있는 표만 스크롤 상자에 넣는다.
 * (자동 맞춤 표는 항상 편집 폭 안에 들어오므로 wrapper 가 필요 없다.)
 */
function syncTableScrollWrapper(table: HTMLTableElement, needed: boolean): void {
    const wrapper = scrollWrapperOf(table);
    if (needed) {
        if (wrapper) return;
        const box = table.ownerDocument.createElement('div');
        box.setAttribute(TABLE_SCROLL_ATTR, '1');
        table.parentNode?.insertBefore(box, table);
        box.appendChild(table);
        return;
    }
    if (!wrapper) return;
    wrapper.replaceWith(...Array.from(wrapper.childNodes));
}

/** 표가 지워진 뒤 남은 빈 스크롤 상자를 정리한다. */
export function pruneEmptyTableScrollWrappers(root: HTMLElement): void {
    Array.from(root.querySelectorAll(TABLE_SCROLL_SELECTOR)).forEach((box) => {
        if (box.querySelector('table')) return;
        box.replaceWith(...Array.from(box.childNodes));
    });
}

// ────────────────────────────── 읽기 ──────────────────────────────

/** 저장된 열 너비. 값이 없거나 범위를 벗어난 열은 null. */
export function readColWidths(table: HTMLTableElement): (number | null)[] {
    const cols = ownColElements(table);
    if (cols.length === 0) return [];
    return cols.map((col) => clampColWidth(col.getAttribute(COL_WIDTH_ATTR)));
}

/** 저장된 행 최소 높이. */
export function readRowMinHeights(table: HTMLTableElement): (number | null)[] {
    return ownTableRows(table).map((row) => clampRowMinHeight(row.getAttribute(ROW_MIN_HEIGHT_ATTR)));
}

/** 사용자가 한 번이라도 직접 크기를 조절했는가. */
export function isTableManuallySized(table: HTMLTableElement): boolean {
    if (readColWidths(table).some((w) => w !== null)) return true;
    return readRowMinHeights(table).some((h) => h !== null);
}

// ────────────────────────────── 쓰기 / 적용 ──────────────────────────────

/**
 * 데이터 속성 → 실제 화면 크기.
 *
 * 저장 HTML 에는 숫자만 남기고, 보이는 크기는 항상 여기서 만든다.
 * `value` 로 innerHTML 을 다시 채운 직후에 호출해야 재조회 후에도 같은 크기가 나온다.
 */
export function applyTableSizing(table: HTMLTableElement): void {
    const widths = readColWidths(table);
    const hasWidths = widths.some((w) => w !== null);

    if (hasWidths) {
        const cols = ownColElements(table);
        let total = 0;
        let complete = cols.length > 0;
        cols.forEach((col, index) => {
            const width = widths[index];
            if (width === null) {
                col.style.width = '';
                complete = false;
                return;
            }
            // 저장값이 범위 밖이었다면 잘린 값으로 되돌려 써서 화면과 저장이 갈라지지 않게 한다.
            col.setAttribute(COL_WIDTH_ATTR, String(width));
            col.style.width = `${width}px`;
            total += width;
        });
        table.setAttribute(RESIZABLE_TABLE_ATTR, 'true');
        table.style.tableLayout = 'fixed';
        // 합계 폭을 그대로 쓴다. 편집 영역보다 넓어지면 wrapper 만 가로 스크롤하고
        // 편집기의 문단·이미지는 제자리에 남는다.
        table.style.width = complete && total > 0 ? `${total}px` : '100%';
        table.style.maxWidth = 'none';
        syncTableScrollWrapper(table, true);
    } else {
        table.removeAttribute(RESIZABLE_TABLE_ATTR);
        table.style.tableLayout = '';
        table.style.width = '';
        table.style.maxWidth = '';
        syncTableScrollWrapper(table, false);
    }

    ownTableRows(table).forEach((row) => {
        const height = clampRowMinHeight(row.getAttribute(ROW_MIN_HEIGHT_ATTR));
        if (height === null) {
            row.removeAttribute(ROW_MIN_HEIGHT_ATTR);
            row.style.height = '';
            return;
        }
        row.setAttribute(ROW_MIN_HEIGHT_ATTR, String(height));
        // height 는 표 행에서 "하한"으로 동작한다 → 내용이 늘면 행도 늘어난다.
        row.style.height = `${height}px`;
    });
}

/** 편집 영역 전체의 표에 저장된 크기를 다시 입힌다. */
export function applyTableSizingStyles(root: HTMLElement | null | undefined): void {
    if (!root) return;
    Array.from(root.querySelectorAll('table')).forEach((table) => {
        applyTableSizing(table as HTMLTableElement);
    });
    pruneEmptyTableScrollWrappers(root);
}

/** 열 너비를 저장 계약에 기록하고 화면에 반영한다. null 을 넘기면 수동 크기를 지운다. */
export function writeColWidths(table: HTMLTableElement, widths: (number | null)[] | null): void {
    const usable = (widths || []).map(clampColWidth);
    if (!widths || usable.every((w) => w === null)) {
        removeColgroup(table);
        applyTableSizing(table);
        return;
    }
    const cols = ensureColgroup(table, usable.length);
    cols.forEach((col, index) => {
        const width = usable[index];
        if (width === null) col.removeAttribute(COL_WIDTH_ATTR);
        else col.setAttribute(COL_WIDTH_ATTR, String(width));
    });
    applyTableSizing(table);
}

/** 한 행의 최소 높이를 기록한다. null 이면 자동(내용 기준)으로 되돌린다. */
export function writeRowMinHeight(row: HTMLTableRowElement, height: number | null): void {
    const clamped = height === null ? null : clampRowMinHeight(height);
    if (clamped === null) {
        row.removeAttribute(ROW_MIN_HEIGHT_ATTR);
        row.style.height = '';
        return;
    }
    row.setAttribute(ROW_MIN_HEIGHT_ATTR, String(clamped));
    row.style.height = `${clamped}px`;
}

/** 수동 크기 전부 초기화 → 붙여넣기 직후의 자동 맞춤 상태로. */
export function resetTableSizing(table: HTMLTableElement): void {
    removeColgroup(table);
    ownTableRows(table).forEach((row) => {
        row.removeAttribute(ROW_MIN_HEIGHT_ATTR);
        row.style.height = '';
    });
    applyTableSizing(table);
}

// ────────────────────────────── 측정 ──────────────────────────────

function rectWidth(el: Element): number {
    const rect = el.getBoundingClientRect?.();
    return rect ? rect.width : 0;
}

/**
 * 현재 화면에 그려진 열 너비.
 *
 * 병합 셀만 있는 열은 직접 잴 수 없으므로, 그 열을 덮는 병합 셀의 폭에서 이미 확정된
 * 열들을 빼고 남은 폭을 나눠 갖는다(그래야 Excel 병합 표에서도 경계가 맞는다).
 */
export function measureColumnWidths(table: HTMLTableElement): number[] {
    const { rows, grid, columns } = buildTableGrid(table);
    if (columns === 0) return [];
    const widths = new Array<number>(columns).fill(0);
    const known = new Array<boolean>(columns).fill(false);

    for (let r = 0; r < rows.length; r += 1) {
        for (let c = 0; c < columns; c += 1) {
            if (known[c]) continue;
            const cell = grid[r]?.[c];
            if (!cell || cell.colSpan !== 1 || cell.col !== c) continue;
            const width = rectWidth(cell.el);
            if (width > 0) {
                widths[c] = width;
                known[c] = true;
            }
        }
    }

    if (known.some((k) => !k)) {
        for (let r = 0; r < rows.length; r += 1) {
            for (let c = 0; c < columns; c += 1) {
                const cell = grid[r]?.[c];
                if (!cell || cell.colSpan <= 1 || cell.col !== c) continue;
                const span: number[] = [];
                let assigned = 0;
                for (let dc = 0; dc < cell.colSpan && c + dc < columns; dc += 1) {
                    if (known[c + dc]) assigned += widths[c + dc];
                    else span.push(c + dc);
                }
                if (span.length === 0) continue;
                const remaining = Math.max(0, rectWidth(cell.el) - assigned);
                const share = remaining / span.length;
                if (share <= 0) continue;
                span.forEach((index) => {
                    widths[index] = share;
                    known[index] = true;
                });
            }
        }
    }

    const fallback = (rectWidth(table) || 0) / columns;
    return widths.map((width, index) => Math.round(
        known[index] && width > 0 ? width : Math.max(TABLE_SIZING_LIMITS.minColWidth, fallback),
    ));
}

export interface ColumnBoundary {
    /** 경계 왼쪽 열의 인덱스. 마지막 인덱스는 표의 오른쪽 끝을 의미한다. */
    index: number;
    /** 뷰포트 기준 x 좌표. */
    x: number;
}

export interface RowBoundary {
    /** 경계 위쪽 행의 인덱스. */
    index: number;
    /** 뷰포트 기준 y 좌표. */
    y: number;
}

/** 열 경계 좌표(첫 열의 왼쪽 끝은 제외 — 왼쪽으로 밀 열이 없다). */
export function columnBoundaries(table: HTMLTableElement): ColumnBoundary[] {
    const widths = measureColumnWidths(table);
    if (widths.length === 0) return [];
    const { grid } = buildTableGrid(table);
    const first = grid[0]?.[0];
    const originRect = (first?.el || table).getBoundingClientRect?.();
    let x = originRect ? originRect.left : 0;
    return widths.map((width, index) => {
        x += width;
        return { index, x };
    });
}

/** 행 경계 좌표(각 행의 아래쪽 경계). */
export function rowBoundaries(table: HTMLTableElement): RowBoundary[] {
    return ownTableRows(table).map((row, index) => ({
        index,
        y: row.getBoundingClientRect?.().bottom ?? 0,
    }));
}

/** 좌표에서 가장 가까운 경계(허용 오차 안일 때만). */
export function findBoundary<T extends { x: number } | { y: number }>(
    boundaries: T[],
    position: number,
    axis: 'x' | 'y',
    slop = BOUNDARY_HIT_SLOP,
): T | null {
    let best: T | null = null;
    let bestDistance = slop + 1;
    boundaries.forEach((boundary) => {
        const value = axis === 'x' ? (boundary as { x: number }).x : (boundary as { y: number }).y;
        const distance = Math.abs(value - position);
        if (distance <= slop && distance < bestDistance) {
            best = boundary;
            bestDistance = distance;
        }
    });
    return best;
}

// ────────────────────────────── 계산 ──────────────────────────────

/**
 * 열 경계를 delta 만큼 끌었을 때의 새 열 너비.
 *
 * 가운데 경계는 인접 두 열이 폭을 주고받아 **표 전체 폭이 유지**된다(권장 방식).
 * 마지막 경계만 표 전체 폭이 바뀐다.
 */
export function resizeColumnAt(widths: number[], index: number, deltaPx: number): number[] {
    const { minColWidth: min, maxColWidth: max } = TABLE_SIZING_LIMITS;
    const next = widths.map((w) => Math.round(clamp(w, min, max)));
    if (index < 0 || index >= next.length) return next;

    if (index === next.length - 1) {
        next[index] = Math.round(clamp(widths[index] + deltaPx, min, max));
        return next;
    }
    const pair = widths[index] + widths[index + 1];
    const left = Math.round(clamp(widths[index] + deltaPx, min, Math.min(max, pair - min)));
    next[index] = left;
    next[index + 1] = Math.round(clamp(pair - left, min, max));
    return next;
}

/** 열 너비 균등 분배. */
export function evenColumnWidths(columns: number, availableWidth: number): number[] {
    if (columns <= 0) return [];
    const each = clamp(
        Math.floor(availableWidth / columns),
        TABLE_SIZING_LIMITS.minColWidth,
        TABLE_SIZING_LIMITS.maxColWidth,
    );
    return new Array<number>(columns).fill(each);
}

// ───────────────────── 열 하나만 내용에 맞추기(경계 더블클릭) ─────────────────────

export const COLUMN_AUTOFIT = {
    /** 자동 맞춤 하한. 전체 하한(48)보다 조금 넉넉해야 "자동으로 맞춘 열"처럼 보인다. */
    minWidth: 60,
    /** 측정 오차·캐럿 여유. 이만큼 못 주면 마지막 글자가 아슬아슬하게 줄바꿈된다. */
    slack: 2,
} as const;

/** 측정용 요소를 담는 화면 밖 상자. 표마다 새로 만들지 않는다. */
let measureHost: HTMLElement | null = null;

function measureHostFor(doc: Document): HTMLElement {
    if (measureHost && measureHost.isConnected && measureHost.ownerDocument === doc) {
        return measureHost;
    }
    const host = doc.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = [
        'position:absolute', 'left:-99999px', 'top:0',
        'width:0', 'height:0', 'overflow:hidden', 'visibility:hidden',
    ].join(';');
    doc.body.appendChild(host);
    measureHost = host;
    return host;
}

/** 측정용 요소가 원본 셀과 같은 글꼴·여백을 갖도록 복사할 속성. */
const MEASURED_CELL_STYLES = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
    'letterSpacing', 'wordSpacing', 'textTransform', 'lineHeight',
    'paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth',
] as const;

/**
 * 셀 내용이 줄바꿈 없이 보이는 데 필요한 폭(px).
 *
 * 글자 수 × 고정 px 로 어림하지 않는다. 지금 화면에 적용된 글꼴·굵기·자간·padding·border 를
 * 그대로 입힌 측정용 요소에 셀 내용을 넣고 실제 폭을 잰다. 그래서 굵은 글씨, 링크,
 * 셀 안의 아이콘·이미지까지 자연스럽게 반영된다.
 *
 * `white-space: nowrap` 이므로 자동 줄바꿈은 풀리지만 `<br>` 같은 **명시적 줄바꿈은 남는다**
 * → 여러 줄 셀에서는 "가장 긴 줄"의 폭이 나온다.
 */
export function measureCellContentWidth(cell: HTMLTableCellElement): number {
    const doc = cell.ownerDocument;
    const view = doc?.defaultView;
    if (!doc || !view || typeof view.getComputedStyle !== 'function') return 0;

    const computed = view.getComputedStyle(cell);
    const probe = doc.createElement('div');
    MEASURED_CELL_STYLES.forEach((prop) => {
        const value = computed[prop];
        if (value) probe.style[prop] = value;
    });
    probe.style.position = 'absolute';
    probe.style.top = '0';
    probe.style.left = '0';
    probe.style.width = 'auto';
    probe.style.maxWidth = 'none';
    probe.style.whiteSpace = 'nowrap';
    probe.style.boxSizing = 'content-box';
    // 셀 내용을 그대로 옮긴다(원본 DOM 은 건드리지 않는다).
    probe.innerHTML = cell.innerHTML;

    const host = measureHostFor(doc);
    host.appendChild(probe);
    let width = 0;
    try {
        const borders = (parseFloat(computed.borderLeftWidth) || 0)
            + (parseFloat(computed.borderRightWidth) || 0);
        // scrollWidth 는 내용+padding, 사각형 폭은 border 까지. 둘 중 큰 값을 쓴다.
        const byScroll = (probe.scrollWidth || 0) + borders;
        const byRect = probe.getBoundingClientRect?.().width || 0;
        width = Math.max(byScroll, byRect);
    } finally {
        probe.remove();
    }
    return Number.isFinite(width) && width > 0 ? width : 0;
}

export interface ColumnAutoFitOptions {
    /** 셀 하나에 필요한 폭. 기본은 실제 렌더 측정(`measureCellContentWidth`). */
    measureCell?: (cell: HTMLTableCellElement) => number;
    /** 편집 영역을 벗어나지 않도록 하는 상한. 넘치는 내용은 이 폭에서 줄바꿈된다. */
    maxWidth?: number;
}

/**
 * 한 열의 내용에 맞는 너비.
 *
 * 병합 셀 처리:
 *  - colspan 이 없는 **일반 셀을 우선**한다(그 열만의 내용이므로 가장 정확하다).
 *  - 일반 셀이 하나도 없으면 병합 셀 폭을 colspan 으로 나눈 값을 참고한다.
 *  - rowspan 으로 여러 행에 걸친 셀은 격자에서 같은 셀로 보이므로 한 번만 잰다.
 *
 * 잴 수 있는 내용이 없으면(빈 열, 레이아웃 없는 환경) `null` — 호출자는 아무것도 바꾸지 않는다.
 */
export function autoFitColumnWidth(
    table: HTMLTableElement,
    index: number,
    options: ColumnAutoFitOptions = {},
): number | null {
    const { grid, rows, columns } = buildTableGrid(table);
    if (index < 0 || index >= columns || rows.length === 0) return null;

    const measure = options.measureCell || measureCellContentWidth;
    const maxWidth = Math.min(
        TABLE_SIZING_LIMITS.maxColWidth,
        Math.max(COLUMN_AUTOFIT.minWidth, Math.round(options.maxWidth ?? TABLE_SIZING_LIMITS.maxColWidth)),
    );

    const seen = new Set<HTMLTableCellElement>();
    let plain = 0;
    let spanned = 0;
    for (let r = 0; r < rows.length; r += 1) {
        const cell = grid[r]?.[index];
        if (!cell || seen.has(cell.el)) continue;
        seen.add(cell.el);
        let width = 0;
        try {
            width = measure(cell.el);
        } catch {
            width = 0; // 측정이 실패해도 표 구조는 그대로 둔다
        }
        if (!Number.isFinite(width) || width <= 0) continue;
        if (cell.colSpan === 1) plain = Math.max(plain, width);
        else spanned = Math.max(spanned, width / cell.colSpan);
    }

    const raw = plain > 0 ? plain : spanned;
    if (raw <= 0) return null;
    return Math.round(clamp(raw + COLUMN_AUTOFIT.slack, COLUMN_AUTOFIT.minWidth, maxWidth));
}

/**
 * 열 하나를 내용에 맞춘 **표 전체의** 열 너비.
 *
 * 표에서는 같은 열의 셀들이 폭을 공유하므로 셀 하나만 바꿀 수 없다. 나머지 열은 지금
 * 보이는 폭 그대로 굳혀서, 더블클릭한 열만 달라지게 한다.
 */
export function autoFitSingleColumn(
    table: HTMLTableElement,
    index: number,
    options: ColumnAutoFitOptions = {},
): number[] {
    const widths = measureColumnWidths(table);
    if (index < 0 || index >= widths.length) return widths;
    const target = autoFitColumnWidth(table, index, options);
    if (target === null) return widths;
    const next = widths.slice();
    next[index] = target;
    return next.map((width) => clampColWidth(width) ?? TABLE_SIZING_LIMITS.minColWidth);
}

/**
 * 행 높이 자동 맞춤(행 경계 더블클릭).
 *
 * 열과 달리 여기서는 잴 것이 없다. 표의 행은 **원래** 내용에 맞춰 늘어나고
 * (`tr { height }` 는 하한이다), 저장된 최소 높이가 그것을 눌러 두고 있을 뿐이다.
 * 그래서 자동 맞춤 = 그 행의 수동 최소 높이를 지우는 것이다.
 *
 * 이미 자동 높이인 행이면 아무것도 하지 않고 `false` — 편집 이력도 남지 않는다.
 */
export function autoFitRowHeight(table: HTMLTableElement, index: number): boolean {
    const row = ownTableRows(table)[index];
    if (!row) return false;
    if (clampRowMinHeight(row.getAttribute(ROW_MIN_HEIGHT_ATTR)) === null) return false;
    writeRowMinHeight(row, null);
    return true;
}

/**
 * 열 너비 자동 맞춤 — 브라우저의 auto 레이아웃이 정한 폭을 그대로 굳힌다.
 * (수동 폭을 잠깐 걷어내고 다시 재는 방식이라 별도 텍스트 측정이 필요 없다.)
 */
export function autoFitColumnWidths(table: HTMLTableElement): number[] {
    const snapshot = snapshotTableSizing(table);
    removeColgroup(table);
    table.style.tableLayout = '';
    table.style.width = '';
    table.style.maxWidth = '';
    let measured: number[] = [];
    try {
        measured = measureColumnWidths(table);
    } finally {
        restoreTableSizing(table, snapshot);
    }
    return measured.map((w) => clampColWidth(w) ?? TABLE_SIZING_LIMITS.minColWidth);
}

// ────────────────────────────── Undo 스냅샷 ──────────────────────────────

export interface TableSizingSnapshot {
    colWidths: (number | null)[];
    rowMinHeights: (number | null)[];
}

/** Drag 시작 직전 크기. Ctrl+Z 한 번으로 여기로 되돌린다. */
export function snapshotTableSizing(table: HTMLTableElement): TableSizingSnapshot {
    return {
        colWidths: readColWidths(table),
        rowMinHeights: readRowMinHeights(table),
    };
}

export function restoreTableSizing(table: HTMLTableElement, snapshot: TableSizingSnapshot): void {
    writeColWidths(table, snapshot.colWidths.some((w) => w !== null) ? snapshot.colWidths : null);
    const rows = ownTableRows(table);
    rows.forEach((row, index) => {
        writeRowMinHeight(row, snapshot.rowMinHeights[index] ?? null);
    });
    applyTableSizing(table);
}

/** 두 스냅샷이 같은가(변화 없는 Drag 는 Undo 기록을 남기지 않기 위해). */
export function sameTableSizing(a: TableSizingSnapshot, b: TableSizingSnapshot): boolean {
    const equal = (x: (number | null)[], y: (number | null)[]) =>
        x.length === y.length && x.every((value, index) => value === y[index]);
    return equal(a.colWidths, b.colWidths) && equal(a.rowMinHeights, b.rowMinHeights);
}
