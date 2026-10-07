import React from 'react';
import { Box, Button, Tooltip, Typography } from '@mui/material';
import type { RichTableResize } from '../../hooks/useDescriptionTableResize';

/**
 * 표 열/행 크기 조절의 화면 부분(안내선 + 표 선택 시 메뉴) — Description · 작업노트 · 메모 공용.
 *
 * 상태와 동작은 전부 `useRichTableResize` 가 갖고, 여기서는 그리기만 한다.
 * 위치는 `position: fixed` 라 편집기의 스크롤/overflow 와 무관하게 표 위에 뜬다.
 */
const RichTableResizeOverlay: React.FC<{ table: RichTableResize; disabled?: boolean }> = ({ table, disabled }) => {
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
            {table.activeTable && (
                <Box
                    data-table-toolbar="1"
                    onMouseDown={(e) => e.preventDefault()}
                    sx={{
                        position: 'fixed',
                        top: Math.max(4, table.activeTable.rect.top - 30),
                        left: Math.max(8, table.activeTable.rect.left),
                        zIndex: 2000,
                        display: 'flex', alignItems: 'center', gap: 0.25,
                        px: 0.75, py: 0.25, borderRadius: 999,
                        bgcolor: 'rgba(30,30,30,0.92)',
                        backdropFilter: 'blur(6px)',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
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
                    {table.activeTable.manuallySized && (
                        <>
                            <Box sx={{ width: 1, height: 14, bgcolor: 'rgba(255,255,255,0.25)', mx: 0.25 }} />
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
