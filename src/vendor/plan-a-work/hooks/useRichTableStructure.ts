import { useCallback, useEffect, useRef, useState } from 'react';
import type { RichTextMenuAction } from '../components/RichTextContextMenu';
import {
    type Band,
    type StructureKind,
    type DomEdit,
    bandIndexAt,
    buildStructureGrid,
    checkStructureDeletion,
    columnBands,
    deleteTableStructure,
    rowBands,
    TABLE_STRUCTURE_MESSAGES,
} from '../utils/tableStructure';

/**
 * [PLAN-A Memo Desktop] 표 행·열 선택과 삭제 — 편집 동작(상태·키·Undo). 그리기는 RichTableStructureOverlay.
 *
 *  - 표에 마우스를 올리면 그 행의 왼쪽 테두리·그 열의 위쪽 테두리에만 작은 핸들이 뜬다. 누르면 행/열 선택,
 *    끌면 범위, Shift+누르기는 범위 늘리기. 선택 강조는 화면 위 덧그림(position fixed)이라 **편집 DOM·저장 HTML
 *    에 아무것도 넣지 않는다.**
 *  - 행·열이 선택된 동안에만 Delete 가 구조를 지운다. 글자를 고른 상태·커서만 있는 상태의 Delete 는 그대로(글자).
 *    선택 중 Esc = 선택만 해제(편집은 계속). 다른 키·클릭은 선택을 풀고 원래대로 동작한다.
 *  - Undo/Redo 는 **브라우저 기본 편집 이력 하나**로 이어진다(Ctrl+Z 를 가로채지 않는다). 구조를 지울 때 편집기 옆의
 *    보이지 않는 편집 칸(sentinel)에 표식 한 개를 기본 명령(insertHTML)으로 넣어 기본 이력에 '자리' 를 남긴다. 사용자의
 *    Ctrl+Z/Ctrl+Y 가 그 자리를 되돌리거나 다시 하면 표식이 사라지거나 돌아오고, MutationObserver 가 그것을 보고
 *    같은 순간에 구조 변경을 되돌리거나 다시 적용한다(같은 노드를 제자리로 — HTML 을 덮어쓰지 않는다). 그래서
 *    "행 삭제 → 글자 입력 → Ctrl+Z(글자) → Ctrl+Z(행 복원) → Ctrl+Y(행 삭제)" 가 다른 문서 편집기처럼 이어지고,
 *    Undo 뒤 새로 편집하면 브라우저가 Redo 이력을 버리므로 구조 Redo 도 함께 사라진다.
 *  - 이 훅은 DOM 만 바꾸고 저장은 `onCommit`(= 편집기 emit) 에 맡긴다 → 기존 저장·Sync 경로 그대로.
 */

export interface TableStructureSelection {
    table: HTMLTableElement;
    kind: StructureKind;
    /** 포함 범위 [start, end] (start ≤ end). */
    start: number;
    end: number;
}

export interface TableStructureHover {
    table: HTMLTableElement;
    row: number;
    col: number;
}

interface Options {
    editorRef: React.RefObject<HTMLElement | null>;
    disabled?: boolean;
    /** DOM 을 바꾼 뒤(지우기·Undo·Redo) 한 번 — 저장. */
    onCommit: () => void;
    /** 구조가 바뀐 표(크기 조절 이력 정리·표 도구 위치 갱신용). */
    onStructureChanged?: (table: HTMLTableElement) => void;
    onWarning?: (message: string) => void;
}

interface HistoryEntry {
    /** sentinel 표식 번호. */
    id: number;
    edit: DomEdit;
    table: HTMLTableElement;
    kind: StructureKind;
    start: number;
    /** 지금 DOM 에 적용돼 있는가(Undo 되면 false). */
    applied: boolean;
}

/** 오래된 구조 이력은 이만큼만 기억한다(브라우저 기본 이력도 유한하다). */
const MAX_HISTORY_ENTRIES = 300;
const sentinelToken = (id: number) => `#${id};`;
const SENTINEL_TOKEN_RE = /#(\d+);/g;

/** sentinel 글자에서 지금 남아 있는(= 기본 이력상 '적용된') 표식 번호. */
export function sentinelIds(text: string): Set<number> {
    const ids = new Set<number>();
    for (const match of text.matchAll(SENTINEL_TOKEN_RE)) ids.add(Number(match[1]));
    return ids;
}

/**
 * 기본 이력(표식이 남아 있는가)과 구조 이력(적용돼 있는가)을 맞춘다 — 되돌릴 것은 최근 것부터, 다시 할 것은
 * 오래된 것부터(브라우저 이력의 순서와 같다).
 */
export function reconcileStructureHistory(
    entries: { id: number; applied: boolean }[],
    present: Set<number>,
): { undo: number[]; redo: number[] } {
    const undo = entries.filter(e => e.applied && !present.has(e.id)).map(e => e.id).sort((a, b) => b - a);
    const redo = entries.filter(e => !e.applied && present.has(e.id)).map(e => e.id).sort((a, b) => a - b);
    return { undo, redo };
}

interface DragState {
    table: HTMLTableElement;
    kind: StructureKind;
    anchor: number;
}

const HOVER_CLEAR_DELAY_MS = 160;
/** 행·열 좌표는 손을 움직일 때마다 쓰이지만 큰 표에서 매번 재면 버벅인다(크기 조절과 같은 방식). */
const BANDS_CACHE_TTL_MS = 200;

interface BandsCache {
    table: HTMLTableElement;
    rows: Band[];
    cols: Band[];
    at: number;
}

export function selectionCount(selection: TableStructureSelection | null): number {
    return selection ? selection.end - selection.start + 1 : 0;
}

function indicesOf(selection: TableStructureSelection): number[] {
    const out: number[] = [];
    for (let i = selection.start; i <= selection.end; i += 1) out.push(i);
    return out;
}

/** 삭제 메뉴 문구. 하나면 개수를 붙이지 않는다. */
export function structureDeleteLabel(kind: StructureKind, count: number, fromSelection: boolean): string {
    const noun = kind === 'row' ? '행' : '열';
    if (!fromSelection) return `현재 ${noun} 삭제`;
    return count > 1 ? `선택한 ${noun} 삭제 (${count}개)` : `선택한 ${noun} 삭제`;
}

export function useRichTableStructure({ editorRef, disabled, onCommit, onStructureChanged, onWarning }: Options) {
    const [hover, setHover] = useState<TableStructureHover | null>(null);
    const [selection, setSelection] = useState<TableStructureSelection | null>(null);
    // 스크롤·창 크기 변경 → 덧그림 위치 다시 계산.
    const [layoutVersion, setLayoutVersion] = useState(0);
    const selectionRef = useRef<TableStructureSelection | null>(null);
    selectionRef.current = selection;
    const dragRef = useRef<DragState | null>(null);
    const hoverTimer = useRef<number | null>(null);
    const history = useRef<HistoryEntry[]>([]);
    const nextId = useRef(0);
    /** 편집기 옆의 보이지 않는 편집 칸 — 기본 Undo 이력에 구조 변경 자리를 남긴다. 편집기가 그린다. */
    const sentinelRef = useRef<HTMLDivElement>(null);
    /** 지금 sentinel 에 표식을 넣는 중(그때 생기는 포커스 이동은 무시). */
    const recording = useRef(false);
    const bandsCache = useRef<BandsCache | null>(null);

    const bandsOf = useCallback((table: HTMLTableElement): BandsCache => {
        const cached = bandsCache.current;
        const now = Date.now();
        if (cached && cached.table === table && now - cached.at < BANDS_CACHE_TTL_MS) return cached;
        const fresh = { table, rows: rowBands(table), cols: columnBands(table), at: now };
        bandsCache.current = fresh;
        return fresh;
    }, []);
    const invalidateBands = useCallback(() => { bandsCache.current = null; }, []);

    const cancelHoverClear = useCallback(() => {
        if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
        hoverTimer.current = null;
    }, []);
    const scheduleHoverClear = useCallback(() => {
        cancelHoverClear();
        // 셀에서 핸들로 옮겨 가는 사이(편집기 밖으로 잠깐 나감)에 사라지지 않게.
        hoverTimer.current = window.setTimeout(() => {
            hoverTimer.current = null;
            if (!dragRef.current) setHover(null);
        }, HOVER_CLEAR_DELAY_MS);
    }, [cancelHoverClear]);
    useEffect(() => () => cancelHoverClear(), [cancelHoverClear]);

    const clearSelection = useCallback(() => {
        dragRef.current = null;
        setSelection(prev => (prev ? null : prev));
    }, []);

    /** 외부 value 로 본문을 새로 채웠을 때 — 이전 DOM 을 가리키는 상태·이력을 모두 버린다. */
    const reset = useCallback(() => {
        history.current = [];
        dragRef.current = null;
        bandsCache.current = null;
        cancelHoverClear();
        setHover(null);
        setSelection(null);
    }, [cancelHoverClear]);

    /** 사용자가 내용을 입력했다 — 선택만 푼다. 구조 이력은 기본 Undo 이력 안에 그대로 이어진다. */
    const notifyContentChanged = useCallback(() => {
        bandsCache.current = null;
        clearSelection();
    }, [clearSelection]);

    useEffect(() => { if (disabled) reset(); }, [disabled, reset]);

    // 선택·핸들이 떠 있는 동안 스크롤/크기 변경을 따라간다. 스크롤 중 hover 핸들은 숨긴다.
    useEffect(() => {
        if (!selection && !hover) return undefined;
        const onScroll = () => {
            invalidateBands();
            if (!dragRef.current) setHover(null);
            setLayoutVersion(v => v + 1);
        };
        const onResize = () => { invalidateBands(); setLayoutVersion(v => v + 1); };
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onResize);
        };
    }, [selection, hover, invalidateBands]);

    // 편집기 바깥을 누르면 선택을 푼다(우클릭 메뉴·핸들은 예외).
    useEffect(() => {
        if (!selection) return undefined;
        const dismiss = (event: PointerEvent) => {
            const target = event.target as Element | null;
            if (target?.closest?.('[data-table-structure-ui="1"], [data-testid="rich-text-context-menu"], .MuiPopover-root')) return;
            if (target && editorRef.current?.contains(target)) return; // 편집기 안은 handleEditorPointerDown 이 정한다
            clearSelection();
        };
        document.addEventListener('pointerdown', dismiss, true);
        return () => document.removeEventListener('pointerdown', dismiss, true);
    }, [selection, editorRef, clearSelection]);

    // 표가 사라졌거나(다른 편집) 범위가 표 밖이면 선택을 버린다.
    useEffect(() => {
        if (!selection) return;
        const { table, kind, end } = selection;
        const root = editorRef.current;
        if (!table.isConnected || !root?.contains(table)) { clearSelection(); return; }
        const g = buildStructureGrid(table);
        if (end >= (kind === 'row' ? g.rows.length : g.columns)) clearSelection();
    }, [selection, layoutVersion, editorRef, clearSelection]);

    // ── hover ──
    const tableAt = useCallback((target: EventTarget | null): HTMLTableElement | null => {
        const root = editorRef.current;
        const el = target instanceof Element ? target : null;
        const table = el?.closest?.('table') as HTMLTableElement | null;
        return table && root && root.contains(table) ? table : null;
    }, [editorRef]);

    const handleEditorPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
        if (disabled || dragRef.current || event.buttons !== 0) return;
        const table = tableAt(event.target);
        if (!table) {
            if (hover) scheduleHoverClear();
            return;
        }
        const bands = bandsOf(table);
        const row = bandIndexAt(bands.rows, event.clientY);
        const col = bandIndexAt(bands.cols, event.clientX);
        if (row < 0 || col < 0) return;
        cancelHoverClear();
        setHover(prev => (prev && prev.table === table && prev.row === row && prev.col === col
            ? prev
            : { table, row, col }));
    }, [disabled, tableAt, hover, scheduleHoverClear, cancelHoverClear, bandsOf]);

    const handleEditorPointerLeave = useCallback(() => {
        if (!dragRef.current) scheduleHoverClear();
    }, [scheduleHoverClear]);

    // ── 선택 ──
    /**
     * 구조 선택을 시작할 때: 편집기 포커스는 그대로(키를 받기 위해) 두고, 글자 선택이 있으면 접는다 —
     * 화면에 '글자 선택' 과 '행·열 선택' 이 동시에 보이지 않게.
     */
    const settleCaret = useCallback((table: HTMLTableElement) => {
        const root = editorRef.current;
        if (!root) return;
        if (document.activeElement !== root) root.focus({ preventScroll: true });
        const sel = window.getSelection();
        if (!sel) return;
        const inside = sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).commonAncestorContainer);
        if (inside) {
            if (!sel.isCollapsed) sel.collapseToEnd();
            return;
        }
        const cell = table.querySelector('td, th');
        const range = document.createRange();
        range.selectNodeContents(cell ?? table);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    }, [editorRef]);

    const select = useCallback((table: HTMLTableElement, kind: StructureKind, anchor: number, current: number) => {
        setSelection({ table, kind, start: Math.min(anchor, current), end: Math.max(anchor, current) });
    }, []);

    const handleMove = useCallback((event: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag || !drag.table.isConnected) return;
        const cached = bandsOf(drag.table);
        const bands = drag.kind === 'row' ? cached.rows : cached.cols;
        const index = bandIndexAt(bands, drag.kind === 'row' ? event.clientY : event.clientX, true);
        if (index >= 0) select(drag.table, drag.kind, drag.anchor, index);
    }, [select, bandsOf]);

    useEffect(() => {
        const up = () => { dragRef.current = null; };
        window.addEventListener('pointermove', handleMove);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        return () => {
            window.removeEventListener('pointermove', handleMove);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
        };
    }, [handleMove]);

    /** 핸들을 눌렀다 — 선택 시작(끌면 범위). Shift 면 같은 표·같은 종류의 기존 선택에서 늘린다. */
    const handleHandlePointerDown = useCallback((
        event: React.PointerEvent<HTMLElement>,
        table: HTMLTableElement,
        kind: StructureKind,
        index: number,
    ) => {
        if (disabled) return;
        // 편집기 포커스·캐럿이 핸들로 넘어가지 않게 한다.
        event.preventDefault();
        event.stopPropagation();
        if (event.button !== 0) {
            // 우클릭: 선택 밖 핸들이면 그 줄을 고른 뒤 메뉴(onContextMenu)가 뜬다.
            const current = selectionRef.current;
            const inside = current && current.table === table && current.kind === kind
                && index >= current.start && index <= current.end;
            if (!inside) select(table, kind, index, index);
            settleCaret(table);
            return;
        }
        const current = selectionRef.current;
        const anchor = event.shiftKey && current && current.table === table && current.kind === kind
            ? (index < current.start ? current.end : current.start)
            : index;
        dragRef.current = { table, kind, anchor };
        select(table, kind, anchor, index);
        settleCaret(table);
    }, [disabled, select, settleCaret]);

    /**
     * 편집기 본문을 눌렀다. 왼쪽 클릭은 언제나 구조 선택을 푼다(글자 편집으로 돌아감).
     * 우클릭은 선택한 행/열 안이면 선택을 유지한다(메뉴에서 '선택한 … 삭제').
     */
    const handleEditorPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
        const current = selectionRef.current;
        if (!current) return;
        if (event.button === 2) {
            const cell = (event.target as Element | null)?.closest?.('td, th') as HTMLTableCellElement | null;
            if (cell && current.table.contains(cell) && pointInSelection(current, event.clientX, event.clientY)) return;
        }
        clearSelection();
    }, [clearSelection]);

    // ── 지우기 ──
    const placeCaretNear = useCallback((table: HTMLTableElement, kind: StructureKind, index: number) => {
        const root = editorRef.current;
        if (!root || !table.isConnected) return;
        const g = buildStructureGrid(table);
        const row = kind === 'row' ? Math.min(index, g.rows.length - 1) : 0;
        const col = kind === 'col' ? Math.min(index, g.columns - 1) : 0;
        const cell = g.grid[row]?.[col]?.el ?? table.querySelector('td, th');
        if (document.activeElement !== root) root.focus({ preventScroll: true });
        const sel = window.getSelection();
        if (!sel || !cell) return;
        const range = document.createRange();
        range.selectNodeContents(cell);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    }, [editorRef]);

    /**
     * 기본 Undo 이력에 구조 변경 자리를 남긴다: sentinel 끝에 표식을 insertHTML(브라우저 기본 명령 1단계, 타이핑과
     * 합쳐지지 않는다). 포커스는 잠깐 sentinel 로 갔다가 호출자가 편집기로 돌려놓는다.
     */
    const recordNativeStep = useCallback((id: number): boolean => {
        const box = sentinelRef.current;
        const sel = window.getSelection();
        if (!box || !sel) return false;
        recording.current = true;
        try {
            box.focus({ preventScroll: true });
            const range = document.createRange();
            range.selectNodeContents(box);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
            let ok = false;
            try { ok = document.execCommand('insertHTML', false, sentinelToken(id)); } catch { ok = false; }
            return ok && sentinelIds(box.textContent || '').has(id);
        } finally {
            recording.current = false;
        }
    }, []);

    const runDelete = useCallback((table: HTMLTableElement, kind: StructureKind, indices: number[]): boolean => {
        if (disabled || !table.isConnected) return false;
        const result = deleteTableStructure(table, kind, indices);
        if (!result.ok) {
            onWarning?.(result.reason);
            return false;
        }
        const start = Math.min(...indices);
        invalidateBands();
        const id = (nextId.current += 1);
        const entry: HistoryEntry = { id, edit: result.edit, table, kind, start, applied: true };
        history.current.push(entry);
        if (!recordNativeStep(id)) {
            // 기본 이력에 자리를 남기지 못하면 되돌릴 수 없는 삭제가 된다 — 바꾸지 않는다.
            result.edit.undo();
            history.current.pop();
            placeCaretNear(table, kind, start);
            onWarning?.(TABLE_STRUCTURE_MESSAGES.unavailable);
            return false;
        }
        if (history.current.length > MAX_HISTORY_ENTRIES) history.current.splice(0, history.current.length - MAX_HISTORY_ENTRIES);
        dragRef.current = null;
        setSelection(null);
        setHover(null);
        placeCaretNear(table, kind, start);
        onStructureChanged?.(table);
        onCommit();
        setLayoutVersion(v => v + 1);
        return true;
    }, [disabled, onWarning, placeCaretNear, onStructureChanged, onCommit, invalidateBands, recordNativeStep]);

    /**
     * 기본 Undo/Redo 가 sentinel 표식을 지우거나 되돌렸다 → 같은 구조 변경을 되돌리거나 다시 적용한다.
     * 기본 Undo 는 선택·포커스를 sentinel 로 옮기므로, 끝나면 편집기로 돌려놓는다.
     */
    const syncWithNativeHistory = useCallback(() => {
        const box = sentinelRef.current;
        const root = editorRef.current;
        if (!box || !root) return;
        const { undo, redo } = reconcileStructureHistory(history.current, sentinelIds(box.textContent || ''));
        const byId = new Map(history.current.map(e => [e.id, e]));
        let changed: HistoryEntry | null = null;
        const apply = (id: number, direction: 'undo' | 'redo') => {
            const entry = byId.get(id);
            if (!entry) return;
            entry.applied = direction === 'redo';
            // 그 사이 본문이 통째로 바뀐 표(다른 기기 내용 반영 등)는 건드리지 않는다.
            if (!entry.table.isConnected || !root.contains(entry.table)) return;
            if (direction === 'undo') entry.edit.undo();
            else entry.edit.redo();
            changed = entry;
        };
        undo.forEach(id => apply(id, 'undo'));
        redo.forEach(id => apply(id, 'redo'));
        const last = changed as HistoryEntry | null;
        if (last) {
            invalidateBands();
            dragRef.current = null;
            setSelection(null);
            setHover(null);
            placeCaretNear(last.table, last.kind, last.start);
            onStructureChanged?.(last.table);
            onCommit();
            setLayoutVersion(v => v + 1);
        } else if (document.activeElement === box) {
            root.focus({ preventScroll: true });
        }
    }, [editorRef, invalidateBands, placeCaretNear, onStructureChanged, onCommit]);

    // sentinel 은 contenteditable=""(= 편집 가능, HTML 표준)로 둔다 — 본문 편집기를 찾는 [contenteditable="true"] 에 걸리지 않게.
    useEffect(() => {
        const box = sentinelRef.current;
        if (!box) return;
        if (disabled) box.removeAttribute('contenteditable');
        else box.setAttribute('contenteditable', '');
    }, [disabled]);

    useEffect(() => {
        const box = sentinelRef.current;
        if (!box) return undefined;
        const observer = new MutationObserver(() => syncWithNativeHistory());
        observer.observe(box, { childList: true, characterData: true, subtree: true });
        return () => observer.disconnect();
    }, [syncWithNativeHistory]);

    /** sentinel 이 우리 기록 밖에서 포커스를 받으면(기본 Undo 의 선택 이동 등) 편집기로 돌려놓는다 — 글자가 그리로 가지 않게. */
    const handleSentinelFocus = useCallback(() => {
        if (recording.current) return;
        window.setTimeout(() => {
            const box = sentinelRef.current;
            const root = editorRef.current;
            if (box && root && document.activeElement === box) root.focus({ preventScroll: true });
        }, 0);
    }, [editorRef]);

    const deleteSelection = useCallback((): boolean => {
        const current = selectionRef.current;
        if (!current) return false;
        return runDelete(current.table, current.kind, indicesOf(current));
    }, [runDelete]);

    // ── 키 ──
    /** 처리했으면 true(호출자는 기본 동작을 하지 않는다). 구조 선택이 없으면 아무것도 하지 않는다. */
    const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>): boolean => {
        const current = selectionRef.current;
        if (!current) return false;
        const native = event.nativeEvent as KeyboardEvent | undefined;
        // 한글 조합 중(또는 조합 시작 키)은 손대지 않는다 — 선택만 풀고 IME 에 맡긴다.
        if (native?.isComposing || event.key === 'Process' || event.keyCode === 229) {
            clearSelection();
            return false;
        }
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return false;
        const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
        if (event.key === 'Delete' && plain && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            deleteSelection();
            return true;
        }
        if (event.key === 'Escape') {
            // 편집기를 닫지 않고 선택만 푼다(MemoRow 의 Esc 는 defaultPrevented 면 무시).
            event.preventDefault();
            event.stopPropagation();
            clearSelection();
            return true;
        }
        if (event.key === 'Backspace' && plain) {
            // 행·열이 선택된 동안의 Backspace 는 글자를 지우지 않는다(사용자가 고른 글자가 없다) — 선택만 해제.
            event.preventDefault();
            clearSelection();
            return true;
        }
        // 그 밖의 키(글자·방향키·Ctrl+A·Ctrl+Z 등)는 선택을 풀고 원래대로.
        clearSelection();
        return false;
    }, [clearSelection, deleteSelection]);

    // ── 우클릭 메뉴 ──
    const deleteAction = useCallback((
        table: HTMLTableElement,
        kind: StructureKind,
        indices: number[],
        fromSelection: boolean,
    ): RichTextMenuAction => {
        const check = checkStructureDeletion(table, kind, indices);
        return {
            key: `table-delete-${kind}`,
            label: structureDeleteLabel(kind, indices.length, fromSelection),
            onSelect: () => { runDelete(table, kind, indices); },
            disabled: !check.ok,
            disabledReason: check.ok ? undefined : check.reason,
        };
    }, [runDelete]);

    /**
     * 우클릭한 자리의 표 명령. 표 밖이면 null(메뉴에 '표 편집' 이 생기지 않는다).
     *  - 행·열이 선택돼 있고 그 안(또는 핸들)을 눌렀으면 → '선택한 행/열 삭제 (n개)'
     *  - 아니면 누른 칸의 → '현재 행 삭제' · '현재 열 삭제' (병합 셀은 누른 좌표의 행·열)
     */
    const tableActionsAt = useCallback((target: EventTarget | null, clientX: number, clientY: number): RichTextMenuAction[] | null => {
        if (disabled) return null;
        const el = target instanceof Element ? target : null;
        const current = selectionRef.current;
        if (current && current.table.isConnected
            && (el?.closest?.('[data-table-structure-ui="1"]') || pointInSelection(current, clientX, clientY))) {
            return [deleteAction(current.table, current.kind, indicesOf(current), true)];
        }
        const cell = el?.closest?.('td, th') as HTMLTableCellElement | null;
        const table = cell ? tableAt(cell) : null;
        if (!cell || !table || cell.closest('table') !== table) return null;
        const g = buildStructureGrid(table);
        const extent = g.cells.find(c => c.el === cell);
        if (!extent) return null;
        const within = (bands: { start: number; end: number }[], from: number, span: number, at: number) => {
            for (let i = from; i < from + span; i += 1) {
                if (bands[i] && at >= bands[i].start && at < bands[i].end) return i;
            }
            return from;
        };
        const row = within(rowBands(table), extent.row, extent.rowSpan, clientY);
        const col = within(columnBands(table), extent.col, extent.colSpan, clientX);
        return [deleteAction(table, 'row', [row], false), deleteAction(table, 'col', [col], false)];
    }, [disabled, deleteAction, tableAt]);

    return {
        hover,
        selection,
        layoutVersion,
        handleEditorPointerMove,
        handleEditorPointerLeave,
        handleEditorPointerDown,
        handleHandlePointerDown,
        cancelHoverClear,
        scheduleHoverClear,
        handleKeyDown,
        sentinelRef,
        handleSentinelFocus,
        tableActionsAt,
        deleteSelection,
        clearSelection,
        notifyContentChanged,
        reset,
        isDragging: () => dragRef.current !== null,
    };
}

/** 좌표가 선택한 행/열의 화면 범위 안인가. */
function pointInSelection(selection: TableStructureSelection, x: number, y: number): boolean {
    const rect = selection.table.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;
    const bands = selection.kind === 'row' ? rowBands(selection.table) : columnBands(selection.table);
    const index = bandIndexAt(bands, selection.kind === 'row' ? y : x);
    return index >= selection.start && index <= selection.end;
}

export type RichTableStructure = ReturnType<typeof useRichTableStructure>;
