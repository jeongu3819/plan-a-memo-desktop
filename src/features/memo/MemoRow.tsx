/**
 * 메모 한 줄 — Web PersonalMemoRow 와 같은 모양·동작.
 *   체크박스(체크리스트) 또는 점(텍스트) · 본문 읽기 화면 → 누르면 그 자리에서 편집(Rich Editor)
 *   · 우클릭/⋮ 메뉴 · 끌기 손잡이. 바깥을 누르면 편집이 끝나고 자동 저장된다.
 *
 * 읽기 화면과 편집기는 같은 배치다 — 글자 크기·줄 높이·문단 간격이 같고(editorMatchSx), 편집기에 최대 높이가 없어
 * 긴 메모도 안쪽 스크롤 없이 그대로 펼쳐진다(스크롤은 화면 하나). 누른 글자 자리에 커서가 놓이므로(editor/caretSpot)
 * 읽던 자리에서 바로 고친다 — 편집을 시작·끝내도 높이와 스크롤 위치가 바뀌지 않는다.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Button, Checkbox, IconButton, Tooltip, Typography } from '@mui/material';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import StarRoundedIcon from '@mui/icons-material/StarRounded';
import VerticalAlignTopIcon from '@mui/icons-material/VerticalAlignTop';
import PersonalMemoContentView from '../../vendor/plan-a-work/components/personalMemo/PersonalMemoContentView';
import { MEMO_TEXT } from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import { RICH_LIST_INDENT, RICH_LIST_MARKER_GUTTER, RICH_LIST_WIDE_INDENT, richListWideSelector } from '../../vendor/plan-a-work/utils/richListSx';
import type { Location, MemoItem } from '../../domain/types';
import MemoEditor from '../../editor/MemoEditor';
import { withDisplayImageUrls } from '../../editor/displayHtml';
import { caretSpotFromPoint, placeCaret, type CaretSpot } from '../../editor/caretSpot';
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

/**
 * 편집기를 읽기 화면(PersonalMemoContentView)과 같은 배치로 — 편집을 시작해도 줄 높이·문단 간격이 그대로라
 * 메모 높이가 변하지 않는다(긴 메모에서 줄마다 조금씩 줄어 카드가 작아지고 글이 위로 밀리지 않게).
 * 편집기 기본값(문단·목록 줄 높이 1.55, 제목·인용 여백)을 읽기 화면 값으로 덮는다.
 */
function editorMatchSx(comfortable: boolean) {
  return {
    '& [contenteditable][contenteditable]': {
      fontSize: comfortable ? '0.94rem' : '0.86rem',
      '--rich-base-font-size': comfortable ? '0.94rem' : '0.86rem',
      lineHeight: 1.6,
      p: 0,
      borderWidth: 0,
      // 편집기는 스크롤 영역(overflow auto)이라 둥근 모서리(기본 12px)대로 내용을 자른다. 안쪽 여백이 0 이면 그 모서리가
      // 글자에 바로 닿아, 첫·마지막 줄 맨 앞(뒤)의 커서·한글 조합 밑줄·글자 끝이 잘려 보였다(실측). 테두리·배경이 없으니 각지게.
      borderRadius: 0,
      color: comfortable ? MEMO_TEXT : 'text.primary',
      '& p': { m: 0, lineHeight: 'inherit' },
      '& li': { lineHeight: 'inherit' },
      '& :is(h1, h2, h3, h4, h5, h6)': { m: 0, lineHeight: 'inherit', fontSize: 'revert' },
      '& blockquote': { m: 0, pl: 0, borderLeft: 0, color: 'inherit' },
      // 들여쓰기 폭은 읽기 화면과 같은 값(utils/richListSx).
      '& ul, & ol': { m: 0, pl: RICH_LIST_MARKER_GUTTER },
      '& :is(ul, ol) :is(ul, ol)': { pl: RICH_LIST_INDENT },
      [richListWideSelector()]: { pl: RICH_LIST_WIDE_INDENT },
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
  /** 같은 자리(날짜+구역 / List)에서 이미 맨 위인가 — '맨 위로 보내기' 를 끈다. */
  firstInPlace?: boolean;
}

export default function MemoRow({ item, location, variant, dragHandleProps, dragging, onOpenEdit, comfortable = false, firstInPlace = false }: MemoRowProps) {
  const { store, editingId, setEditingId, actions, notify } = usePersonalMemo();
  const draft = store.draft(item.id);
  const editing = editingId === item.id;
  const rowRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** 읽기 화면에서 누른 글자 자리 — 편집기가 열리면 그 자리에 커서. 키보드로 열면 없음(끝에). */
  const caretSpot = useRef<CaretSpot | null>(null);
  const checklist = item.kind === 'checklist';

  useEffect(() => {
    if (editing) store.open(item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  /** 편집 시작·끝 직전의 화면 스크롤 — 바꾼 뒤 그리기 전에 되돌린다(아래 layout effect). */
  const keptScroll = useRef<{ el: HTMLElement; top: number } | null>(null);

  /**
   * 읽기 화면 ↔ 편집기 전환. 둘은 같은 높이라 화면이 움직일 이유가 없지만, 전환하는 순간(새 쪽이 내용을 채우기 전)에
   * 다른 곳이 배치를 재면(입력칸 자동 높이 등) 브라우저가 스크롤을 줄어든 높이에 맞춰 잘라 버린다 — 긴 메모에서 편집을
   * 시작·끝낼 때 화면이 위로 튀던 원인(실측). 그래서 직전 스크롤을 기억했다가 그리기 전에 되돌린다.
   * 포커스도 먼저 놓는다 — 포커스를 가진 요소(누른 읽기 화면·편집기)가 빠질 때도 WebView2 가 스크롤을 처음으로 돌린다.
   */
  const switchEditing = useCallback(
    (next: string | null) => {
      const row = rowRef.current;
      const active = document.activeElement;
      if (active instanceof HTMLElement && row?.contains(active)) active.blur();
      let scroller = row?.parentElement ?? null;
      while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      keptScroll.current = scroller ? { el: scroller, top: scroller.scrollTop } : null;
      setEditingId(next);
    },
    [setEditingId],
  );

  // 편집기·읽기 화면이 내용을 채운 뒤(자식 layout effect 다음), 그리기 전에 스크롤을 되돌린다.
  useLayoutEffect(() => {
    const kept = keptScroll.current;
    keptScroll.current = null;
    if (kept && kept.el.scrollTop !== kept.top) kept.el.scrollTop = kept.top;
  }, [editing]);

  useEffect(() => {
    if (!editing) return undefined;
    const handler = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const row = rowRef.current;
      if (!target || !row || row.contains(target)) return;
      const overlay = target.closest?.(OVERLAY_SELECTOR);
      if (overlay && !overlay.contains(row)) return;
      switchEditing(null);
    };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, [editing, switchEditing]);

  useEffect(() => {
    if (!editing) return undefined;
    const frame = requestAnimationFrame(() => {
      const editable = rowRef.current?.querySelector<HTMLElement>('[contenteditable="true"]');
      const spot = caretSpot.current;
      caretSpot.current = null;
      if (editable) placeCaret(editable, spot);
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
          switchEditing(null);
        }
      }}
      sx={{
        position: 'relative',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 0.5,
        px: 0.5,
        py: variant === 'compact' ? (comfortable ? 0.3 : 0.25) : 0.5,
        borderRadius: '8px',
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
              // 최대 높이 없음 — 긴 메모도 읽기 화면처럼 다 펼친다(편집기 안 스크롤 없이 화면 스크롤 하나).
              maxHeight="none"
              // 편집 중 우클릭(서식 메뉴)에서도 행 메뉴와 같은 '맨 위로 보내기'. 본문 초안은 그대로 남는다.
              contextMenuActions={[{
                key: 'move-top',
                label: '맨 위로 보내기',
                icon: <VerticalAlignTopIcon />,
                onSelect: () => actions.moveToTop(item, location),
                disabled: firstInPlace,
                disabledReason: '이미 맨 위에 있습니다',
              }]}
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
              if (onOpenEdit) {
                onOpenEdit();
                return;
              }
              const content = event.currentTarget.querySelector<HTMLElement>('[data-testid="personal-memo-content"]');
              caretSpot.current = content ? caretSpotFromPoint(content, event.clientX, event.clientY) : null;
              switchEditing(item.id);
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                caretSpot.current = null;
                if (onOpenEdit) onOpenEdit();
                else switchEditing(item.id);
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

      <MemoMenu item={item} location={location} anchor={menu} firstInPlace={firstInPlace} onClose={() => setMenu(null)} />
    </Box>
  );
}
