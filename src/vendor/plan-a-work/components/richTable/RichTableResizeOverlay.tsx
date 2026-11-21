import React, { useLayoutEffect, useRef, useState } from 'react';
import { Box, Button, Tooltip, Typography } from '@mui/material';
import type { RichTableResize } from '../../hooks/useDescriptionTableResize';
import {
    type ToolbarPlacement,
    type ToolbarSide,
    areaHasContent,
    placeTableToolbar,
    visibleClip,
} from '../../utils/tableToolbarPlacement';

/**
 * 표 열/행 크기 조절의 화면 부분(안내선 + 표 선택 시 메뉴) — Description · 작업노트 · 메모 공용.
 *
 * 상태와 동작은 전부 `useRichTableResize` 가 갖고, 여기서는 그리기만 한다.
 * 위치는 `position: fixed` 라 편집기의 스크롤/overflow 와 무관하게 표 위에 뜬다.
 *
 * [PLAN-A Memo Desktop] 도구 자리: 예전에는 늘 표 위 30px(왼쪽)이라 표 바로 위 문단 글자를 가렸다. 이제
 * `utils/tableToolbarPlacement` 가 표 위·아래 왼쪽/오른쪽 중 글자가 없는 자리를 고른다(없으면 표 안 오른쪽 위).
 * 같은 표·같은 배치에서는 고른 자리를 유지해 스크롤 중에 다시 재지 않고, 표가 스크롤 영역 밖이면 숨긴다.
 * 덧그림이라 보이거나 숨을 때 본문 배치·스크롤이 움직이지 않는다.
 */
const RichTableResizeOverlay: React.FC<{ table: RichTableResize; disabled?: boolean }> = ({ table, disabled }) => {
    const active = disabled ? null : table.activeTable;
    const toolbarRef = useRef<HTMLDivElement>(null);
    const [placement, setPlacement] = useState<ToolbarPlacement | null>(null);
    const chosen = useRef<{ el: HTMLTableElement; key: string; side: ToolbarSide } | null>(null);

    // 그리기 전에 자리를 정한다(깜빡임 없음). 재는 동안만 도구를 숨겨 자기 자신을 글자로 보지 않는다.
    useLayoutEffect(() => {
        const bar = toolbarRef.current;
        if (!active || !bar || !active.el.isConnected) {
            chosen.current = null;
            setPlacement(prev => (prev ? null : prev));
            return;
        }
        const size = { width: bar.offsetWidth, height: bar.offsetHeight };
        const rect = active.rect;
        const root = active.el.closest('[contenteditable="true"]');
        const rootTop = root ? root.getBoundingClientRect().top : 0;
        // 스크롤만 했으면 같은 key — 고른 자리를 그대로 쓴다. 표 크기·본문 안 위치·도구 폭이 바뀌면 다시 고른다.
        const key = [size.width, size.height, Math.round(rect.width), Math.round(rect.height), Math.round(rect.top - rootTop)].join('|');
        const previous = chosen.current && chosen.current.el === active.el ? chosen.current : null;
        // 도구는 예전처럼 편집기 밖(표 위·아래)에도 뜰 수 있다 — 편집기를 둘러싼 스크롤 영역 안이기만 하면 된다.
        // 편집기 자체가 안에서 스크롤하는 경우(높이 제한)에만 편집기 상자로도 자른다.
        let bounds = visibleClip((root as HTMLElement | null) ?? active.el);
        if (root instanceof HTMLElement && root.scrollHeight > root.clientHeight + 1) {
            const r = root.getBoundingClientRect();
            bounds = { ...bounds, top: Math.max(bounds.top, r.top), bottom: Math.min(bounds.bottom, r.bottom) };
        }
        const before = bar.style.visibility;
        bar.style.visibility = 'hidden';
        const next = placeTableToolbar({
            table: rect,
            size,
            bounds,
            isFree: box => !areaHasContent(box, [bar, document.querySelector('[data-table-structure-ui="1"]')]),
            preferred: previous?.side ?? null,
            trustPreferred: !!previous && previous.key === key,
        });
        bar.style.visibility = before;
        chosen.current = next ? { el: active.el, key, side: next.side } : null;
        setPlacement(prev => (prev && next && prev.side === next.side
            && Math.round(prev.left) === Math.round(next.left) && Math.round(prev.top) === Math.round(next.top)
            ? prev
            : next));
    }, [active]);

    if (disabled) return null;
    return (
        <>
            {/* 표 열/행 경계 안내선 — 경계에 다가갔을 때만 보인다(평상시에는 깔끔한 표). */}
            {table.guide && (
                <Box
                    data-table-resize-guide={table.guide.kind}
                    sx={{
                        position: 'fixed',
                        left: table.guide.kind === 'col' ? table.guide.left - 1 : table.guide.left,
                        top: table.guide.kind === 'col' ? table.guide.top : table.guide.top - 1,
                        width: table.guide.kind === 'col' ? 2 : table.guide.width,
                        height: table.guide.kind === 'col' ? table.guide.height : 2,
                        bgcolor: table.guide.dragging ? '#2955FF' : 'rgba(41,85,255,0.55)',
                        boxShadow: table.guide.dragging ? '0 0 0 1px rgba(41,85,255,0.25)' : 'none',
                        pointerEvents: 'none',
                        zIndex: 1998,
                    }}
                />
            )}

            {/* 표를 선택했을 때만 뜨는 크기 조절 메뉴 */}
            {active && (
                <Box
                    ref={toolbarRef}
                    data-table-toolbar="1"
                    data-side={placement?.side}
                    onMouseDown={(e) => e.preventDefault()}
                    sx={{
                        position: 'fixed',
                        top: placement?.top ?? 0,
                        left: placement?.left ?? 0,
                        // 자리를 정하기 전·표가 화면 밖일 때는 보이지 않는다(누를 수도 없음).
                        visibility: placement ? 'visible' : 'hidden',
                        zIndex: 2000,
                        display: 'flex', alignItems: 'center', gap: 0.25,
                        px: 0.75, py: 0.25, borderRadius: 999,
                        bgcolor: 'rgba(30,30,30,0.92)',
                        backdropFilter: 'blur(6px)',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
                        // 폭은 내용대로 고정 — 화면 오른쪽 가까이 놓여도 줄어들지 않는다(재는 폭과 그려지는 폭이 같게).
                        width: 'max-content',
                        whiteSpace: 'nowrap',
                        '& > *': { flexShrink: 0 },
                    }}
                >
                    <Typography
                        variant="caption"
                        sx={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.62rem', fontWeight: 700, mr: 0.5 }}
                    >
                        표
                    </Typography>
                    {([
                        { key: 'fit-columns', label: '열 맞춤', tip: '열 너비를 내용에 맞춘다' },
                        { key: 'even-columns', label: '균등', tip: '열 너비를 균등 분배' },
                        { key: 'fit-rows', label: '행 맞춤', tip: '행 높이를 내용에 맞춘다' },
                    ] as const).map(item => (
                        <Tooltip key={item.key} title={item.tip} arrow>
                            <Button
                                size="small"
                                onClick={() => table.runCommand(item.key)}
                                sx={{
                                    minWidth: 0, px: 0.75, py: 0.1, borderRadius: 999,
                                    color: '#fff', fontSize: '0.65rem', fontWeight: 700,
                                    textTransform: 'none', lineHeight: 1.6,
                                }}
                            >
                                {item.label}
                            </Button>
                        </Tooltip>
                    ))}
                    {active.manuallySized && (
                        <>
                            {/* MUI sx 의 width: 1 은 100% 라 '1px' 로 쓴다(줄어들지 않게 한 뒤에도 얇은 구분선). */}
                            <Box sx={{ width: '1px', height: 14, bgcolor: 'rgba(255,255,255,0.25)', mx: 0.25 }} />
                            <Tooltip title="수동으로 조절한 크기를 지우고 자동 맞춤으로" arrow>
                                <Button
                                    size="small"
                                    onClick={() => table.runCommand('reset')}
                                    sx={{
                                        minWidth: 0, px: 0.75, py: 0.1, borderRadius: 999,
                                        color: '#FCA5A5', fontSize: '0.65rem', fontWeight: 700,
                                        textTransform: 'none', lineHeight: 1.6,
                                    }}
                                >
                                    초기화
                                </Button>
                            </Tooltip>
                        </>
                    )}
                </Box>
            )}
        </>
    );
};

export default RichTableResizeOverlay;
