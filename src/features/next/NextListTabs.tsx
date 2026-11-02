/**
 * Next 의 List 탭 — 기본 Next + 주제별 List.
 *   · 탭은 폭에 맞춰 자동 줄바꿈된다(가로 스크롤 없음). 많으면 두 줄만 보이고 [List 더 보기 · N개] 로 펼친다.
 *     선택한 List 가 가려지면 오른쪽에 함께 보여 준다(선택은 접기·펼치기와 무관하다).
 *   · 우클릭 · 선택한 List 의 ⋮ : 이름 변경 · 삭제. 탭에 마우스를 올리면 삭제 ×.
 *   · 삭제는 확인을 거쳐 휴지통으로(7일 복구, 설정 → 휴지통). 끌어서 순서 바꾸기.
 *   · 연결된 List 의 이름 변경·삭제는 모든 기기가 함께 쓰는 기능이라 PLAN-A Work 공통 관리 기능이 준비될 때까지 막아 둔다(이유를 메뉴에 보인다).
 * List 하나가 문서 1건이므로 연결도 List 단위다(머리 줄의 연동 아이콘).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import CloseIcon from '@mui/icons-material/Close';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQueryClient } from '@tanstack/react-query';
import type { NextListInfo } from '../../domain/types';
import { errorMessage, nextListService, trashService } from '../../tauri/api';
import { refreshMemo, useLists } from '../../services/queries';
import { dayTone, MEMO_CARD, MEMO_CARD_BORDER, MEMO_CARD_BORDER_HOVER, MEMO_CARD_SHADOW, MEMO_MUTED, NEXT_LABEL } from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import { usePersonalMemo } from '../memo/MemoProvider';
import SyncMark from '../sync/SyncMark';
import { hiddenTabIndexes, LIST_COLLAPSED_HEIGHT, LIST_TAB_GAP, LIST_TAB_HEIGHT } from './listTabRows';

const LINKED_RENAME_MESSAGE = '연결된 List의 이름 변경은 PLAN-A Work 공통 관리 기능이 준비된 후 사용할 수 있습니다.';
const LINKED_DELETE_MESSAGE = '연결된 List의 삭제는 PLAN-A Work 공통 관리 기능이 준비된 후 사용할 수 있습니다. 연동을 해제하면 이 PC의 List로 삭제할 수 있습니다.';

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
      <DialogTitle>{title}</DialogTitle>
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

const tabSx = (selected: boolean) => {
  const tone = dayTone('next');
  return {
    position: 'relative',
    flexShrink: 0, gap: 0.75, px: 1.5, height: LIST_TAB_HEIGHT, boxSizing: 'border-box', borderRadius: '8px',
    border: '1px solid', borderColor: selected ? 'rgba(109, 40, 217, 0.30)' : MEMO_CARD_BORDER,
    bgcolor: selected ? tone.soft : MEMO_CARD, color: selected ? tone.text : 'text.primary',
    boxShadow: selected ? 'none' : MEMO_CARD_SHADOW,
    fontWeight: selected ? 700 : 600, fontSize: '0.82rem', maxWidth: 240,
    transition: 'background-color 0.15s, border-color 0.15s',
    '&:hover': { borderColor: selected ? 'rgba(109, 40, 217, 0.45)' : MEMO_CARD_BORDER_HOVER },
    '&:hover .list-tab-close, &:focus-visible .list-tab-close': { opacity: 1 },
    '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
  } as const;
};

function TabFace({ card, selected }: { card: NextListInfo; selected: boolean }) {
  const tone = dayTone('next');
  return (
    <>
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
    </>
  );
}

function ListTab({
  card,
  selected,
  onSelect,
  onContextMenu,
  onDelete,
}: {
  card: NextListInfo;
  selected: boolean;
  onSelect: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onDelete: () => void;
}) {
  const tone = dayTone('next');
  const sortable = useSortable({ id: card.id, disabled: card.isDefault });
  const name = card.isDefault ? NEXT_LABEL : card.name;
  return (
    <ButtonBase
      ref={sortable.setNodeRef}
      style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition, opacity: sortable.isDragging ? 0.6 : 1 }}
      {...(card.isDefault ? {} : sortable.attributes)}
      {...(card.isDefault ? {} : sortable.listeners)}
      role="tab"
      aria-selected={selected}
      title={name}
      data-testid="memo-next-list-tab"
      data-list-id={card.id}
      onClick={() => {
        if (!selected) onSelect();
      }}
      onContextMenu={onContextMenu}
      onKeyDown={event => {
        if (event.key === 'Delete' && !card.isDefault) {
          event.preventDefault();
          onDelete();
        }
      }}
      sx={tabSx(selected)}
    >
      <TabFace card={card} selected={selected} />
      {!card.isDefault && !card.document?.syncEnabled && (
        // 탭 안의 작은 ×. 끌기·탭 선택과 겹치지 않게 눌림을 여기서 끝낸다. 키보드는 탭에서 Delete.
        <Box
          component="span"
          className="list-tab-close"
          role="button"
          aria-label={`${name} List 삭제`}
          data-testid="memo-next-list-delete"
          onPointerDown={event => event.stopPropagation()}
          onClick={event => {
            event.stopPropagation();
            onDelete();
          }}
          sx={{
            position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)', width: 18, height: 18, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0, transition: 'opacity 0.1s',
            bgcolor: selected ? tone.soft : MEMO_CARD, color: MEMO_MUTED,
            '&:hover': { color: 'error.main', bgcolor: 'rgba(220, 38, 38, 0.08)' },
          }}
        >
          <CloseIcon sx={{ fontSize: 13 }} />
        </Box>
      )}
    </ButtonBase>
  );
}

/** List 관리 메뉴의 항목 — 우클릭과 ⋮ 가 같다. 연결된 List 는 이유를 보이며 막는다. */
function listManageItems(card: NextListInfo, onRename: () => void, onDelete: () => void, testIds: { rename?: string; remove?: string } = {}) {
  const linked = !!card.document?.syncEnabled;
  const reasonSx = { '&.Mui-disabled': { opacity: 0.8 }, whiteSpace: 'normal', maxWidth: 320 };
  return [
    <MenuItem key="rename" dense disabled={linked} data-testid={testIds.rename} onClick={onRename} sx={reasonSx}>
      <ListItemIcon><EditOutlinedIcon fontSize="small" /></ListItemIcon>
      <ListItemText primary="이름 변경" secondary={linked ? LINKED_RENAME_MESSAGE : undefined} />
    </MenuItem>,
    <MenuItem key="delete" dense disabled={linked} data-testid={testIds.remove} onClick={onDelete} sx={{ ...reasonSx, color: linked ? undefined : 'error.main' }}>
      <ListItemIcon><DeleteOutlineIcon fontSize="small" color={linked ? undefined : 'error'} /></ListItemIcon>
      <ListItemText primary="삭제" secondary={linked ? LINKED_DELETE_MESSAGE : undefined} />
    </MenuItem>,
  ];
}

export default function NextListTabs({ activeListId, onSelect }: { activeListId: string | null; onSelect: (listId: string | null) => void }) {
  const { notify } = usePersonalMemo();
  const queryClient = useQueryClient();
  const { data } = useLists();
  const cards = data ?? [];
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [contextMenu, setContextMenu] = useState<{ card: NextListInfo; top: number; left: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<NextListInfo | null>(null);
  const [deleting, setDeleting] = useState<NextListInfo | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const activeCard = cards.find(c => !c.isDefault && c.id === activeListId) ?? null;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // 접기/펼치기 — 화면 표시만 바꾼다(List 데이터·선택은 그대로).
  const [expanded, setExpanded] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const tabsRef = useRef<HTMLDivElement>(null);
  const cardKey = cards.map(c => `${c.id}:${c.name}:${c.itemCount}`).join('|');
  useLayoutEffect(() => {
    const box = tabsRef.current;
    if (!box) return undefined;
    const measure = () => {
      const tabs = Array.from(box.querySelectorAll<HTMLElement>('[data-testid="memo-next-list-tab"]'));
      const hidden = hiddenTabIndexes(tabs.map(tab => tab.offsetTop)).map(index => tabs[index].dataset.listId ?? '');
      setHiddenIds(current => (current.join('|') === hidden.join('|') ? current : hidden));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [cardKey]);
  const activeId = activeListId ?? cards.find(c => c.isDefault)?.id;
  const pinned = !expanded && hiddenIds.includes(activeId ?? '') ? cards.find(c => c.id === activeId) ?? null : null;
  useEffect(() => {
    if (!hiddenIds.length) setExpanded(false);
  }, [hiddenIds.length]);

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

  const moveToTrash = async () => {
    const card = deleting;
    if (!card || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await nextListService.remove(card.id);
      setDeleting(null);
      // 보고 있던 List 가 사라졌으면 기본 Next 로.
      if (card.id === activeListId) onSelect(null);
      refreshMemo(queryClient);
      notify({
        message: `'${card.name}' List 를 휴지통으로 옮겼습니다. 7일 동안 복구할 수 있습니다(설정 → 휴지통).`,
        actionLabel: '되돌리기',
        onAction: () =>
          void trashService
            .restore(card.id)
            .then(() => refreshMemo(queryClient))
            .catch(error => notify({ message: errorMessage(error, '되돌리지 못했습니다.'), variant: 'error' })),
      });
    } catch (error) {
      setDeleting(null);
      refreshMemo(queryClient);
      notify({ message: errorMessage(error, 'List 를 삭제하지 못했습니다.'), variant: 'error' });
    } finally {
      setDeleteBusy(false);
    }
  };

  const openContextMenu = (card: NextListInfo) => (event: React.MouseEvent) => {
    event.preventDefault();
    // 기본 Next 는 이름을 바꾸거나 지울 수 없어 메뉴가 없다.
    if (!card.isDefault) setContextMenu({ card, top: event.clientY, left: event.clientX });
  };

  return (
    <Box data-testid="memo-next-lists" sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75, flexShrink: 0 }}>
      <Box
        ref={tabsRef}
        role="tablist"
        aria-label="Next List"
        data-testid="memo-next-list-tabs"
        data-expanded={expanded ? 'true' : 'false'}
        sx={{
          flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: `${LIST_TAB_GAP}px`, alignContent: 'flex-start',
          // 넘치는 줄만 가린다(탭 그림자가 잘리지 않을 만큼의 여유는 패딩으로).
          ...(expanded ? {} : { maxHeight: LIST_COLLAPSED_HEIGHT + 4, overflow: 'hidden' }),
          p: '2px', m: '-2px',
        }}
      >
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={cards.map(c => c.id)} strategy={rectSortingStrategy}>
            {cards.map(card => (
              <ListTab
                key={card.id}
                card={card}
                selected={card.isDefault ? activeListId === null : card.id === activeListId}
                onSelect={() => onSelect(card.isDefault ? null : card.id)}
                onContextMenu={openContextMenu(card)}
                onDelete={() => (card.document?.syncEnabled ? notify({ message: LINKED_DELETE_MESSAGE }) : setDeleting(card))}
              />
            ))}
          </SortableContext>
        </DndContext>
      </Box>
      <Box data-testid="memo-next-list-actions" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0, minHeight: LIST_TAB_HEIGHT }}>
        {pinned && (
          <ButtonBase data-testid="memo-next-list-pinned" title={pinned.name} onContextMenu={openContextMenu(pinned)} sx={{ ...tabSx(true), maxWidth: 160 }}>
            <TabFace card={pinned} selected />
          </ButtonBase>
        )}
        {(hiddenIds.length > 0 || expanded) && (
          <Button
            size="small"
            data-testid="memo-next-list-more"
            aria-expanded={expanded}
            endIcon={expanded ? <ExpandLessIcon sx={{ fontSize: 16 }} /> : <ExpandMoreIcon sx={{ fontSize: 16 }} />}
            onClick={() => setExpanded(value => !value)}
            sx={{ borderRadius: '8px', fontSize: '0.76rem', px: 1, height: LIST_TAB_HEIGHT, minWidth: 0, whiteSpace: 'nowrap', color: MEMO_MUTED }}
          >
            {expanded ? '접기' : `List 더 보기 · ${hiddenIds.length}개`}
          </Button>
        )}
        <Tooltip title="새 List 만들기">
          <Button
            size="small"
            startIcon={<AddIcon sx={{ fontSize: 16 }} />}
            onClick={() => setCreating(true)}
            data-testid="memo-next-list-create"
            sx={{ flexShrink: 0, borderRadius: '8px', fontSize: '0.78rem', px: 1.25, height: LIST_TAB_HEIGHT, minWidth: 0 }}
          >
            List
          </Button>
        </Tooltip>
        {activeCard && (
          <>
            <Tooltip title="List 관리">
              <IconButton size="small" aria-label={`${activeCard.name} List 관리`} data-testid="memo-next-list-menu" onClick={e => setMenuAnchor(e.currentTarget)}>
                <MoreVertIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)} data-personal-memo-overlay="true">
              {listManageItems(
                activeCard,
                () => { setMenuAnchor(null); setRenaming(activeCard); },
                () => { setMenuAnchor(null); setDeleting(activeCard); },
              )}
            </Menu>
          </>
        )}
      </Box>
      <Menu
        open={!!contextMenu}
        onClose={() => setContextMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={contextMenu ? { top: contextMenu.top, left: contextMenu.left } : undefined}
        data-personal-memo-overlay="true"
        data-testid="memo-next-list-context"
      >
        {contextMenu &&
          listManageItems(
            contextMenu.card,
            () => { setRenaming(contextMenu.card); setContextMenu(null); },
            () => { setDeleting(contextMenu.card); setContextMenu(null); },
            { rename: 'memo-next-list-rename', remove: 'memo-next-list-context-delete' },
          )}
      </Menu>
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
        title="List 이름 변경"
        initial={renaming?.name ?? ''}
        submitLabel="저장"
        onClose={() => setRenaming(null)}
        onSubmit={async name => {
          await nextListService.rename(renaming!.id, name);
          refreshMemo(queryClient);
          setRenaming(null);
        }}
      />
      <Dialog open={!!deleting} onClose={() => setDeleting(null)} data-personal-memo-overlay="true" data-testid="memo-list-delete-confirm" maxWidth="xs" fullWidth>
        <DialogTitle>List를 삭제하시겠습니까?</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: '0.88rem' }}>'{deleting?.name}' List를 삭제합니다.</Typography>
          <Typography sx={{ fontSize: '0.88rem', mt: 0.75 }}>
            {deleting?.itemCount
              ? `이 List에 포함된 메모 ${deleting.itemCount}개는 휴지통으로 이동하며, 7일 동안 복구할 수 있습니다.`
              : '비어 있는 List 입니다. 휴지통에서 7일 동안 복구할 수 있습니다.'}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)} autoFocus>취소</Button>
          <Button color="error" variant="contained" disabled={deleteBusy} data-testid="memo-list-delete-submit" onClick={() => void moveToTrash()}>
            휴지통으로 이동
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
