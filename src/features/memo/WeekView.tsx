/**
 * 주간 화면 — 2열 × 4행(월|화, 수|목, 금|토, 일|Next). Web PersonalMemoWeekView 와 같은 카드·간격·배지.
 * 카드를 누르면 그 날짜 상세(메인/오전/오후)로, 메모를 누르면 그 메모 편집으로 들어간다.
 * 메모를 다른 칸으로 끌어 놓으면 그 날짜로 옮긴다.
 */
import { useMemo, useRef, useState } from 'react';
import { Box, Button, ButtonBase, CircularProgress, Tooltip, Typography } from '@mui/material';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { DocumentInfo, Location, MemoItem, MemoSection } from '../../domain/types';
import { NEXT_KEY } from '../../domain/location';
import { weekDays, weekdayOf, shortDate, dayLabel, WEEKDAY_LABELS } from '../../vendor/plan-a-work/utils/personalMemoDates';
import { pickSectionPreview, SECTION_ORDER } from '../../vendor/plan-a-work/components/personalMemo/personalMemoPreview';
import {
  dayTone,
  MEMO_CARD,
  MEMO_CARD_BORDER,
  MEMO_CARD_BORDER_HOVER,
  MEMO_CARD_SHADOW,
  MEMO_CARD_SHADOW_HOVER,
  MEMO_GROUP_DIVIDER,
  MEMO_MUTED,
  MEMO_RADIUS,
  MEMO_SECTION_TITLE,
  MEMO_WRITE_AREA,
  NEXT_LABEL,
  TodayBadge,
} from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import { useWeek } from '../../services/queries';
import { textOf } from '../../services/text';
import { usePersonalMemo } from './MemoProvider';
import { SECTION_LABELS } from './MemoMenu';
import MemoRow from './MemoRow';
import SyncMark from '../sync/SyncMark';

const PREVIEW_COUNT = 5;

export interface OpenDayOptions {
  focusSection?: MemoSection;
  editItemId?: string;
}

const CARD_CLICK_IGNORE = [
  'button', 'a', 'input', 'textarea', '[contenteditable="true"]', '[aria-label="끌어서 옮기기"]', '[data-memo-card-ignore]',
].join(',');
const CLICK_SLOP_PX = 5;

function DraggableMemo({ item, location, onOpenEdit }: { item: MemoItem; location: Location; onOpenEdit: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `memo:${item.id}`, data: { item } });
  return (
    <Box ref={setNodeRef}>
      <MemoRow
        item={item}
        location={location}
        variant="compact"
        comfortable
        dragging={isDragging}
        dragHandleProps={{ ...(attributes as object), ...(listeners as object) }}
        onOpenEdit={onOpenEdit}
      />
    </Box>
  );
}

function DayCell({
  cellKey,
  items,
  document,
  isToday,
  isActive,
  onOpenDay,
}: {
  cellKey: string;
  items: MemoItem[];
  document: DocumentInfo | null;
  isToday: boolean;
  isActive: boolean;
  onOpenDay: (key: string, options?: OpenDayOptions) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `cell:${cellKey}` });
  const [expanded, setExpanded] = useState(false);
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const isNext = cellKey === NEXT_KEY;
  const tone = dayTone(cellKey);
  const label = isNext ? NEXT_LABEL : dayLabel(cellKey);
  const location: Location = isNext ? { kind: 'next', listId: null } : { kind: 'day', date: cellKey };

  let groups: Array<[MemoSection | null, MemoItem[]]>;
  if (isNext) {
    groups = [[null, expanded ? items : items.slice(0, PREVIEW_COUNT)]];
  } else {
    const bySection: Record<MemoSection, MemoItem[]> = {
      main: items.filter(m => m.section === 'main'),
      am: items.filter(m => m.section === 'am'),
      pm: items.filter(m => m.section === 'pm'),
    };
    const shown = expanded ? bySection : pickSectionPreview(bySection, PREVIEW_COUNT);
    groups = SECTION_ORDER.map(section => [section, shown[section]] as [MemoSection, MemoItem[]]).filter(([, list]) => list.length > 0);
  }
  const hiddenCount = items.length - groups.reduce((sum, [, list]) => sum + list.length, 0);
  const checklist = items.filter(m => m.kind === 'checklist');
  const done = checklist.filter(m => m.completed).length;

  return (
    <Box
      ref={setNodeRef}
      data-testid={`memo-cell-${cellKey}`}
      data-tone={tone.kind}
      data-active={isActive ? 'true' : undefined}
      tabIndex={-1}
      aria-label={`${label} 메모`}
      onPointerDown={event => {
        pressRef.current = { x: event.clientX, y: event.clientY };
      }}
      onClick={event => {
        const target = event.target as Element;
        if (!event.currentTarget.contains(target)) return;
        if (target.closest(CARD_CLICK_IGNORE)) return;
        const press = pressRef.current;
        if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP_PX) return;
        if ((window.getSelection()?.toString() || '').trim()) return;
        onOpenDay(cellKey, { focusSection: 'main' });
      }}
      sx={{
        outline: 'none',
        position: 'relative',
        cursor: 'pointer',
        border: '1px solid',
        borderColor: isOver ? 'primary.main' : isActive ? 'rgba(37, 99, 235, 0.45)' : MEMO_CARD_BORDER,
        bgcolor: isOver ? tone.soft : MEMO_CARD,
        boxShadow: isActive ? `0 0 0 3px rgba(37, 99, 235, 0.08), ${MEMO_CARD_SHADOW}` : MEMO_CARD_SHADOW,
        borderRadius: MEMO_RADIUS,
        px: { xs: 1.75, sm: 2.25 },
        pt: { xs: 1.5, sm: 1.75 },
        pb: { xs: 1.5, sm: 1.75 },
        minHeight: 140,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        transition: 'border-color 0.15s, background-color 0.15s, box-shadow 0.2s',
        '&:hover': {
          borderColor: isActive ? 'primary.main' : MEMO_CARD_BORDER_HOVER,
          boxShadow: isActive ? `0 0 0 3px rgba(37, 99, 235, 0.08), ${MEMO_CARD_SHADOW_HOVER}` : MEMO_CARD_SHADOW_HOVER,
        },
        '&:hover .memo-cell-empty-hint': { opacity: 1 },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.25, minHeight: 30 }}>
        <ButtonBase
          onClick={event => {
            event.stopPropagation();
            onOpenDay(cellKey, { focusSection: 'main' });
          }}
          aria-label={`${label} 메모 쓰기`}
          sx={{
            borderRadius: '8px', pr: 0.75, gap: 1, alignItems: 'center',
            '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 1 },
          }}
        >
          <Box
            component="span"
            sx={{
              minWidth: 30, height: 30, px: isNext ? 1.1 : 0, borderRadius: '8px',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              // 오늘은 요일 표시만 채운 강조색 — 칸 전체를 칠하지 않고 한눈에 찾게.
              bgcolor: isToday ? 'primary.main' : tone.soft,
              color: isToday ? '#FFFFFF' : tone.text,
              fontWeight: 700, fontSize: isNext ? '0.88rem' : '0.95rem', lineHeight: 1, letterSpacing: isNext ? '0.01em' : 0,
            }}
          >
            {isNext ? NEXT_LABEL : WEEKDAY_LABELS[weekdayOf(cellKey)]}
          </Box>
          {!isNext && (
            <Typography
              component="span"
              sx={{
                fontSize: '0.82rem', fontWeight: 500, fontVariantNumeric: 'tabular-nums',
                color: tone.kind === 'weekday' ? MEMO_SECTION_TITLE : tone.text,
              }}
            >
              {shortDate(cellKey)}
            </Typography>
          )}
        </ButtonBase>
        {isToday && <TodayBadge />}
        <SyncMark document={document} location={location} compact />
        <Box sx={{ flex: 1 }} />
        {isNext && (
          <Tooltip title="날짜를 정하지 않은 메모">
            <Typography sx={{ fontSize: '0.72rem', color: MEMO_MUTED }}>날짜 미정</Typography>
          </Tooltip>
        )}
        {checklist.length > 0 && (
          <Typography
            sx={{
              fontSize: '0.72rem', fontWeight: 600, color: done === checklist.length ? '#15803D' : MEMO_MUTED,
              bgcolor: done === checklist.length ? '#ECFDF3' : MEMO_WRITE_AREA,
              borderRadius: '6px', px: 0.85, lineHeight: '20px', fontVariantNumeric: 'tabular-nums',
            }}
            aria-label="체크리스트 완료"
          >
            {done}/{checklist.length}
          </Typography>
        )}
      </Box>

      <Box sx={{ flex: 1, minWidth: 0 }}>
        {items.length === 0 && (
          <Typography
            className="memo-cell-empty-hint"
            aria-hidden
            sx={{ fontSize: '0.8rem', color: 'text.disabled', px: 0.5, opacity: 0, transition: 'opacity 0.15s' }}
          >
            + 메모 쓰기
          </Typography>
        )}
        {groups.map(([section, list], index) => (
          <Box
            key={section ?? 'next'}
            data-testid={`memo-cell-group-${section ?? 'next'}`}
            sx={index > 0 ? { mt: 1, pt: 1, borderTop: '1px solid', borderColor: MEMO_GROUP_DIVIDER } : undefined}
          >
            {section && (
              <Typography sx={{ fontSize: '0.7rem', fontWeight: 600, color: MEMO_MUTED, letterSpacing: '0.02em', mb: 0.25, px: 0.25 }}>
                {SECTION_LABELS[section]}
              </Typography>
            )}
            {list.map(item => (
              <DraggableMemo
                key={item.id}
                item={item}
                location={location}
                onOpenEdit={() => onOpenDay(cellKey, { editItemId: item.id })}
              />
            ))}
          </Box>
        ))}
        {!expanded && hiddenCount > 0 && (
          <Button size="small" onClick={() => setExpanded(true)} sx={{ fontSize: '0.72rem', py: 0, mt: 0.25 }}>
            +{hiddenCount} 더 보기
          </Button>
        )}
        {expanded && items.length > PREVIEW_COUNT && (
          <Button size="small" onClick={() => setExpanded(false)} sx={{ fontSize: '0.72rem', py: 0, mt: 0.25 }}>
            접기
          </Button>
        )}
      </Box>
    </Box>
  );
}

export default function WeekView({
  monday,
  onOpenDay,
  activeKey = null,
}: {
  monday: string;
  onOpenDay: (key: string, options?: OpenDayOptions) => void;
  activeKey?: string | null;
}) {
  const { today, actions } = usePersonalMemo();
  const days = useMemo(() => weekDays(monday), [monday]);
  const { data, isPending, isError, refetch } = useWeek(monday);
  const [activeItem, setActiveItem] = useState<MemoItem | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragStart = (event: DragStartEvent) => {
    setActiveItem((event.active.data.current as { item?: MemoItem })?.item ?? null);
  };
  // 보이는 칸으로 끌어 놓으면 그 칸의 실제 날짜로 옮긴다.
  const onDragEnd = (event: DragEndEvent) => {
    setActiveItem(null);
    const item = (event.active.data.current as { item?: MemoItem })?.item;
    const overId = String(event.over?.id || '');
    if (!item || !overId.startsWith('cell:') || !data) return;
    const key = overId.slice(5);
    const sourceDoc = item.documentId;
    if (key === NEXT_KEY) {
      if (data.next.list.document?.id !== sourceDoc) void actions.move({ item, target: { kind: 'next', listId: null } });
      return;
    }
    const targetDoc = data.days.find(d => d.date === key)?.document?.id;
    if (targetDoc !== sourceDoc) void actions.move({ item, target: { kind: 'day', date: key } });
  };

  if (isPending && !data) return <CircularProgress size={22} sx={{ m: 2 }} />;
  if (isError || !data) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography color="error" sx={{ fontSize: '0.85rem', mb: 1 }}>메모를 불러오지 못했습니다.</Typography>
        <Button size="small" onClick={() => void refetch()}>다시 시도</Button>
      </Box>
    );
  }

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveItem(null)}>
      <Box
        data-testid="personal-memo-week"
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gridAutoRows: 'minmax(140px, auto)',
          alignContent: 'stretch',
          flex: 1,
          gap: { xs: 1.25, sm: 1.75 },
        }}
      >
        {days.map(date => {
          const day = data.days.find(d => d.date === date);
          return (
            <DayCell
              key={date}
              cellKey={date}
              items={day?.items ?? []}
              document={day?.document ?? null}
              isToday={date === today}
              isActive={date === activeKey}
              onOpenDay={onOpenDay}
            />
          );
        })}
        <DayCell
          cellKey={NEXT_KEY}
          items={data.next.items}
          document={data.next.list.document}
          isToday={false}
          isActive={activeKey === NEXT_KEY}
          onOpenDay={onOpenDay}
        />
      </Box>
      <DragOverlay dropAnimation={null}>
        {activeItem ? (
          <Box sx={{ bgcolor: 'background.paper', border: '1px solid', borderColor: MEMO_CARD_BORDER, boxShadow: '0 12px 28px -6px rgba(15, 23, 42, 0.18)', borderRadius: '8px', px: 1.5, py: 0.75, maxWidth: 320 }}>
            <Typography noWrap sx={{ fontSize: '0.84rem' }}>{textOf(activeItem.contentHtml) || '메모'}</Typography>
          </Box>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
