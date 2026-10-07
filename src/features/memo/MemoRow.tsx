/**
 * 메모 한 줄 — Web PersonalMemoRow 와 같은 모양·동작.
 *   체크박스(체크리스트) 또는 점(텍스트) · 본문 읽기 화면 → 누르면 그 자리에서 편집(Rich Editor)
 *   · 우클릭/⋮ 메뉴 · 끌기 손잡이. 바깥을 누르면 편집이 끝나고 자동 저장된다.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Button, Checkbox, IconButton, Tooltip, Typography } from '@mui/material';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import StarRoundedIcon from '@mui/icons-material/StarRounded';
import PersonalMemoContentView from '../../vendor/plan-a-work/components/personalMemo/PersonalMemoContentView';
import { MEMO_TEXT } from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import type { Location, MemoItem } from '../../domain/types';
import MemoEditor from '../../editor/MemoEditor';
import { withDisplayImageUrls } from '../../editor/displayHtml';
import { usePersonalMemo } from './MemoProvider';
import MemoMenu, { type MenuAnchor } from './MemoMenu';

/** 편집기의 '바깥 클릭' 으로 보지 않을 떠 있는 UI(메뉴·이미지 도구·링크 팝오버 등). */
const OVERLAY_SELECTOR = [
  '[data-personal-memo-overlay]',
  '.MuiPopover-root',
  '.MuiPopper-root',
  '.MuiMenu-root',
  '.MuiDialog-root',
  '.MuiSnackbar-root',
  '[data-img-toolbar="1"]',
  '[data-img-resize-handle="1"]',
  '[data-link-popover="1"]',
].join(',');

const MARKER_WIDTH = 24;

function editorMatchSx(comfortable: boolean) {
  return {
    '& [contenteditable][contenteditable]': {
      fontSize: comfortable ? '0.94rem' : '0.86rem',
      '--rich-base-font-size': comfortable ? '0.94rem' : '0.86rem',
      lineHeight: 1.6,
      p: 0,
      borderWidth: 0,
      color: comfortable ? MEMO_TEXT : 'text.primary',
      '& p': { m: 0 },
      '& ul, & ol': { m: 0, pl: 2.5 },
    },
  } as const;
}

export interface MemoRowProps {
  item: MemoItem;
  location: Location;
  variant: 'compact' | 'full';
  dragHandleProps?: React.HTMLAttributes<HTMLElement>;
  dragging?: boolean;
  /** 주간 칸 — 본문을 누르면 날짜 상세로 가서 그 메모를 편집한다. */
  onOpenEdit?: () => void;
  comfortable?: boolean;
}

export default function MemoRow({ item, location, variant, dragHandleProps, dragging, onOpenEdit, comfortable = false }: MemoRowProps) {
  const { store, editingId, setEditingId, actions, notify } = usePersonalMemo();
  const draft = store.draft(item.id);
  const editing = editingId === item.id;
  const rowRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const checklist = item.kind === 'checklist';

  useEffect(() => {
    if (editing) store.open(item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  useEffect(() => {
    if (!editing) return undefined;
    const handler = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const row = rowRef.current;
      if (!target || !row || row.contains(target)) return;
      const overlay = target.closest?.(OVERLAY_SELECTOR);
      if (overlay && !overlay.contains(row)) return;
      setEditingId(null);
    };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, [editing, setEditingId]);

  useEffect(() => {
    if (!editing) return undefined;
    const frame = requestAnimationFrame(() => {
      const editable = rowRef.current?.querySelector<HTMLElement>('[contenteditable="true"]');
      if (!editable) return;
      editable.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(editable);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  const onChange = useCallback((html: string) => store.edit(item, html), [store, item]);
  const onUploading = useCallback((uploading: boolean) => store.setUploading(item.id, uploading), [store, item.id]);

  const openMenuAt = (event: React.MouseEvent) => {
    if (editing) return;
    event.preventDefault();
    setMenu({ kind: 'point', top: event.clientY, left: event.clientX });
  };

  const html = draft?.content ?? item.contentHtml;
  const showError = draft?.status === 'error';

  return (
    <Box
      ref={rowRef}
      data-testid="personal-memo-row"
      data-memo-id={item.id}
      onContextMenu={editing ? undefined : openMenuAt}
      onKeyDown={event => {
        if (editing && event.key === 'Escape' && !event.defaultPrevented) {
          event.stopPropagation();
          setEditingId(null);
        }
      }}
      sx={{
        position: 'relative',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 0.5,
        px: 0.5,
        py: variant === 'compact' ? (comfortable ? 0.3 : 0.25) : 0.5,
        borderRadius: 1.25,
        opacity: dragging ? 0.4 : 1,
        bgcolor: editing ? 'action.hover' : 'transparent',
        '&:hover': { bgcolor: 'action.hover' },
        '&:hover .memo-row-tools, &:focus-within .memo-row-tools': { opacity: 1 },
      }}
    >
      {dragHandleProps && !editing && (
        <Box
          className="memo-row-tools"
          aria-label="끌어서 옮기기"
          {...dragHandleProps}
          sx={{
            opacity: 0, cursor: 'grab', color: 'text.disabled', display: 'flex', alignItems: 'center',
            height: 24, mt: '1px', ml: -0.5, touchAction: 'none', '&:active': { cursor: 'grabbing' },
          }}
        >
          <DragIndicatorIcon sx={{ fontSize: 16 }} />
        </Box>
      )}
      {dragHandleProps && editing && <Box aria-hidden sx={{ width: 16, ml: -0.5, flexShrink: 0 }} />}

      {checklist ? (
        <Checkbox
          size="small"
          checked={item.completed}
          onClick={event => event.stopPropagation()}
          onChange={() => actions.toggleComplete(item)}
          inputProps={{ 'aria-label': item.completed ? '완료 해제' : '완료' }}
          sx={{
            p: '3px', mt: comfortable ? '1px' : 0, width: MARKER_WIDTH, flexShrink: 0, color: '#B4BAC4',
            '& .MuiSvgIcon-root': { fontSize: 17 },
            '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2, borderRadius: 1 },
          }}
        />
      ) : (
        <Tooltip title="텍스트 메모 (완료 체크 없음)">
          <Box
            data-testid="memo-text-marker"
            aria-label="텍스트 메모"
            sx={{
              width: MARKER_WIDTH, height: comfortable ? 25 : 23, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              '&::after': { content: '""', width: 5, height: 5, borderRadius: '50%', bgcolor: '#A3A9B4' },
            }}
          />
        </Tooltip>
      )}

      <Box sx={{ flex: 1, minWidth: 0, pt: '2px' }}>
        {editing ? (
          <Box sx={editorMatchSx(comfortable)}>
            <MemoEditor
              itemId={item.id}
              value={html}
              onChange={onChange}
              onUploadingChange={onUploading}
              onError={message => notify({ message, variant: 'error' })}
              maxHeight={variant === 'compact' ? 260 : 520}
            />
          </Box>
        ) : (
          <Box
            role="button"
            tabIndex={0}
            aria-label="메모 편집"
            onClick={event => {
              event.stopPropagation();
              if ((window.getSelection()?.toString() || '').trim()) return;
              if (onOpenEdit) onOpenEdit();
              else setEditingId(item.id);
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                if (onOpenEdit) onOpenEdit();
                else setEditingId(item.id);
              }
            }}
            sx={{ cursor: 'text', outline: 'none', minHeight: 22 }}
          >
            <PersonalMemoContentView
              html={withDisplayImageUrls(html)}
              muted={checklist && item.completed}
              struck={checklist && item.completed}
              clampLines={variant === 'compact' ? 2 : undefined}
              comfortable={comfortable}
              zoomImages={variant === 'full' && !onOpenEdit}
            />
          </Box>
        )}
        {showError && (
          <Box data-testid="personal-memo-save-status" sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.5, mt: 0.25 }}>
            <Typography variant="caption" color="error">{draft?.error || '저장 실패'}</Typography>
            <Button size="small" sx={{ minWidth: 0, py: 0 }} onClick={() => store.retry(item.id)}>다시 시도</Button>
          </Box>
        )}
      </Box>

      {item.favorite && (
        <Tooltip title="즐겨찾기">
          <StarRoundedIcon data-testid="memo-favorite-mark" sx={{ fontSize: 15, color: '#F5B301', mt: comfortable ? '5px' : '4px', flexShrink: 0 }} />
        </Tooltip>
      )}

      <IconButton
        className="memo-row-tools"
        size="small"
        aria-label="메모 메뉴"
        onClick={event => setMenu({ kind: 'element', el: event.currentTarget })}
        sx={{ p: 0.25, opacity: menu ? 1 : 0, color: 'text.secondary', mt: '1px' }}
      >
        <MoreVertIcon sx={{ fontSize: 18 }} />
      </IconButton>

      <MemoMenu item={item} location={location} anchor={menu} onClose={() => setMenu(null)} />
    </Box>
  );
}
