import { useEffect, type RefObject } from 'react';
import { Box, ButtonBase, Popover, Typography } from '@mui/material';
import {
    applyRichTextCommand,
    applyTextSize,
    NUMERIC_TEXT_SIZES,
    TEXT_COLORS,
    type TextSize,
} from '../utils/richTextFormatting';

export interface RichTextContextMenuState {
    top: number;
    left: number;
    /** 메뉴를 연 순간의 선택 — 메뉴를 누르는 동안 선택이 흔들려도 여기에 적용한다. */
    range: Range;
    /** 선택 위치의 현재 글자 크기(px). 표시용. */
    currentPx: number | null;
}

/** 드래그해서 고른 글자에만 뜨는 서식 메뉴(글자 크기·색). 상시 도구모음 대신 쓰인다. */
export default function RichTextContextMenu({
    editorRef, state, onClose, onFormat,
}: {
    editorRef: RefObject<HTMLElement>;
    state: RichTextContextMenuState | null;
    onClose: () => void;
    onFormat: () => void;
}) {
    // 편집기 포커스·선택을 그대로 두기 위해 메뉴는 포커스를 가져가지 않는다 → Esc 는 여기서 받는다.
    useEffect(() => {
        if (!state) return undefined;
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            onClose();
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [state, onClose]);

    const restore = (): HTMLElement | null => {
        const root = editorRef.current;
        if (!root || !state || !root.contains(state.range.commonAncestorContainer)) return null;
        root.focus({ preventScroll: true });
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(state.range);
        return root;
    };
    const size = (value: TextSize | null) => {
        if (applyTextSize(restore(), value)) onFormat();
        onClose();
    };
    const color = (value: string) => {
        if (applyRichTextCommand(restore(), 'foreColor', value)) onFormat();
        onClose();
    };

    return (
        <Popover
            open={!!state}
            onClose={onClose}
            anchorReference="anchorPosition"
            anchorPosition={state ? { top: state.top, left: state.left } : undefined}
            container={() => (document.fullscreenElement as HTMLElement | null) ?? document.body}
            disableAutoFocus
            disableEnforceFocus
            disableRestoreFocus
            data-personal-memo-overlay="true"
            slotProps={{
                paper: {
                    // 누르는 동안 편집기의 선택·포커스가 빠지지 않게 한다.
                    onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
                    'data-testid': 'rich-text-context-menu',
                    sx: { p: 1, borderRadius: 2, width: 244 },
                } as any,
            }}
        >
            <Typography sx={{ fontSize: '0.7rem', fontWeight: 700, color: 'text.secondary', mb: 0.5 }}>
                글자 크기
            </Typography>
            <Box role="group" aria-label="글자 크기" sx={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 0.5 }}>
                {NUMERIC_TEXT_SIZES.map(value => {
                    const active = state?.currentPx === Number(value);
                    return (
                        <ButtonBase
                            key={value}
                            aria-label={`글자 크기 ${value}`}
                            aria-pressed={active}
                            onClick={() => size(value)}
                            sx={{
                                height: 28, borderRadius: 1, fontSize: '0.78rem', fontWeight: active ? 800 : 500,
                                border: '1px solid', borderColor: active ? 'text.primary' : 'divider',
                                '&:hover': { bgcolor: 'action.hover' },
                            }}
                        >
                            {value}
                        </ButtonBase>
                    );
                })}
                <ButtonBase
                    aria-label="기본 크기"
                    onClick={() => size(null)}
                    sx={{
                        height: 28, borderRadius: 1, fontSize: '0.72rem', color: 'text.secondary',
                        border: '1px solid', borderColor: 'divider', '&:hover': { bgcolor: 'action.hover' },
                    }}
                >
                    기본
                </ButtonBase>
            </Box>
            <Typography sx={{ fontSize: '0.7rem', fontWeight: 700, color: 'text.secondary', mt: 1, mb: 0.5 }}>
                글자 색
            </Typography>
            <Box role="group" aria-label="글자 색" sx={{ display: 'flex', gap: 0.75 }}>
                {TEXT_COLORS.map((value, index) => (
                    <ButtonBase
                        key={value}
                        aria-label={index === 0 ? '기본 색' : `글자 색 ${value}`}
                        onClick={() => color(value)}
                        sx={{ width: 24, height: 24, borderRadius: '50%', '&:hover': { outline: '2px solid', outlineColor: 'divider' } }}
                    >
                        <Box sx={{ width: 18, height: 18, borderRadius: '50%', bgcolor: value }} />
                    </ButtonBase>
                ))}
            </Box>
        </Popover>
    );
}
