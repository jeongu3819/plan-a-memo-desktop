import React from 'react';
import { Box } from '@mui/material';
import type { RichTableStructure } from '../../hooks/useRichTableStructure';
import { type Band, columnBands, rowBands } from '../../utils/tableStructure';
import { visibleClip } from '../../utils/tableToolbarPlacement';

/**
 * [PLAN-A Memo Desktop] 표 행·열 선택의 화면 부분 — 핸들과 선택 강조.
 *
 * 전부 `position: fixed` 덧그림이다. 편집 DOM 안에는 아무것도 넣지 않으므로 선택 강조가 저장 HTML 에
 * 섞이거나 셀 배경·정렬·높이를 건드릴 일이 없다. 위치는 그릴 때마다 표에서 잰다(스크롤·크기 변경은
 * 훅의 layoutVersion 이 다시 그리게 한다). 스크롤 영역 밖으로 나간 부분은 잘라서 머리말 위에 겹치지 않는다.
 */

const ACCENT = '#2955FF';
/** 핸들이 표 테두리 바깥으로 나오는 폭 — 스크롤 상자 경계에서 잘리지 않게 이만큼은 넘쳐도 그린다. */
const HANDLE_OVERHANG = 7;
/** 핸들 누르는 자리의 두께(테두리 가운데). */
const HIT_THICKNESS = 14;
/** 행/열 경계(크기 조절 자리)와 겹치지 않게 양 끝을 비운다. */
const BOUNDARY_GAP = 6;

const RichTableStructureOverlay: React.FC<{
    structure: RichTableStructure;
    disabled?: boolean;
    /** 핸들 우클릭 → 편집기의 서식 메뉴(표 편집 포함)를 그 자리에서 연다. */
    onHandleContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
}> = ({ structure, disabled, onHandleContextMenu }) => {
    const { hover, selection } = structure;
    if (disabled) return null;
    const table = selection?.table ?? hover?.table ?? null;
    if (!table || !table.isConnected) return null;
    // hover 와 선택이 다른 표면 hover 표를 그린다(선택은 그대로 유지되지만 그 표 위에 손이 없다).
    const hoverTable = hover?.table.isConnected ? hover.table : null;
    const tables = Array.from(new Set([selection?.table, hoverTable].filter(Boolean))) as HTMLTableElement[];

    const clip = visibleClip(table, HANDLE_OVERHANG);
    if (clip.right <= clip.left || clip.bottom <= clip.top) return null;
    // structure.layoutVersion 이 바뀌면 이 컴포넌트가 다시 그려져 아래 값을 새로 잰다.
    void structure.layoutVersion;

    const pieces: React.ReactNode[] = [];
    tables.forEach((t, ti) => {
        const rect = t.getBoundingClientRect();
        const rows = rowBands(t);
        const cols = columnBands(t);
        const x = (v: number) => v - clip.left;
        const y = (v: number) => v - clip.top;
        const sel = selection && selection.table === t ? selection : null;

        if (sel) {
            const bands = sel.kind === 'row' ? rows : cols;
            const first = bands[sel.start];
            const last = bands[sel.end];
            if (first && last) {
                const box = sel.kind === 'row'
                    ? { left: rect.left, top: first.start, width: rect.width, height: last.end - first.start }
                    : { left: first.start, top: rect.top, width: last.end - first.start, height: rect.height };
                pieces.push(
                    <Box
                        key={`sel-${ti}`}
                        data-testid="table-structure-selection"
                        data-kind={sel.kind}
                        data-start={sel.start}
                        data-count={sel.end - sel.start + 1}
                        sx={{
                            position: 'absolute', left: x(box.left), top: y(box.top), width: box.width, height: box.height,
                            bgcolor: 'rgba(41,85,255,0.10)', outline: `2px solid ${ACCENT}`, outlineOffset: '-1px',
                            borderRadius: '2px', pointerEvents: 'none',
                        }}
                    />,
                );
            }
        }

        const handle = (kind: 'row' | 'col', index: number, band: Band, active: boolean) => {
            const length = band.end - band.start;
            const hit = Math.max(8, length - BOUNDARY_GAP * 2);
            const grip = Math.min(22, Math.max(6, length - BOUNDARY_GAP * 2 - 4));
            const position = kind === 'row'
                ? { left: x(rect.left) - HIT_THICKNESS / 2, top: y(band.start) + (length - hit) / 2, width: HIT_THICKNESS, height: hit }
                : { left: x(band.start) + (length - hit) / 2, top: y(rect.top) - HIT_THICKNESS / 2, width: hit, height: HIT_THICKNESS };
            const label = kind === 'row' ? `${index + 1}번째 행 선택` : `${index + 1}번째 열 선택`;
            return (
                <Box
                    key={`${kind}-${ti}-${index}`}
                    role="button"
                    aria-label={label}
                    aria-pressed={active}
                    title={kind === 'row' ? '행 선택 · 끌면 여러 행 · Delete 로 삭제' : '열 선택 · 끌면 여러 열 · Delete 로 삭제'}
                    data-testid={kind === 'row' ? 'table-row-handle' : 'table-col-handle'}
                    data-index={index}
                    onPointerEnter={structure.cancelHoverClear}
                    onPointerLeave={structure.scheduleHoverClear}
                    onPointerDown={(event) => structure.handleHandlePointerDown(event, t, kind, index)}
                    // 우클릭 메뉴는 편집기의 메뉴가 연다 — 브라우저 메뉴는 띄우지 않는다.
                    onContextMenu={(event) => { event.preventDefault(); onHandleContextMenu?.(event); }}
                    sx={{
                        position: 'absolute', ...position,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer', pointerEvents: 'auto', touchAction: 'none',
                        '&:hover > span': { bgcolor: ACCENT, borderColor: ACCENT },
                    }}
                >
                    <Box
                        component="span"
                        sx={{
                            display: 'block',
                            width: kind === 'row' ? 6 : grip,
                            height: kind === 'row' ? grip : 6,
                            borderRadius: 999,
                            border: '1px solid',
                            borderColor: active ? ACCENT : 'rgba(28,25,23,0.38)',
                            bgcolor: active ? ACCENT : '#fff',
                            boxShadow: '0 1px 2px rgba(0,0,0,0.12)',
                            transition: 'background-color 0.1s, border-color 0.1s',
                        }}
                    />
                </Box>
            );
        };

        // 선택한 행/열의 핸들은 계속 보인다(채운 색). 손을 올린 행/열의 핸들은 그 하나만.
        const shown = new Set<string>();
        if (sel) {
            const bands = sel.kind === 'row' ? rows : cols;
            for (let i = sel.start; i <= sel.end; i += 1) {
                if (!bands[i]) continue;
                shown.add(`${sel.kind}-${i}`);
                pieces.push(handle(sel.kind, i, bands[i], true));
            }
        }
        if (hover && hover.table === t && !structure.isDragging()) {
            if (rows[hover.row] && !shown.has(`row-${hover.row}`)) pieces.push(handle('row', hover.row, rows[hover.row], false));
            if (cols[hover.col] && !shown.has(`col-${hover.col}`)) pieces.push(handle('col', hover.col, cols[hover.col], false));
        }
    });

    return (
        <Box
            data-table-structure-ui="1"
            data-personal-memo-overlay="true"
            onMouseDown={(e) => e.preventDefault()}
            sx={{
                position: 'fixed', left: clip.left, top: clip.top,
                width: clip.right - clip.left, height: clip.bottom - clip.top,
                overflow: 'hidden', pointerEvents: 'none',
                // '크게 편집' 창(Dialog, modal) 위, 우클릭 메뉴(modal + 10) 아래.
                zIndex: (theme) => theme.zIndex.modal + 5,
            }}
        >
            {pieces}
        </Box>
    );
};

export default RichTableStructureOverlay;
