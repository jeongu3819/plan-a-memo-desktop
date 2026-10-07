import { useEffect, useRef, useState, type RefObject } from 'react';
import { Box, IconButton, Tooltip, Button } from '@mui/material';
import FormatBoldIcon from '@mui/icons-material/FormatBold';
import FormatUnderlinedIcon from '@mui/icons-material/FormatUnderlined';
import FormatColorTextIcon from '@mui/icons-material/FormatColorText';
import { applyRichTextCommand, TEXT_COLORS, TEXT_SIZES, type RichTextCommand } from '../utils/richTextFormatting';

/**
 * Both editors use the same selection-preserving controls and existing palette.
 *
 * `showEmphasis` 는 굵게/밑줄 **버튼의 표시 여부**일 뿐이다 — 끄더라도 Ctrl/Cmd+B·U
 * 단축키(편집기의 handleRichTextShortcut)와 저장된 굵게·밑줄 렌더링은 그대로다.
 * 기본값 true 이므로 Description/작업노트/공지 등 기존 화면의 도구모음은 바뀌지 않는다.
 */
export default function RichTextToolbar({ editorRef, onFormat, showEmphasis = true }: {
    editorRef: RefObject<HTMLElement>; onFormat: () => void; showEmphasis?: boolean;
}) {
    const saved = useRef<Range | null>(null);
    const toolbarRef = useRef<HTMLDivElement>(null);
    const [menu, setMenu] = useState<'size' | 'color' | null>(null);
    const [active, setActive] = useState({ bold: false, underline: false });
    useEffect(() => {
        if (!menu) return;
        const closeOutside = (event: MouseEvent) => {
            if (!toolbarRef.current?.contains(event.target as Node)) setMenu(null);
        };
        document.addEventListener('mousedown', closeOutside);
        return () => document.removeEventListener('mousedown', closeOutside);
    }, [menu]);
    useEffect(() => {
        const capture = () => {
            const selection = window.getSelection();
            if (selection?.rangeCount && editorRef.current?.contains(selection.getRangeAt(0).commonAncestorContainer)) {
                saved.current = selection.getRangeAt(0).cloneRange();
                setActive({ bold: document.queryCommandState?.('bold') || false, underline: document.queryCommandState?.('underline') || false });
            }
        };
        document.addEventListener('selectionchange', capture);
        return () => document.removeEventListener('selectionchange', capture);
    }, [editorRef]);
    const apply = (command: RichTextCommand, value?: string) => {
        const root = editorRef.current;
        if (!root) return;
        const selection = window.getSelection();
        const current = selection?.rangeCount ? selection.getRangeAt(0) : null;
        root.focus({ preventScroll: true });
        const range = current && root.contains(current.commonAncestorContainer) ? current : saved.current;
        if (range && root.contains(range.commonAncestorContainer)) {
            selection?.removeAllRanges();
            selection?.addRange(range);
        } else {
            const end = document.createRange();
            end.selectNodeContents(root);
            end.collapse(false);
            selection?.removeAllRanges();
            selection?.addRange(end);
        }
        if (applyRichTextCommand(root, command, value)) onFormat();
        setMenu(null);
    };
    return <Box ref={toolbarRef} role="toolbar" aria-label="텍스트 서식" onMouseDown={e => e.preventDefault()}
        sx={{ display: 'flex', alignItems: 'center', gap: 0.25, position: 'relative', flexShrink: 0, width: 'max-content' }}>
        {showEmphasis && <Tooltip title="굵게 (Ctrl/Cmd+B)"><IconButton size="small" aria-label="굵게" aria-pressed={active.bold}
            onClick={() => apply('bold')}><FormatBoldIcon fontSize="small" /></IconButton></Tooltip>}
        {showEmphasis && <Tooltip title="밑줄 (Ctrl/Cmd+U)"><IconButton size="small" aria-label="밑줄" aria-pressed={active.underline}
            onClick={() => apply('underline')}><FormatUnderlinedIcon fontSize="small" /></IconButton></Tooltip>}
        <Button size="small" aria-label="글자 크기" aria-expanded={menu === 'size'} onClick={() => setMenu(menu === 'size' ? null : 'size')}
            sx={{ minWidth: 0, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>글자 크기</Button>
        <Tooltip title="텍스트 색상"><IconButton size="small" aria-label="텍스트 색상" aria-expanded={menu === 'color'}
            onClick={() => setMenu(menu === 'color' ? null : 'color')}><FormatColorTextIcon fontSize="small" /></IconButton></Tooltip>
        {menu && <Box role="group" aria-label={menu === 'size' ? '크기 선택' : '색상 선택'}
            onKeyDown={e => { if (e.key === 'Escape') { setMenu(null); editorRef.current?.focus(); } }}
            sx={{ position: 'absolute', top: '100%', left: 0, zIndex: 30, display: 'flex', bgcolor: 'background.paper',
                border: '1px solid #E5E7EB', borderRadius: 1, boxShadow: 2, p: 0.5 }}>
            {menu === 'size' ? TEXT_SIZES.map((size, index) => <Button key={size} size="small"
                onClick={() => apply('fontSize', String(index + 1))} sx={{ minWidth: 48, whiteSpace: 'nowrap' }}>
                {['작게', '보통', '크게', '매우 크게'][index]}</Button>)
                : TEXT_COLORS.map(color => <IconButton key={color} size="small" aria-label={`글자 색상 ${color}`}
                    onClick={() => apply('foreColor', color)}><Box sx={{ width: 16, height: 16, borderRadius: '50%', bgcolor: color }} /></IconButton>)}
        </Box>}
    </Box>;
}
