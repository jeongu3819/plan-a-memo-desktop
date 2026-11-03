import { useCallback, useEffect, useState, type ReactNode, type RefObject } from 'react';
import { Box, ButtonBase, Divider, Popover, Tooltip, Typography } from '@mui/material';
import FormatBoldIcon from '@mui/icons-material/FormatBold';
import FormatUnderlinedIcon from '@mui/icons-material/FormatUnderlined';
import FormatStrikethroughIcon from '@mui/icons-material/FormatStrikethrough';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import FormatIndentIncreaseIcon from '@mui/icons-material/FormatIndentIncrease';
import FormatIndentDecreaseIcon from '@mui/icons-material/FormatIndentDecrease';
import LinkIcon from '@mui/icons-material/Link';
import {
    applyRichIndent,
    applyRichList,
    applyRichTextCommand,
    applyTextSize,
    NUMERIC_TEXT_SIZES,
    selectionExplicitTextSizePx,
    selectionLinkAnchor,
    selectionListState,
    selectionTextColor,
    TEXT_COLORS,
    type RichListKind,
    type TextSize,
} from '../utils/richTextFormatting';

export interface RichTextContextMenuState {
    top: number;
    left: number;
    /** 메뉴를 연 순간의 선택 — 메뉴를 누르는 동안 선택이 흔들려도 여기에 적용한다. */
    range: Range;
    /** 선택 위치에 지정된 글자 크기(px). 없으면 '기본'. 표시용. */
    currentPx: number | null;
    /** 선택 위치에 지정된 글자 색(소문자 hex). 없으면 '기본 색'. 표시용. */
    currentColor?: string | null;
    /** 연 순간의 굵게·밑줄·취소선·링크·목록 상태(표시용). */
    bold?: boolean;
    underline?: boolean;
    strike?: boolean;
    link?: boolean;
    listKind?: RichListKind | null;
}

/**
 * 서식이 아니라 **이 항목** 에 대한 명령(예: 메모의 '맨 위로 보내기'). 주는 화면에만 메뉴 맨 아래
 * 구분선 뒤에 붙는다. 실제 동작은 화면이 가진다.
 */
export interface RichTextMenuAction {
    key: string;
    label: string;
    icon?: ReactNode;
    onSelect: () => void;
    /** 꺼 둘 때(예: 이미 맨 위). 이유를 주면 안내로 보인다. */
    disabled?: boolean;
    disabledReason?: string;
}

const LIST_OPTIONS: { kind: RichListKind; label: string; glyph: ReactNode }[] = [
    { kind: 'bullet', label: '글머리 기호', glyph: <FormatListBulletedIcon sx={{ fontSize: 17 }} /> },
    { kind: 'decimal', label: '번호 1.', glyph: '1.' },
    { kind: 'paren', label: '번호 1)', glyph: '1)' },
    { kind: 'circled', label: '원형 숫자 ①', glyph: '①' },
];

/** 메뉴를 연 순간의 선택·서식 상태를 붙잡는다. */
function captureState(root: HTMLElement, range: Range, top: number, left: number): RichTextContextMenuState {
    const query = (command: string) => {
        try { return document.queryCommandState?.(command) || false; } catch { return false; }
    };
    return {
        top, left, range: range.cloneRange(),
        currentPx: selectionExplicitTextSizePx(root),
        currentColor: selectionTextColor(root),
        bold: query('bold'),
        underline: query('underline'),
        strike: query('strikeThrough'),
        link: !!selectionLinkAnchor(root),
        listKind: selectionListState(root).kind,
    };
}

/**
 * 공통 우클릭 서식 메뉴 연결. 편집기는 `onContextMenu` 를 자기 편집 영역에 달고 `menu` 를 그리기만 하면 된다(서식 적용은 전부 여기).
 *
 *   · 글자를 고른 뒤 우클릭 → 고른 글자에만. 커서만 둔 채 우클릭 → 그 줄의 목록·들여쓰기, 이어서 칠 글자의 서식.
 *   · Shift+우클릭, 이미지·멘션 위 우클릭은 브라우저 기본 메뉴 그대로(복사·맞춤법 등).
 *   · `onContextMenu` 는 메뉴를 열었으면 true 를 돌려준다(편집기 쪽 정리용).
 *   · `actions` — 항목 명령(맨 위로 보내기 등). 주는 화면에만 생긴다.
 */
export function useRichTextContextMenu({ editorRef, enabled, onFormat, onLink, actions }: {
    editorRef: RefObject<HTMLElement>;
    enabled: boolean;
    onFormat: () => void;
    /** 주면 메뉴에 '링크' 가 생긴다(선택을 되살린 뒤 부른다). */
    onLink?: () => void;
    actions?: RichTextMenuAction[];
}) {
    const [state, setState] = useState<RichTextContextMenuState | null>(null);
    const close = useCallback(() => setState(null), []);
    const onContextMenu = useCallback((e: React.MouseEvent): boolean => {
        if (!enabled || e.shiftKey) return false;
        const root = editorRef.current;
        const selection = window.getSelection();
        if (!root || !selection?.rangeCount) return false;
        const target = e.target as Element | null;
        if (target instanceof HTMLImageElement || target?.closest?.('[data-mention-user-id]')) return false;
        const range = selection.getRangeAt(0);
        if (!root.contains(range.commonAncestorContainer)) return false;
        // 공백만 고른 것은 서식을 줄 글자가 없다 — 기본 메뉴.
        if (!range.collapsed && !range.toString().trim() && !range.cloneContents().querySelector?.('img')) return false;
        e.preventDefault();
        e.stopPropagation();
        setState(captureState(root, range, e.clientY, e.clientX));
        return true;
    }, [enabled, editorRef]);
    useEffect(() => { if (!enabled) setState(null); }, [enabled]);
    const menu = (
        <RichTextContextMenu editorRef={editorRef} state={state} onClose={close} onFormat={onFormat} onLink={onLink}
            actions={actions} />
    );
    return { onContextMenu, menu, isOpen: !!state };
}

/** 드래그하거나 커서를 둔 뒤 우클릭하면 뜨는 서식 메뉴. 상시 도구모음 대신 쓰인다. */
export default function RichTextContextMenu({
    editorRef, state, onClose, onFormat, onLink, actions,
}: {
    editorRef: RefObject<HTMLElement>;
    state: RichTextContextMenuState | null;
    onClose: () => void;
    onFormat: () => void;
    onLink?: () => void;
    actions?: RichTextMenuAction[];
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
    const run = (action: (root: HTMLElement | null) => boolean) => {
        if (action(restore())) onFormat();
        onClose();
    };
    const size = (value: TextSize | null) => run(root => applyTextSize(root, value, { allowCollapsed: true }));
    const color = (value: string) => run(root => applyRichTextCommand(root, 'foreColor', value));
    const inList = !!state?.listKind;
    const currentColor = state?.currentColor ?? null;

    const sectionTitle = (text: string) => (
        <Typography sx={{ fontSize: '0.7rem', fontWeight: 700, color: 'text.secondary', mt: 1, mb: 0.5 }}>
            {text}
        </Typography>
    );
    const buttonSx = (active = false, disabled = false) => ({
        height: 28, minWidth: 30, px: 0.5, borderRadius: 1, fontSize: '0.8rem', fontWeight: active ? 800 : 600,
        border: '1px solid', borderColor: active ? 'text.primary' : 'divider',
        bgcolor: active ? 'action.selected' : 'transparent',
        color: disabled ? 'text.disabled' : 'text.primary',
        '&:hover': { bgcolor: disabled ? undefined : active ? 'action.selected' : 'action.hover' },
        '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 1 },
    });
    const emphasis = [
        { key: 'bold', label: '굵게', title: '굵게 (Ctrl+B)', active: !!state?.bold, icon: <FormatBoldIcon sx={{ fontSize: 17 }} />, command: 'bold' },
        { key: 'underline', label: '밑줄', title: '밑줄 (Ctrl+U)', active: !!state?.underline, icon: <FormatUnderlinedIcon sx={{ fontSize: 17 }} />, command: 'underline' },
        { key: 'strike', label: '취소선', title: '취소선', active: !!state?.strike, icon: <FormatStrikethroughIcon sx={{ fontSize: 17 }} />, command: 'strikeThrough' },
    ] as const;

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
            // 닫힐 때는 바로 사라진다 — 사라지는 동안 남는 투명 backdrop 이 곧바로 이어지는
            // 다음 우클릭(연속 서식)을 가로채 편집기에 닿지 못하게 한다.
            transitionDuration={{ enter: 120, exit: 0 }}
            data-personal-memo-overlay="true"
            // '크게 편집' 창(Dialog) 위에 뜬다.
            sx={{ zIndex: (theme) => theme.zIndex.modal + 10 }}
            slotProps={{
                // 메뉴 바깥을 눌러 닫을 때도 편집기 포커스가 빠지지 않게 한다.
                // 열린 채 다른 곳을 우클릭하면 브라우저 메뉴 대신 이 메뉴만 닫는다.
                backdrop: {
                    onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
                    onContextMenu: (event: React.MouseEvent) => { event.preventDefault(); onClose(); },
                } as any,
                paper: {
                    // 누르는 동안 편집기의 선택·포커스가 빠지지 않게 한다.
                    onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
                    'data-testid': 'rich-text-context-menu',
                    sx: { p: 1, borderRadius: 2, width: 244 },
                } as any,
            }}
        >
            <Box role="group" aria-label="글자 서식" sx={{ display: 'flex', gap: 0.5 }}>
                {emphasis.map(item => (
                    <ButtonBase key={item.key} aria-label={item.label} aria-pressed={item.active} title={item.title}
                        onClick={() => run(root => applyRichTextCommand(root, item.command))} sx={buttonSx(item.active)}>
                        {item.icon}
                    </ButtonBase>
                ))}
                {onLink && (
                    <ButtonBase aria-label="링크" aria-pressed={!!state?.link} title={state?.link ? '링크 편집 · 제거' : '링크 (Ctrl+K)'}
                        sx={buttonSx(!!state?.link)} onClick={() => { restore(); onClose(); onLink(); }}>
                        <LinkIcon sx={{ fontSize: 17 }} />
                    </ButtonBase>
                )}
            </Box>
            {sectionTitle('글자 크기')}
            <Box role="group" aria-label="글자 크기" sx={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 0.5 }}>
                <ButtonBase aria-label="기본 크기" aria-pressed={state?.currentPx === null} onClick={() => size(null)}
                    sx={{ ...buttonSx(state?.currentPx === null), minWidth: 0, fontSize: '0.72rem' }}>
                    기본
                </ButtonBase>
                {NUMERIC_TEXT_SIZES.map(value => {
                    const active = state?.currentPx === Number(value);
                    return (
                        <ButtonBase key={value} aria-label={`글자 크기 ${value}`} aria-pressed={active} onClick={() => size(value)}
                            sx={{ ...buttonSx(active), minWidth: 0, fontSize: '0.78rem' }}>
                            {value}
                        </ButtonBase>
                    );
                })}
            </Box>
            {sectionTitle('글자 색상')}
            <Box role="group" aria-label="글자 색상" sx={{ display: 'flex', gap: 0.75 }}>
                {TEXT_COLORS.map((value, index) => {
                    const active = currentColor ? currentColor === value.toLowerCase() : index === 0;
                    return (
                        <ButtonBase key={value} aria-label={index === 0 ? '기본 색' : `글자 색 ${value}`} aria-pressed={active}
                            onClick={() => color(value)}
                            sx={{
                                width: 24, height: 24, borderRadius: '50%',
                                outline: active ? '2px solid' : 'none', outlineColor: 'text.primary',
                                '&:hover': active ? {} : { outline: '2px solid', outlineColor: 'divider' },
                                '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' },
                            }}>
                            <Box sx={{ width: 18, height: 18, borderRadius: '50%', bgcolor: value }} />
                        </ButtonBase>
                    );
                })}
            </Box>
            {sectionTitle('목록 · 들여쓰기')}
            <Box role="group" aria-label="목록" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                {LIST_OPTIONS.map(option => {
                    const active = state?.listKind === option.kind;
                    return (
                        <ButtonBase key={option.kind} aria-label={option.label} aria-pressed={active}
                            title={active ? `${option.label} 끄기` : option.label}
                            onClick={() => run(root => applyRichList(root, option.kind))} sx={buttonSx(active)}>
                            {option.glyph}
                        </ButtonBase>
                    );
                })}
                <Divider orientation="vertical" flexItem sx={{ mx: 0.25 }} />
                {(['indent', 'outdent'] as const).map(direction => {
                    const label = direction === 'indent' ? '들여쓰기' : '내어쓰기';
                    return (
                        <Tooltip key={direction} title={inList ? `${label} (${direction === 'indent' ? 'Tab' : 'Shift+Tab'})` : '목록 안에서 쓸 수 있어요'}>
                            {/* 꺼진 버튼에도 안내가 뜨도록 span 으로 감싼다. */}
                            <span>
                                <ButtonBase aria-label={label} disabled={!inList}
                                    onClick={() => run(root => applyRichIndent(root, direction))} sx={buttonSx(false, !inList)}>
                                    {direction === 'indent'
                                        ? <FormatIndentIncreaseIcon sx={{ fontSize: 17 }} />
                                        : <FormatIndentDecreaseIcon sx={{ fontSize: 17 }} />}
                                </ButtonBase>
                            </span>
                        </Tooltip>
                    );
                })}
            </Box>
            {!!actions?.length && (
                <>
                    <Divider sx={{ my: 1 }} />
                    <Box role="group" aria-label="항목" sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                        {actions.map(action => (
                            <Tooltip key={action.key} title={action.disabled ? action.disabledReason ?? '' : ''} placement="right">
                                {/* 꺼진 명령에도 안내가 뜨도록 span 으로 감싼다. */}
                                <span>
                                    <ButtonBase
                                        aria-label={action.label}
                                        disabled={action.disabled}
                                        data-testid={`rich-menu-action-${action.key}`}
                                        onClick={() => { onClose(); action.onSelect(); }}
                                        sx={{
                                            width: '100%', justifyContent: 'flex-start', gap: 1, px: 1, py: 0.75,
                                            borderRadius: 1, fontSize: '0.8rem', fontWeight: 600,
                                            color: action.disabled ? 'text.disabled' : 'text.primary',
                                            '&:hover': { bgcolor: action.disabled ? undefined : 'action.hover' },
                                            '& .MuiSvgIcon-root': { fontSize: 17, color: action.disabled ? 'text.disabled' : 'text.secondary' },
                                        }}
                                    >
                                        {action.icon}
                                        {action.label}
                                    </ButtonBase>
                                </span>
                            </Tooltip>
                        ))}
                    </Box>
                </>
            )}
        </Popover>
    );
}
