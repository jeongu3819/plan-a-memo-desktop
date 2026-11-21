/**
 * [PLAN-A Memo Desktop] 표 행·열 삭제 — 순수 DOM 유틸(화면 상태 없음).
 *
 * 원칙
 *  - **남는 셀은 같은 노드 그대로** 둔다(글자·서식·이미지·링크·셀 style 을 다시 쓰지 않는다). 바뀌는 것은
 *    지운 행/셀/`<col>` 과, 지운 범위에 걸친 병합 셀의 rowspan/colspan 숫자, 표의 런타임 폭 style 뿐이다.
 *  - 모든 변경은 `DomEdit` 에 기록한다. 되돌리기는 **같은 노드 객체**를 제자리에 다시 넣는다 — 그래서
 *    되돌린 뒤의 DOM 이 지우기 전과 노드 단위로 같고, 브라우저 기본 Undo(타이핑 이력)도 계속 맞는다.
 *  - 병합 셀은 서버 sanitizer(`_normalize_table_spans`)와 같은 모양으로 남긴다: rowspan 은 자기 행 묶음
 *    (thead/tbody/tfoot) 안, 겹침 없음, 값이 1 이 되면 속성을 지운다 → 서버가 다시 고칠 것이 없다.
 *  - 겹친 병합(잘못된 HTML)처럼 결과를 장담할 수 없는 표, 마지막 남은 행·열을 지우는 것(= 표가 사라짐)은
 *    **바꾸지 않고** 이유를 돌려준다.
 */
import { ownTableRows, readColWidths } from './tableResize';

/** 이 값보다 큰 rowspan/colspan 은 비정상 표로 본다(서버 허용 상한과 같다). */
const MAX_SPAN = 64;
/** 방어적 상한 — 이보다 큰 표는 구조 편집을 하지 않는다. */
const MAX_GRID_COLUMNS = 1000;

export interface StructureCell {
    el: HTMLTableCellElement;
    row: number;
    col: number;
    rowSpan: number;
    colSpan: number;
}

export interface StructureGrid {
    table: HTMLTableElement;
    rows: HTMLTableRowElement[];
    /** 격자 [행][열] → 그 칸을 덮는 셀(없으면 null — 짧은 행). */
    grid: (StructureCell | null)[][];
    cells: StructureCell[];
    columns: number;
    /** 겹친 병합 등 안전하게 다룰 수 없는 구조라면 그 이유. */
    problem: string | null;
}

export const TABLE_STRUCTURE_MESSAGES = {
    lastRow: '표의 마지막 행은 삭제할 수 없습니다.',
    lastColumn: '표의 마지막 열은 삭제할 수 없습니다.',
    overlap: '병합된 셀이 서로 겹친 표라 행·열을 안전하게 지울 수 없어요.',
    tooLarge: '표가 너무 커서 행·열을 지울 수 없어요.',
    nothing: '지울 행·열이 없어요.',
    unavailable: '지금은 행·열을 지울 수 없어요. 잠시 뒤 다시 해 주세요.',
} as const;

function ownRowCells(row: Element): HTMLTableCellElement[] {
    return Array.from(row.children)
        .filter((c) => c.tagName === 'TD' || c.tagName === 'TH') as HTMLTableCellElement[];
}

function spanOf(cell: Element, name: 'rowspan' | 'colspan'): number {
    const raw = cell.getAttribute(name);
    if (raw === null || raw.trim() === '') return 1;
    const value = parseInt(raw, 10);
    if (!Number.isFinite(value) || value < 0) return 1;
    // rowspan="0" = 행 묶음 끝까지(HTML 표 모델). colspan="0" 은 1 로 다룬다.
    if (value === 0) return name === 'rowspan' ? Number.POSITIVE_INFINITY : 1;
    return value;
}

/** 행이 속한 묶음(thead/tbody/tfoot, 없으면 table). rowspan 은 이 경계를 넘지 않는다. */
function rowGroupOf(row: HTMLTableRowElement): Element | null {
    return row.parentElement;
}

/**
 * rowspan/colspan 을 펼친 격자. 행 순서는 `ownTableRows`(DOM 순서)와 같다 — 크기 조절과 같은 번호를 쓴다.
 * rowspan 은 자기 행 묶음 끝에서 자른다(브라우저·서버와 같은 해석). 겹침이 있으면 `problem` 을 채운다.
 */
export function buildStructureGrid(table: HTMLTableElement): StructureGrid {
    const rows = ownTableRows(table);
    const grid: (StructureCell | null)[][] = rows.map(() => []);
    const cells: StructureCell[] = [];
    let columns = 0;
    let problem: string | null = null;

    // 행 묶음마다 마지막 행 번호(rowspan 을 자를 경계).
    const groupEnd: number[] = new Array(rows.length).fill(rows.length - 1);
    for (let r = rows.length - 1; r >= 0; r -= 1) {
        const next = rows[r + 1];
        groupEnd[r] = next && rowGroupOf(next) === rowGroupOf(rows[r]) ? groupEnd[r + 1] : r;
    }

    rows.forEach((row, r) => {
        let c = 0;
        ownRowCells(row).forEach((el) => {
            while (grid[r][c]) c += 1;
            const declaredRows = spanOf(el, 'rowspan');
            const declaredCols = spanOf(el, 'colspan');
            if ((Number.isFinite(declaredRows) && declaredRows > MAX_SPAN) || declaredCols > MAX_SPAN) {
                problem = problem ?? TABLE_STRUCTURE_MESSAGES.overlap;
            }
            const rowSpan = Math.max(1, Math.min(declaredRows, groupEnd[r] - r + 1));
            const colSpan = Math.max(1, Math.min(declaredCols, MAX_SPAN));
            const cell: StructureCell = { el, row: r, col: c, rowSpan, colSpan };
            cells.push(cell);
            for (let dr = 0; dr < rowSpan; dr += 1) {
                for (let dc = 0; dc < colSpan; dc += 1) {
                    if (grid[r + dr][c + dc]) problem = problem ?? TABLE_STRUCTURE_MESSAGES.overlap;
                    else grid[r + dr][c + dc] = cell;
                }
            }
            c += colSpan;
            columns = Math.max(columns, c);
        });
        columns = Math.max(columns, grid[r].length);
    });
    if (columns > MAX_GRID_COLUMNS) problem = problem ?? TABLE_STRUCTURE_MESSAGES.tooLarge;
    return { table, rows, grid, cells, columns, problem };
}

/** 표의 (행 수, 열 수). */
export function tableShape(table: HTMLTableElement): { rows: number; columns: number } {
    const g = buildStructureGrid(table);
    return { rows: g.rows.length, columns: g.columns };
}

// ────────────────────────────── 변경 기록 ──────────────────────────────

type DomOp =
    | { kind: 'remove'; node: Node; parent: Node; next: Node | null }
    | { kind: 'insert'; node: Node; parent: Node; next: Node | null }
    | { kind: 'attr'; el: Element; name: string; before: string | null; after: string | null };

function writeAttr(el: Element, name: string, value: string | null): void {
    if (value === null) el.removeAttribute(name);
    else el.setAttribute(name, value);
}

/**
 * DOM 변경을 적용하면서 기록한다. `undo()` 는 거꾸로, `redo()` 는 순서대로 다시 적용한다.
 * 노드를 복제하지 않고 같은 객체를 옮기므로 되돌린 DOM 이 원래 노드 그대로다.
 */
export class DomEdit {
    private readonly ops: DomOp[] = [];

    get size(): number {
        return this.ops.length;
    }

    remove(node: Node): void {
        const parent = node.parentNode;
        if (!parent) return;
        this.ops.push({ kind: 'remove', node, parent, next: node.nextSibling });
        parent.removeChild(node);
    }

    insertBefore(parent: Node, node: Node, next: Node | null): void {
        this.ops.push({ kind: 'insert', node, parent, next });
        parent.insertBefore(node, next);
    }

    setAttr(el: Element, name: string, value: string | null): void {
        const before = el.getAttribute(name);
        if (before === value) return;
        this.ops.push({ kind: 'attr', el, name, before, after: value });
        writeAttr(el, name, value);
    }

    undo(): void {
        for (let i = this.ops.length - 1; i >= 0; i -= 1) {
            const op = this.ops[i];
            if (op.kind === 'remove') op.parent.insertBefore(op.node, op.next);
            else if (op.kind === 'insert') op.node.parentNode?.removeChild(op.node);
            else writeAttr(op.el, op.name, op.before);
        }
    }

    redo(): void {
        this.ops.forEach((op) => {
            if (op.kind === 'remove') op.node.parentNode?.removeChild(op.node);
            else if (op.kind === 'insert') op.parent.insertBefore(op.node, op.next);
            else writeAttr(op.el, op.name, op.after);
        });
    }
}

// ────────────────────────────── 계획 / 적용 ──────────────────────────────

export type StructureKind = 'row' | 'col';

export type StructureCheck = { ok: true } | { ok: false; reason: string };

function uniqueSorted(indices: number[]): number[] {
    return Array.from(new Set(indices.filter((i) => Number.isInteger(i) && i >= 0))).sort((a, b) => a - b);
}

/** 지울 수 있는가(바꾸기 전에 메뉴를 끄고 이유를 보여 주는 데 쓴다). */
export function checkStructureDeletion(
    table: HTMLTableElement,
    kind: StructureKind,
    indices: number[],
): StructureCheck {
    const g = buildStructureGrid(table);
    if (g.problem) return { ok: false, reason: g.problem };
    const total = kind === 'row' ? g.rows.length : g.columns;
    const targets = uniqueSorted(indices).filter((i) => i < total);
    if (targets.length === 0) return { ok: false, reason: TABLE_STRUCTURE_MESSAGES.nothing };
    if (targets.length >= total) {
        return { ok: false, reason: kind === 'row' ? TABLE_STRUCTURE_MESSAGES.lastRow : TABLE_STRUCTURE_MESSAGES.lastColumn };
    }
    return { ok: true };
}

function setSpan(edit: DomEdit, el: Element, name: 'rowspan' | 'colspan', value: number): void {
    edit.setAttr(el, name, value > 1 ? String(value) : null);
}

/** 표의 런타임 폭(style)을 남은 열 너비 합에 맞춘다 — 저장 HTML 에는 남지 않는 값(sanitizer 가 지운다). */
function refreshRuntimeWidth(edit: DomEdit, table: HTMLTableElement): void {
    // 크기 계약(data-col-width)이 있는 표만 — 자동 맞춤 표는 손대지 않는다. 규칙은 applyTableSizing 과 같다
    // (모든 열에 폭이 있으면 합계 px, 아니면 100%). 스크롤 상자(wrapper)는 건드리지 않는다.
    const widths = readColWidths(table);
    if (!widths.some((w) => w !== null)) return;
    const complete = widths.every((w) => w !== null);
    const total = widths.reduce<number>((sum, w) => sum + (w ?? 0), 0);
    const next = complete && total > 0 ? `${total}px` : '100%';
    if (table.style.width === next) return;
    const before = table.getAttribute('style');
    table.style.width = next;
    const after = table.getAttribute('style');
    writeAttr(table, 'style', before);
    edit.setAttr(table, 'style', after);
}

function deleteRows(g: StructureGrid, targets: number[], edit: DomEdit): void {
    const removed = new Set(targets);
    // 1) 지우는 범위에 걸친 병합 셀 — rowspan 을 줄이고, 시작 행이 지워지면 다음 남는 행으로 옮긴다.
    const moves: { cell: StructureCell; to: number }[] = [];
    g.cells.forEach((cell) => {
        let gone = 0;
        for (let r = cell.row; r < cell.row + cell.rowSpan; r += 1) if (removed.has(r)) gone += 1;
        if (gone === 0 || gone === cell.rowSpan) return; // 그대로 / 행과 함께 사라짐
        setSpan(edit, cell.el, 'rowspan', cell.rowSpan - gone);
        if (removed.has(cell.row)) {
            let to = cell.row + 1;
            while (removed.has(to)) to += 1;
            moves.push({ cell, to });
        }
    });
    // 같은 행으로 옮기는 셀은 열 순서대로 넣는다 → 앞에 넣은 셀 뒤에 다음 셀이 온다.
    moves.sort((a, b) => a.to - b.to || a.cell.col - b.cell.col);
    moves.forEach(({ cell, to }) => {
        const row = g.rows[to];
        const anchor = g.cells.find((other) => other.row === to && other.col > cell.col)?.el ?? null;
        edit.remove(cell.el);
        edit.insertBefore(row, cell.el, anchor && anchor.parentNode === row ? anchor : null);
    });
    // 2) 행을 지운다(행의 최소 높이 data 속성도 행과 함께 사라진다).
    const groups = new Set<Element>();
    targets.forEach((index) => {
        const row = g.rows[index];
        const group = rowGroupOf(row);
        if (group && group !== g.table) groups.add(group);
        edit.remove(row);
    });
    // 3) 행이 모두 빠진 thead/tbody/tfoot 은 빈 껍데기로 남기지 않는다.
    groups.forEach((group) => {
        if (!Array.from(group.children).some((c) => c.tagName === 'TR')) edit.remove(group);
    });
}

function deleteColumns(g: StructureGrid, targets: number[], edit: DomEdit): void {
    const removed = new Set(targets);
    g.cells.forEach((cell) => {
        let gone = 0;
        for (let c = cell.col; c < cell.col + cell.colSpan; c += 1) if (removed.has(c)) gone += 1;
        if (gone === 0) return;
        if (gone === cell.colSpan) edit.remove(cell.el);
        else setSpan(edit, cell.el, 'colspan', cell.colSpan - gone);
    });
    // 열 너비 계약(<col data-col-width>)도 같은 열을 뺀다. <col> 은 span 없이 열 하나씩이다(sanitizer 계약).
    const colgroup = Array.from(g.table.children).find((c) => c.tagName === 'COLGROUP');
    if (colgroup) {
        const cols = Array.from(colgroup.children).filter((c) => c.tagName === 'COL');
        targets.forEach((index) => { if (cols[index]) edit.remove(cols[index]); });
        if (!Array.from(colgroup.children).some((c) => c.tagName === 'COL')) edit.remove(colgroup);
    }
    refreshRuntimeWidth(edit, g.table);
}

export type StructureResult =
    | { ok: true; edit: DomEdit; kind: StructureKind; count: number }
    | { ok: false; reason: string };

/**
 * 행(또는 열)을 지운다. 지울 수 없으면 DOM 을 바꾸지 않고 이유를 돌려준다.
 * 돌려준 `edit` 으로 Undo(`edit.undo()`) / Redo(`edit.redo()`) 한다.
 */
export function deleteTableStructure(
    table: HTMLTableElement,
    kind: StructureKind,
    indices: number[],
): StructureResult {
    const check = checkStructureDeletion(table, kind, indices);
    if (!check.ok) return check;
    const g = buildStructureGrid(table);
    const total = kind === 'row' ? g.rows.length : g.columns;
    const targets = uniqueSorted(indices).filter((i) => i < total);
    const edit = new DomEdit();
    if (kind === 'row') deleteRows(g, targets, edit);
    else deleteColumns(g, targets, edit);
    return { ok: true, edit, kind, count: targets.length };
}

// ────────────────────────────── 좌표 ──────────────────────────────

export interface Band {
    /** 행이면 top/bottom, 열이면 left/right(뷰포트 좌표). */
    start: number;
    end: number;
}

/** 각 행의 세로 범위(DOM 순서 = 격자 행 번호). */
export function rowBands(table: HTMLTableElement): Band[] {
    return ownTableRows(table).map((row) => {
        const rect = row.getBoundingClientRect();
        return { start: rect.top, end: rect.bottom };
    });
}

/**
 * 각 열의 가로 범위. 병합 셀만 있는 열도 맞게 — 열마다 "그 열 하나만 덮는 셀" 을 찾아 재고,
 * 없으면 병합 셀 폭을 나눈다.
 */
export function columnBands(table: HTMLTableElement): Band[] {
    const g = buildStructureGrid(table);
    if (g.columns === 0) return [];
    const lefts: (number | null)[] = new Array(g.columns + 1).fill(null);
    g.cells.forEach((cell) => {
        const rect = cell.el.getBoundingClientRect();
        if (lefts[cell.col] === null) lefts[cell.col] = rect.left;
        if (lefts[cell.col + cell.colSpan] === null) lefts[cell.col + cell.colSpan] = rect.right;
    });
    const tableRect = table.getBoundingClientRect();
    if (lefts[0] === null) lefts[0] = tableRect.left;
    if (lefts[g.columns] === null) lefts[g.columns] = tableRect.right;
    // 비어 있는 경계는 앞뒤 아는 경계 사이를 고르게 나눈다.
    for (let i = 1; i < g.columns; i += 1) {
        if (lefts[i] !== null) continue;
        let j = i + 1;
        while (lefts[j] === null) j += 1;
        const from = lefts[i - 1] as number;
        const to = lefts[j] as number;
        for (let k = i; k < j; k += 1) lefts[k] = from + ((to - from) * (k - i + 1)) / (j - i + 1);
    }
    const bands: Band[] = [];
    for (let i = 0; i < g.columns; i += 1) bands.push({ start: lefts[i] as number, end: lefts[i + 1] as number });
    return bands;
}

/** 좌표가 들어간 band 번호. 범위 밖이면 가장 가까운 끝(끌기 중 표 밖으로 나가도 끝 행·열). */
export function bandIndexAt(bands: Band[], position: number, clamp = false): number {
    for (let i = 0; i < bands.length; i += 1) {
        if (position >= bands[i].start && position < bands[i].end) return i;
    }
    if (!clamp || bands.length === 0) return -1;
    return position < bands[0].start ? 0 : bands.length - 1;
}

/** 셀이 덮는 격자 범위(병합 셀이면 여러 행·열). */
export function cellExtent(table: HTMLTableElement, cell: HTMLTableCellElement): StructureCell | null {
    return buildStructureGrid(table).cells.find((c) => c.el === cell) ?? null;
}
