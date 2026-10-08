/**
 * 날짜 상세(메인/오전/오후) 또는 Next List — Web PersonalMemoDayView 와 같은 배치.
 *   넓으면 메인(위, 전체 폭) + 오전·오후(아래, 나란히). 구역 이동·순서 변경은 끌기와 메뉴 둘 다 된다.
 * 하루 전체(또는 List 전체)가 문서 1건이므로 연결 버튼도 화면 위에 하나만 있다.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DocumentInfo, ItemSection, Location, MemoItem, MemoSection } from '../../domain/types';
import { koreanMonthDay, locationLabel } from '../../domain/location';
import { MEMO_CARD, MEMO_CARD_BORDER, MEMO_CARD_SHADOW, MEMO_MUTED, MEMO_RADIUS, NEXT_LABEL } from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import { clearDomHighlights, paintDomHighlights } from '../../vendor/plan-a-work/components/personalMemo/memoSearchHighlight';
import { useDay, useNextList } from '../../services/queries';
import { LinkControl } from '../sync/SyncMark';
import { usePersonalMemo } from './MemoProvider';
import { SECTION_LABELS } from './MemoMenu';
import MemoRow from './MemoRow';
import QuickInput from './QuickInput';

const SECTIONS: MemoSection[] = ['main', 'am', 'pm'];
const SECTION_PLACEHOLDERS: Record<MemoSection, string> = {
  main: '오늘 꼭 해야 할 일을 적어보세요',
  am: '오전에 처리할 일을 적어보세요',
  pm: '오후에 처리할 일을 적어보세요',
};

function SortableMemo({ item, location }: { item: MemoItem; location: Location }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `memo:${item.id}`, data: { item } });
  return (
    <Box ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <MemoRow
        item={item}
        location={location}
        variant="full"
        comfortable
        dragging={isDragging}
        dragHandleProps={{ ...(attributes as object), ...(listeners as object) }}
      />
    </Box>
  );
}

function Section({
  title,
  items,
  location,
  section,
  hint,
  minRows,
  autoFocus,
  area,
}: {
  title: string | null;
  items: MemoItem[];
  location: Location;
  section: ItemSection;
  hint: string;
  minRows: number;
  autoFocus: boolean;
  area: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `section:${section}` });
  const checklist = items.filter(m => m.kind === 'checklist');
  const done = checklist.filter(m => m.completed).length;
  return (
    <Box
      ref={setNodeRef}
      data-testid={`memo-section-${section}`}
      tabIndex={-1}
      aria-label={title || `${NEXT_LABEL} 메모`}
      sx={{
        gridArea: area,
        outline: 'none',
        border: '1px solid',
        borderColor: isOver ? 'primary.main' : MEMO_CARD_BORDER,
        borderRadius: MEMO_RADIUS,
        px: { xs: 1.5, sm: 2 },
        pt: { xs: 1.25, sm: 1.75 },
        pb: { xs: 1, sm: 1.25 },
        bgcolor: MEMO_CARD,
        boxShadow: MEMO_CARD_SHADOW,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        '&:focus-within': { borderColor: 'rgba(37, 99, 235, 0.45)', boxShadow: `0 0 0 3px rgba(37, 99, 235, 0.08), ${MEMO_CARD_SHADOW}` },
      }}
    >
      {title && (
        <Box sx={{ display: 'flex', alignItems: 'baseline', mb: 1, px: 0.25 }}>
          <Typography sx={{ fontWeight: 700, fontSize: '0.92rem', flex: 1, letterSpacing: '-0.01em' }}>{title}</Typography>
          {checklist.length > 0 && (
            <Typography sx={{ fontSize: '0.72rem', color: MEMO_MUTED, fontVariantNumeric: 'tabular-nums' }}>
              {done}/{checklist.length} 완료
            </Typography>
          )}
        </Box>
      )}
      <SortableContext items={items.map(m => `memo:${m.id}`)} strategy={verticalListSortingStrategy}>
        {items.map(item => (
          <SortableMemo key={item.id} item={item} location={location} />
        ))}
      </SortableContext>
      <Box sx={{ mt: items.length ? 1 : 0, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <QuickInput location={location} section={section} placeholder={hint} minRows={minRows} autoFocus={autoFocus} fill />
      </Box>
    </Box>
  );
}

export default function DayView({
  location,
  focusSection = null,
  editItemId = null,
  highlight = null,
  listName = null,
}: {
  location: Location;
  focusSection?: MemoSection | null;
  editItemId?: string | null;
  highlight?: { itemId: string; tokens: string[] } | null;
  listName?: string | null;
}) {
  const { actions, setEditingId, openHistory } = usePersonalMemo();
  const isNext = location.kind === 'next';
  const dayQuery = useDay(isNext ? null : location.date);
  const listQuery = useNextList(isNext ? location.listId : null, isNext);
  const query = isNext ? listQuery : dayQuery;
  const items: MemoItem[] = useMemo(() => query.data?.items ?? [], [query.data]);
  const document: DocumentInfo | null = isNext ? listQuery.data?.list.document ?? null : dayQuery.data?.document ?? null;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editItemId && query.data) setEditingId(editItemId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editItemId, !!query.data]);

  // 검색 결과에서 들어왔으면 그 메모로 스크롤 + 검색어 강조(본문 DOM 은 바꾸지 않는다).
  const highlightKey = highlight ? `${highlight.itemId}:${highlight.tokens.join(' ')}` : '';
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!highlight || !query.data || !grid) return undefined;
    const row = grid.querySelector<HTMLElement>(`[data-testid="personal-memo-row"][data-memo-id="${highlight.itemId}"]`);
    row?.scrollIntoView({ block: 'center' });
    row?.setAttribute('data-search-hit', 'true');
    let frame = 0;
    const paint = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => paintDomHighlights(grid, highlight.tokens));
    };
    paint();
    const observer = new MutationObserver(paint);
    observer.observe(grid, { childList: true, subtree: true, characterData: true });
    const timer = window.setTimeout(() => row?.removeAttribute('data-search-hit'), 2400);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.clearTimeout(timer);
      row?.removeAttribute('data-search-hit');
      clearDomHighlights();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightKey, !!query.data]);

  const bySection = useMemo(() => {
    const map: Record<ItemSection, MemoItem[]> = { main: [], am: [], pm: [], next: [] };
    items.forEach(item => map[item.section].push(item));
    return map;
  }, [items]);

  const onDragEnd = (event: DragEndEvent) => {
    const item = (event.active.data.current as { item?: MemoItem })?.item;
    const overId = String(event.over?.id || '');
    if (!item || !overId) return;
    const sections: ItemSection[] = isNext ? ['next'] : SECTIONS;
    let target: ItemSection;
    let overItemId: string | null = null;
    if (overId.startsWith('memo:')) {
      overItemId = overId.slice(5);
      const found = sections.find(s => bySection[s].some(m => m.id === overItemId));
      if (!found) return;
      target = found;
    } else if (overId.startsWith('section:')) {
      target = overId.slice(8) as ItemSection;
    } else {
      return;
    }
    const current = bySection[target].map(m => m.id);
    let ids: string[];
    if (item.section === target) {
      const from = current.indexOf(item.id);
      const to = overItemId === null ? current.length - 1 : current.indexOf(overItemId);
      if (from < 0 || to < 0 || from === to) return;
      ids = arrayMove(current, from, to);
    } else {
      ids = current.filter(id => id !== item.id);
      const at = overItemId === null ? ids.length : Math.max(0, ids.indexOf(overItemId));
      ids.splice(at, 0, item.id);
    }
    actions.reorder(location, target, ids);
  };

  if (query.isPending && !query.data) return <CircularProgress size={22} sx={{ m: 2 }} />;
  if (query.isError) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography color="error" sx={{ fontSize: '0.85rem', mb: 1 }}>메모를 불러오지 못했습니다.</Typography>
        <Button size="small" onClick={() => void query.refetch()}>다시 시도</Button>
      </Box>
    );
  }

  const label = location.kind === 'day' ? koreanMonthDay(location.date) : listName || NEXT_LABEL;
  return (
    <Box
      data-testid="personal-memo-day"
      sx={{
        display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minHeight: 0,
        '& [data-search-hit="true"]': {
          bgcolor: 'rgba(250, 204, 21, 0.16)',
          boxShadow: '0 0 0 2px rgba(234, 179, 8, 0.45)',
          transition: 'background-color 0.4s, box-shadow 0.4s',
        },
      }}
    >
      <LinkControl
        document={document}
        location={location}
        label={label}
        onOpenHistory={() => openHistory(location, locationLabel(location, listName))}
      />
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <Box
          ref={gridRef}
          data-testid="personal-memo-day-sections"
          sx={{
            display: 'grid',
            flex: '1 1 0',
            minHeight: 0,
            gap: { xs: 1.25, sm: 1.5 },
            gridTemplateColumns: isNext ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))',
            gridTemplateRows: isNext ? 'minmax(min-content, 1fr)' : 'minmax(min-content, 1.1fr) minmax(min-content, 1fr)',
            gridTemplateAreas: isNext ? '"main"' : '"main main" "am pm"',
          }}
        >
          {isNext ? (
            <Section
              area="main"
              title={null}
              items={bySection.next}
              location={location}
              section="next"
              minRows={6}
              autoFocus={!!focusSection && !editItemId}
              hint="언젠가 할 일, 떠오른 아이디어를 적어두세요"
            />
          ) : (
            SECTIONS.map(section => (
              <Section
                key={section}
                area={section}
                title={SECTION_LABELS[section]}
                items={bySection[section]}
                location={location}
                section={section}
                minRows={section === 'main' ? 4 : 3}
                autoFocus={focusSection === section && !editItemId}
                hint={SECTION_PLACEHOLDERS[section]}
              />
            ))
          )}
        </Box>
      </DndContext>
    </Box>
  );
}
