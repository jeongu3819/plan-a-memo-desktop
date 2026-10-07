import { useCallback, useEffect, useRef, useState } from 'react';
import {
    BOUNDARY_HIT_SLOP,
    COLUMN_AUTOFIT,
    TABLE_SIZING_LIMITS,
    type ColumnBoundary,
    type RowBoundary,
    type TableSizingSnapshot,
    applyTableSizingStyles,
    autoFitColumnWidths,
    autoFitRowHeight,
    autoFitSingleColumn,
    clampRowMinHeight,
    columnBoundaries,
    evenColumnWidths,
    findBoundary,
    isTableManuallySized,
    measureColumnWidths,
    ownTableRows,
    resetTableSizing,
    resizeColumnAt,
    restoreTableSizing,
    rowBoundaries,
    sameTableSizing,
    snapshotTableSizing,
    tableColumnCount,
    writeColWidths,
    writeRowMinHeight,
} from '../utils/tableResize';

/**
 * Description 안의 표를 마우스로 다듬게 해 주는 편집 동작.
 *
 * 정책:
 *  - 평상시에는 아무 handle 도 보이지 않는다. 경계에 다가갔을 때만 안내선이 뜬다.
 *  - Drag 하는 동안은 미리보기만 하고, pointerup 에서 **한 번만** commit 한다.
 *    그래서 Ctrl+Z 한 번이면 Drag 한 번이 통째로 취소된다.
 *  - 행은 고정 높이가 아니라 최소 높이다(`tr { height }` 는 표에서 하한으로 동작).
 *
 * 이 훅은 편집기 DOM 만 만지고 저장은 하지 않는다. 실제 저장은 `onCommit`(= 에디터의
 * emit) 이 담당하므로, 「크게 편집」과 Task Details 가 같은 규칙을 공유한다.
 *
 * Description · 작업노트 · 메모가 **같은 훅**을 쓴다(`useRichTableResize`). 화면 부분은
 * `components/richTable/RichTableResizeOverlay`, 표 CSS 는 `utils/richTableSx` 가 맡는다.
 */

export type TableSizingCommand = 'fit-columns' | 'even-columns' | 'fit-rows' | 'reset';

export interface TableResizeGuide {
    kind: 'col' | 'row';
    left: number;
    top: number;
    width: number;
    height: number;
    dragging: boolean;
}

export interface ActiveTable {
    el: HTMLTableElement;
    rect: DOMRect;
    manuallySized: boolean;
}

interface Options {
    editorRef: React.RefObject<HTMLElement | null>;
    disabled?: boolean;
    /** 크기 변경이 확정됐을 때(= Drag 종료 / 명령 실행 / Undo) 한 번만 불린다. */
    onCommit: () => void;
}

interface BoundaryCache {
    table: HTMLTableElement;
    cols: ColumnBoundary[];
    rows: RowBoundary[];
    at: number;
}

interface HitTest {
    table: HTMLTableElement;
    kind: 'col' | 'row';
    index: number;
    position: number;
}

type DragState =
    | {
        kind: 'col';
        table: HTMLTableElement;
        index: number;
        startX: number;
        /** 표 내용의 왼쪽 끝. Drag 중 안내선 위치를 누적 합으로 계산해 재측정을 피한다. */
        originX: number;
        startWidths: number[];
        snapshot: TableSizingSnapshot;
        /** 실제로 끌었는가. 제자리 클릭(= 더블클릭의 첫 번째 클릭)은 크기를 바꾸지 않는다. */
        moved: boolean;
    }
    | {
        kind: 'row';
        table: HTMLTableElement;
        row: HTMLTableRowElement;
        startY: number;
        startHeight: number;
        snapshot: TableSizingSnapshot;
        moved: boolean;
    };

/** 경계에서의 연속 두 번 누름을 더블클릭으로 본다. */
const BOUNDARY_DOUBLE_CLICK_MS = 400;
const BOUNDARY_DOUBLE_CLICK_SLOP = 6;
/** 이 이상 움직여야 "끌었다"로 본다(클릭 중 손떨림 무시). */
const DRAG_MOVE_THRESHOLD = 2;

interface BoundaryTap {
    table: HTMLTableElement;
    kind: 'col' | 'row';
    index: number;
    x: number;
    y: number;
    at: number;
}

interface SizingHistoryEntry {
    table: HTMLTableElement;
    before: TableSizingSnapshot;
    after: TableSizingSnapshot;
}

/** 경계 좌표는 자주 쓰이지만 매 픽셀 다시 재면 큰 표에서 버벅인다. */
const BOUNDARY_CACHE_TTL_MS = 200;
/** 편집 영역 좌우 padding 보정(균등 분배 기준 폭). */
const EDITOR_HORIZONTAL_PADDING = 24;

export function useRichTableResize({ editorRef, disabled, onCommit }: Options) {
    const [guide, setGuide] = useState<TableResizeGuide | null>(null);
    const [activeTable, setActiveTable] = useState<ActiveTable | null>(null);

    const boundaryCache = useRef<BoundaryCache | null>(null);
    const dragRef = useRef<DragState | null>(null);
    const lastBoundaryTap = useRef<BoundaryTap | null>(null);
    const undoStack = useRef<SizingHistoryEntry[]>([]);
    const redoStack = useRef<SizingHistoryEntry[]>([]);

    const setCursor = useCallback((cursor: string) => {
        const root = editorRef.current;
        if (root && root.style.cursor !== cursor) root.style.cursor = cursor;
    }, [editorRef]);

    const getBoundaries = useCallback((table: HTMLTableElement): BoundaryCache => {
        const cached = boundaryCache.current;
        const now = Date.now();
        if (cached && cached.table === table && now - cached.at < BOUNDARY_CACHE_TTL_MS) {
            return cached;
        }
        const fresh: BoundaryCache = {
            table,
            cols: columnBoundaries(table),
            rows: rowBoundaries(table),
            at: now,
        };
        boundaryCache.current = fresh;
        return fresh;
    }, []);

    const invalidateBoundaries = useCallback(() => {
        boundaryCache.current = null;
    }, []);

    const refreshActiveTable = useCallback(() => {
        setActiveTable((prev) => {
            if (!prev || !prev.el.isConnected) return null;
            return {
                el: prev.el,
                rect: prev.el.getBoundingClientRect(),
                manuallySized: isTableManuallySized(prev.el),
            };
        });
    }, []);

    /** 포인터 아래에서 조절 가능한 경계를 찾는다. */
    const hitTest = useCallback((clientX: number, clientY: number, target: HTMLElement | null): HitTest | null => {
        const root = editorRef.current;
        if (disabled || !root) return null;
        let table = (target?.closest?.('table') || null) as HTMLTableElement | null;
        if (table && !root.contains(table)) table = null;
        // 표의 오른쪽/아래쪽 바깥 끝은 셀 위가 아니다. 선택된 표라면 조금 밖까지 허용한다.
        if (!table && activeTable?.el.isConnected) {
            const rect = activeTable.el.getBoundingClientRect();
            const inside = clientX >= rect.left - BOUNDARY_HIT_SLOP
                && clientX <= rect.right + BOUNDARY_HIT_SLOP
                && clientY >= rect.top - BOUNDARY_HIT_SLOP
                && clientY <= rect.bottom + BOUNDARY_HIT_SLOP;
            if (inside) table = activeTable.el;
        }
        if (!table) return null;

        const { cols, rows } = getBoundaries(table);
        // 열 경계를 먼저 본다 — 실제 사용에서 훨씬 흔한 조작이다.
        const col = findBoundary(cols, clientX, 'x');
        if (col) return { table, kind: 'col', index: col.index, position: col.x };
        const row = findBoundary(rows, clientY, 'y');
        if (row) return { table, kind: 'row', index: row.index, position: row.y };
        return null;
    }, [disabled, editorRef, activeTable, getBoundaries]);

    const showGuideFor = useCallback((hit: HitTest, dragging: boolean) => {
        const rect = hit.table.getBoundingClientRect();
        setGuide(hit.kind === 'col'
            ? { kind: 'col', left: hit.position, top: rect.top, width: 0, height: rect.height, dragging }
            : { kind: 'row', left: rect.left, top: hit.position, width: rect.width, height: 0, dragging });
    }, []);

    const clearGuide = useCallback(() => {
        setGuide((prev) => (prev ? null : prev));
        setCursor('');
    }, [setCursor]);

    // ── hover ──
    const handlePointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
        if (dragRef.current) return;
        const hit = hitTest(event.clientX, event.clientY, event.target as HTMLElement);
        if (!hit) {
            clearGuide();
            return;
        }
        setCursor(hit.kind === 'col' ? 'col-resize' : 'row-resize');
        showGuideFor(hit, false);
    }, [hitTest, clearGuide, setCursor, showGuideFor]);

    const handlePointerLeave = useCallback(() => {
        if (dragRef.current) return;
        clearGuide();
    }, [clearGuide]);

    // ── Drag ──
    const finishDrag = useCallback(() => {
        const state = dragRef.current;
        dragRef.current = null;
        document.body.style.removeProperty('cursor');
        document.body.style.removeProperty('user-select');
        setCursor('');
        setGuide(null);
        invalidateBoundaries();
        if (!state || !state.table.isConnected) return;

        if (!state.moved) {
            // 경계를 누르기만 하고 끌지 않았다 — 표를 "수동 크기"로 만들지 않는다.
            // (더블클릭의 첫 번째 클릭이 크기 이력을 남기면 자동 맞춤이 두 단계가 된다)
            restoreTableSizing(state.table, state.snapshot);
            invalidateBoundaries();
            refreshActiveTable();
            return;
        }

        const after = snapshotTableSizing(state.table);
        if (sameTableSizing(state.snapshot, after)) return;
        // pointerup 에서 딱 한 번 — pointermove 마다 기록을 남기지 않는다.
        undoStack.current.push({ table: state.table, before: state.snapshot, after });
        redoStack.current = [];
        onCommit();
        refreshActiveTable();
    }, [invalidateBoundaries, onCommit, refreshActiveTable, setCursor]);

    const handleDragMove = useCallback((event: PointerEvent) => {
        const state = dragRef.current;
        if (!state || !state.table.isConnected) return;
        // 손떨림 1~2px 은 "끌었다"로 보지 않는다 → 제자리 클릭이 크기를 굳히지 않는다.
        const delta = state.kind === 'col'
            ? Math.abs(event.clientX - state.startX)
            : Math.abs(event.clientY - state.startY);
        if (delta > DRAG_MOVE_THRESHOLD) state.moved = true;
        if (state.kind === 'col') {
            const next = resizeColumnAt(state.startWidths, state.index, event.clientX - state.startX);
            writeColWidths(state.table, next);
            invalidateBoundaries();
            const rect = state.table.getBoundingClientRect();
            // 방금 쓴 폭을 그대로 더한다 — 큰 표에서 매 픽셀 셀을 다시 재지 않기 위해.
            const boundaryX = state.originX
                + next.slice(0, state.index + 1).reduce((sum, width) => sum + width, 0);
            setGuide({
                kind: 'col',
                left: boundaryX,
                top: rect.top,
                width: 0,
                height: rect.height,
                dragging: true,
            });
            return;
        }
        const raw = Math.max(0, Math.round(state.startHeight + (event.clientY - state.startY)));
        writeRowMinHeight(state.row, clampRowMinHeight(raw) ?? TABLE_SIZING_LIMITS.minRowHeight);
        invalidateBoundaries();
        const rect = state.table.getBoundingClientRect();
        setGuide({
            kind: 'row',
            left: rect.left,
            top: state.row.getBoundingClientRect().bottom,
            width: rect.width,
            height: 0,
            dragging: true,
        });
    }, [invalidateBoundaries]);

    /**
     * 경계 더블클릭 = 그 줄만 내용에 맞추기.
     *
     *  - 열: 같은 열의 셀이 폭을 공유하므로 셀 하나가 아니라 **열 전체**가 바뀐다.
     *  - 행: 행은 원래 내용에 맞춰 늘어나므로 눌러 두고 있던 최소 높이를 지운다.
     *
     * 두 경우 모두 Drag 와 똑같이 편집 이력 한 단계다(Ctrl+Z 한 번으로 되돌아간다).
     */
    const autoFitBoundary = useCallback((
        table: HTMLTableElement,
        kind: 'col' | 'row',
        index: number,
    ) => {
        if (disabled || !table.isConnected) return;
        const before = snapshotTableSizing(table);

        if (kind === 'col') {
            // 편집 폭을 넘지 않게 상한을 둔다 → 아주 긴 문장은 이 폭에서 줄바꿈된다.
            const editorWidth = (editorRef.current?.clientWidth || 0) - EDITOR_HORIZONTAL_PADDING;
            const maxWidth = editorWidth > COLUMN_AUTOFIT.minWidth * 2
                ? editorWidth
                : TABLE_SIZING_LIMITS.maxColWidth;

            const widths = autoFitSingleColumn(table, index, { maxWidth });
            if (widths.length === 0) return;
            writeColWidths(table, widths);
        } else if (!autoFitRowHeight(table, index)) {
            // 이미 내용 높이인 행 — 바꿀 것이 없다.
            return;
        }
        invalidateBoundaries();

        const after = snapshotTableSizing(table);
        if (!sameTableSizing(before, after)) {
            undoStack.current.push({ table, before, after });
            redoStack.current = [];
            onCommit();
        }
        refreshActiveTable();
    }, [disabled, editorRef, invalidateBoundaries, onCommit, refreshActiveTable]);

    const handlePointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
        if (event.button !== 0 || dragRef.current) return;
        const hit = hitTest(event.clientX, event.clientY, event.target as HTMLElement);
        if (!hit) return;
        // 경계를 잡는 순간 텍스트 선택/캐럿 이동이 일어나면 안 된다.
        // (pointerdown 을 취소하므로 브라우저의 dblclick 도 오지 않는다 → 아래에서 직접 센다)
        event.preventDefault();
        event.stopPropagation();

        const table = hit.table;
        const now = Date.now();
        const previous = lastBoundaryTap.current;
        const isDoubleTap = !!previous
            && previous.table === table
            && previous.kind === hit.kind
            && previous.index === hit.index
            && now - previous.at <= BOUNDARY_DOUBLE_CLICK_MS
            && Math.abs(event.clientX - previous.x) <= BOUNDARY_DOUBLE_CLICK_SLOP
            && Math.abs(event.clientY - previous.y) <= BOUNDARY_DOUBLE_CLICK_SLOP;
        lastBoundaryTap.current = isDoubleTap
            ? null
            : { table, kind: hit.kind, index: hit.index, x: event.clientX, y: event.clientY, at: now };

        if (isDoubleTap) {
            setActiveTable({
                el: table,
                rect: table.getBoundingClientRect(),
                manuallySized: isTableManuallySized(table),
            });
            autoFitBoundary(table, hit.kind, hit.index);
            clearGuide();
            return;
        }

        const snapshot = snapshotTableSizing(table);
        if (hit.kind === 'col') {
            // 지금 보이는 폭을 그대로 굳혀서 시작한다(첫 조절 전에는 auto 레이아웃이었다).
            const startWidths = measureColumnWidths(table);
            const before = columnBoundaries(table);
            const originX = before.length > 0 ? before[0].x - startWidths[0] : table.getBoundingClientRect().left;
            writeColWidths(table, startWidths);
            dragRef.current = {
                kind: 'col', table, index: hit.index, startX: event.clientX, originX, startWidths, snapshot,
                moved: false,
            };
        } else {
            const row = ownTableRows(table)[hit.index];
            if (!row) return;
            dragRef.current = {
                kind: 'row',
                table,
                row,
                startY: event.clientY,
                startHeight: row.getBoundingClientRect().height,
                snapshot,
                moved: false,
            };
        }
        invalidateBoundaries();
        document.body.style.setProperty('cursor', hit.kind === 'col' ? 'col-resize' : 'row-resize');
        document.body.style.setProperty('user-select', 'none');
        showGuideFor(hit, true);
        setActiveTable({ el: table, rect: table.getBoundingClientRect(), manuallySized: true });
    }, [hitTest, invalidateBoundaries, showGuideFor, autoFitBoundary, clearGuide]);

    useEffect(() => {
        const move = (event: PointerEvent) => handleDragMove(event);
        const up = () => finishDrag();
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        return () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
        };
    }, [handleDragMove, finishDrag]);

    // ── 표 선택(툴바 노출) ──
    const syncActiveTable = useCallback((target: EventTarget | null) => {
        const root = editorRef.current;
        const el = target instanceof HTMLElement ? target : null;
        const table = (el?.closest?.('table') || null) as HTMLTableElement | null;
        if (!table || !root || !root.contains(table)) {
            setActiveTable((prev) => (prev ? null : prev));
            return;
        }
        setActiveTable({
            el: table,
            rect: table.getBoundingClientRect(),
            manuallySized: isTableManuallySized(table),
        });
    }, [editorRef]);

    const clearActiveTable = useCallback(() => setActiveTable(null), []);

    useEffect(() => {
        if (!activeTable) return;
        const reposition = () => refreshActiveTable();
        // 편집기 바깥을 누르면 표 선택을 푼다(툴바가 계속 떠 있지 않게).
        const dismiss = (event: MouseEvent) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest('[data-table-toolbar="1"]')) return;
            if (target && editorRef.current?.contains(target)) return;
            setActiveTable(null);
        };
        document.addEventListener('mousedown', dismiss);
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
        return () => {
            document.removeEventListener('mousedown', dismiss);
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('resize', reposition);
        };
    }, [activeTable, editorRef, refreshActiveTable]);

    // ── Undo / Redo ──
    /**
     * 내용 편집이 일어나면 표 크기 이력을 비운다.
     * 그래야 "크기 조절 → 타이핑 → Ctrl+Z" 가 브라우저 기본 undo(타이핑 취소)로 간다.
     */
    const notifyContentChanged = useCallback(() => {
        undoStack.current = [];
        redoStack.current = [];
        invalidateBoundaries();
    }, [invalidateBoundaries]);

    /** 처리했으면 true — 호출자는 브라우저 기본 undo 를 막아야 한다. */
    const handleUndoRedoKey = useCallback((event: React.KeyboardEvent<HTMLElement>): boolean => {
        if (disabled || !(event.ctrlKey || event.metaKey)) return false;
        const key = event.key.toLowerCase();
        const isUndo = key === 'z' && !event.shiftKey;
        const isRedo = (key === 'z' && event.shiftKey) || key === 'y';
        if (!isUndo && !isRedo) return false;

        const stack = isUndo ? undoStack.current : redoStack.current;
        const entry = stack.pop();
        if (!entry) return false;
        if (!entry.table.isConnected) {
            undoStack.current = [];
            redoStack.current = [];
            return false;
        }
        restoreTableSizing(entry.table, isUndo ? entry.before : entry.after);
        (isUndo ? redoStack.current : undoStack.current).push(entry);
        invalidateBoundaries();
        onCommit();
        refreshActiveTable();
        return true;
    }, [disabled, invalidateBoundaries, onCommit, refreshActiveTable]);

    // ── 편의 명령 ──
    const runCommand = useCallback((command: TableSizingCommand) => {
        const table = activeTable?.el;
        if (disabled || !table || !table.isConnected) return;
        const before = snapshotTableSizing(table);

        if (command === 'fit-columns') {
            writeColWidths(table, autoFitColumnWidths(table));
        } else if (command === 'even-columns') {
            const columns = tableColumnCount(table);
            const available = Math.max(
                columns * TABLE_SIZING_LIMITS.minColWidth,
                (editorRef.current?.clientWidth || 0) - EDITOR_HORIZONTAL_PADDING,
            );
            writeColWidths(table, evenColumnWidths(columns, available));
        } else if (command === 'fit-rows') {
            ownTableRows(table).forEach((row) => writeRowMinHeight(row, null));
        } else {
            resetTableSizing(table);
        }

        invalidateBoundaries();
        const after = snapshotTableSizing(table);
        if (!sameTableSizing(before, after)) {
            undoStack.current.push({ table, before, after });
            redoStack.current = [];
            onCommit();
        }
        refreshActiveTable();
    }, [activeTable, disabled, editorRef, invalidateBoundaries, onCommit, refreshActiveTable]);

    /** 외부 value 로 innerHTML 을 새로 채운 뒤 저장된 크기를 다시 입힌다. */
    const applyStoredSizing = useCallback(() => {
        applyTableSizingStyles(editorRef.current);
        invalidateBoundaries();
        // 사라진 표를 가리키는 더블클릭 후보가 남지 않게 한다.
        lastBoundaryTap.current = null;
        setActiveTable(null);
        setGuide(null);
    }, [editorRef, invalidateBoundaries]);

    useEffect(() => () => {
        document.body.style.removeProperty('cursor');
        document.body.style.removeProperty('user-select');
    }, []);

    return {
        guide,
        activeTable,
        handlePointerMove,
        handlePointerDown,
        handlePointerLeave,
        syncActiveTable,
        clearActiveTable,
        handleUndoRedoKey,
        notifyContentChanged,
        runCommand,
        applyStoredSizing,
        isDragging: () => dragRef.current !== null,
    };
}

export type RichTableResize = ReturnType<typeof useRichTableResize>;

/** 예전 이름(Description 전용이던 시절). 새 코드는 `useRichTableResize` 를 쓴다. */
export const useDescriptionTableResize = useRichTableResize;
