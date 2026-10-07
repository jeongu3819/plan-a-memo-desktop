/**
 * Next 의 List 탭 줄 — 기본 Next + 주제별 List (Web PersonalMemoNextLists 와 같은 모양).
 * List 만들기 · 이름 바꾸기 · 삭제(메모는 기본 Next 로) · 끌어서 순서 바꾸기.
 * List 하나가 문서 1건이므로 연결도 List 단위다(연결 버튼은 List 페이지 위쪽).
 */
import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  ButtonBase,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQueryClient } from '@tanstack/react-query';
import type { NextListInfo } from '../../domain/types';
import { errorMessage, nextListService } from '../../tauri/api';
import { refreshMemo, useLists } from '../../services/queries';
import { dayTone, MEMO_CARD, MEMO_CARD_BORDER, MEMO_MUTED, NEXT_LABEL } from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import { usePersonalMemo } from '../memo/MemoProvider';
import SyncMark from '../sync/SyncMark';

export function ListNameDialog({
  open,
  title,
  initial = '',
  submitLabel,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial?: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(initial);
    setError(null);
  }, [open, initial]);
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} data-personal-memo-overlay="true" data-testid="memo-list-name-dialog" fullWidth maxWidth="xs">
      <DialogTitle sx={{ fontSize: '1rem', fontWeight: 800 }}>{title}</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          size="small"
          value={name}
          onChange={event => setName(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="예: 앱 개발, 회사 업무"
          inputProps={{ maxLength: 100, 'aria-label': 'List 이름' }}
          error={!!error}
          helperText={error || ' '}
          sx={{ mt: 0.5 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>취소</Button>
        <Button variant="contained" onClick={() => void submit()} disabled={!name.trim() || busy}>
          {submitLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ListTab({ card, selected, onSelect }: { card: NextListInfo; selected: boolean; onSelect: () => void }) {
  const tone = dayTone('next');
  const sortable = useSortable({ id: card.id, disabled: card.isDefault });
  return (
    <ButtonBase
      ref={sortable.setNodeRef}
      style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}
      {...(card.isDefault ? {} : sortable.attributes)}
      {...(card.isDefault ? {} : sortable.listeners)}
      role="tab"
      aria-selected={selected}
      data-testid="memo-next-list-tab"
      onClick={() => {
        if (!selected) onSelect();
      }}
      sx={{
        flexShrink: 0, gap: 0.75, px: 1.25, height: 32, borderRadius: 999,
        border: '1px solid', borderColor: selected ? tone.text : MEMO_CARD_BORDER,
        bgcolor: selected ? tone.soft : MEMO_CARD, color: selected ? tone.text : 'text.primary',
        fontWeight: selected ? 800 : 600, fontSize: '0.82rem', maxWidth: 240,
        opacity: sortable.isDragging ? 0.6 : 1,
        transition: 'background-color 0.15s, border-color 0.15s',
        '&:hover': { borderColor: tone.text },
        '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 1 },
      }}
    >
      <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {card.isDefault ? NEXT_LABEL : card.name}
      </Box>
      <Box component="span" sx={{ fontSize: '0.72rem', color: selected ? tone.text : MEMO_MUTED, fontWeight: 600 }}>
        {card.itemCount}
      </Box>
      {card.document?.syncEnabled && (
        <Box component="span" sx={{ display: 'inline-flex' }}>
          <SyncMark document={card.document} location={{ kind: 'next', listId: card.isDefault ? null : card.id }} compact />
        </Box>
      )}
    </ButtonBase>
  );
}

export default function NextListTabs({ activeListId, onSelect }: { activeListId: string | null; onSelect: (listId: string | null) => void }) {
  const { notify } = usePersonalMemo();
  const queryClient = useQueryClient();
  const { data } = useLists();
  const cards = data ?? [];
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<NextListInfo | null>(null);
  const [deleting, setDeleting] = useState<NextListInfo | null>(null);
  const activeCard = cards.find(c => !c.isDefault && c.id === activeListId) ?? null;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragEnd = (event: DragEndEvent) => {
    const topics = cards.filter(c => !c.isDefault).map(c => c.id);
    const from = topics.indexOf(String(event.active.id));
    const to = topics.indexOf(String(event.over?.id ?? ''));
    if (from < 0 || to < 0 || from === to) return;
    void nextListService
      .reorder(arrayMove(topics, from, to))
      .then(() => refreshMemo(queryClient))
      .catch(error => notify({ message: errorMessage(error, '순서를 바꾸지 못했습니다.'), variant: 'error' }));
  };

  return (
    <Box
      data-testid="memo-next-lists"
      role="tablist"
      aria-label="Next List"
      sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'nowrap', overflowX: 'auto', pb: 0.25, flexShrink: 0 }}
    >
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <SortableContext items={cards.map(c => c.id)} strategy={horizontalListSortingStrategy}>
          {cards.map(card => (
            <ListTab
              key={card.id}
              card={card}
              selected={card.isDefault ? activeListId === null : card.id === activeListId}
              onSelect={() => onSelect(card.isDefault ? null : card.id)}
            />
          ))}
        </SortableContext>
      </DndContext>
      <Tooltip title="새 List 만들기">
        <Button
          size="small"
          startIcon={<AddIcon sx={{ fontSize: 16 }} />}
          onClick={() => setCreating(true)}
          data-testid="memo-next-list-create"
          sx={{ flexShrink: 0, borderRadius: 999, fontSize: '0.78rem', px: 1.25, minWidth: 0 }}
        >
          List
        </Button>
      </Tooltip>
      {activeCard && (
        <>
          <Box sx={{ flex: 1 }} />
          <Tooltip title="List 관리">
            <IconButton size="small" aria-label={`${activeCard.name} List 관리`} data-testid="memo-next-list-menu" onClick={e => setMenuAnchor(e.currentTarget)}>
              <MoreVertIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)} data-personal-memo-overlay="true">
            <MenuItem dense onClick={() => { setMenuAnchor(null); setRenaming(activeCard); }}>
              <ListItemIcon><EditOutlinedIcon fontSize="small" /></ListItemIcon>
              <ListItemText primary="이름 바꾸기" />
            </MenuItem>
            <MenuItem dense onClick={() => { setMenuAnchor(null); setDeleting(activeCard); }} sx={{ color: 'error.main' }}>
              <ListItemIcon><DeleteOutlineIcon fontSize="small" color="error" /></ListItemIcon>
              <ListItemText primary="List 삭제" />
            </MenuItem>
          </Menu>
        </>
      )}
      <ListNameDialog
        open={creating}
        title="새 List"
        submitLabel="만들기"
        onClose={() => setCreating(false)}
        onSubmit={async name => {
          const created = await nextListService.create(name, crypto.randomUUID());
          refreshMemo(queryClient);
          setCreating(false);
          notify({ message: `'${created.name}' List 를 만들었습니다.`, variant: 'success' });
          onSelect(created.id);
        }}
      />
      <ListNameDialog
        open={!!renaming}
        title="List 이름 바꾸기"
        initial={renaming?.name ?? ''}
        submitLabel="바꾸기"
        onClose={() => setRenaming(null)}
        onSubmit={async name => {
          await nextListService.rename(renaming!.id, name);
          refreshMemo(queryClient);
          setRenaming(null);
        }}
      />
      <Dialog open={!!deleting} onClose={() => setDeleting(null)} data-personal-memo-overlay="true" data-testid="memo-list-delete-confirm">
        <DialogTitle sx={{ fontSize: '1rem', fontWeight: 800 }}>'{deleting?.name}' List 를 삭제할까요?</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: '0.88rem' }}>
            {deleting?.itemCount
              ? `안에 있는 메모 ${deleting.itemCount}개는 지워지지 않고 Next 로 옮겨집니다.`
              : '비어 있는 List 입니다.'}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)} autoFocus>취소</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              const card = deleting;
              setDeleting(null);
              if (!card) return;
              void nextListService
                .remove(card.id)
                .then(result => {
                  onSelect(null);
                  refreshMemo(queryClient);
                  notify({
                    message: result.movedCount
                      ? `'${card.name}' List 를 삭제했습니다. 메모 ${result.movedCount}개는 Next 로 옮겼습니다.`
                      : `'${card.name}' List 를 삭제했습니다.`,
                  });
                })
                .catch(error => notify({ message: errorMessage(error, 'List 를 삭제하지 못했습니다.'), variant: 'error' }));
            }}
          >
            List 삭제
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
