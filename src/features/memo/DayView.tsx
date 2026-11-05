/**
 * 날짜 상세(메인/오전/오후) 또는 Next List — Web PersonalMemoDayView 와 같은 배치.
 *   넓으면 메인(위, 전체 폭) + 오전·오후(아래, 나란히). 구역 이동·순서 변경은 끌기와 메뉴 둘 다 된다.
 * 하루 전체(또는 List 전체)가 문서 1건이므로 연결 버튼도 화면 위에 하나만 있다.
 *
 * 연결·지난 미완료 가져오기는 머리 줄 도구(연동·가져오기 아이콘)에 있다 — 본문 위에 따로 줄을 두지 않는다.
 *
 * 끌어서 옮기기: 끄는 동안 메모는 제자리에 있고(자리가 밀리지 않아 흔들리지 않는다) 커서를 따라가는 조각과 삽입선만 움직인다.
 * 삽입 위치는 메모 가운데선 + 여유 폭으로 정하고(domain/memoDrop), 놓은 순서는 저장을 기다리지 않고 바로 화면에 반영한다.
 *
 * 날짜 상세의 높이는 구역마다 자기 내용으로만 정해진다 — 창 높이나 다른 구역의 길이에 묶이지 않는다.
 *   · 비어 있으면 기본 높이(SECTION_BODY_MIN_HEIGHT), 메모가 생기면 입력칸이 자리를 내주고, 넘치면 그 구역만 자란다.
 *   · 오전·오후는 같은 줄이라 카드 외곽은 긴 쪽에 맞지만, 짧은 쪽의 입력칸은 카드를 따라 늘지 않는다.
 *   · 줄 높이에 fr 을 쓰지 않는다 — 높이가 정해지지 않은 Grid 에서 fr 비율은 가장 긴 구역 기준으로 다른 줄까지 늘린다.
 * 아래의 '지난 미완료 가져오기' 안내와 '다가오는 ○요일'(다음 같은 요일 메모장 — 그 자리에서 작성)은 그 아래에 이어진다.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { ItemSection, Location, MemoItem, MemoSection } from '../../domain/types';
import { insertIndex, planDrop } from '../../domain/memoDrop';
import { textOf } from '../../services/text';
import { MEMO_CARD, MEMO_CARD_BORDER, MEMO_CARD_SHADOW, MEMO_MUTED, MEMO_RADIUS, NEXT_LABEL } from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import { clearDomHighlights, paintDomHighlights } from '../../vendor/plan-a-work/components/personalMemo/memoSearchHighlight';
import { useDay, useNextList } from '../../services/queries';
import { usePersonalMemo } from './MemoProvider';
import { SECTION_LABELS } from './MemoMenu';
import MemoRow from './MemoRow';
import QuickInput from './QuickInput';
import CarryoverNotice from './CarryoverNotice';
import CarryReviews from './CarryReviews';
import UpcomingWeekday from './UpcomingWeekday';

const SECTIONS: MemoSection[] = ['main', 'am', 'pm'];
const SECTION_PLACEHOLDERS: Record<MemoSection, string> = {
  main: '오늘 꼭 해야 할 일을 적어보세요',
  am: '오전에 처리할 일을 적어보세요',
  pm: '오후에 처리할 일을 적어보세요',
};

/** 날짜 상세 구역 본문(메모 + 입력칸)의 기본 높이(px). 카드 전체는 제목·여백을 더해 메인 약 260, 오전·오후 약 205 — 최소 창에서도 '다가오는 ○요일' 이 첫 화면에 보인다. */
const SECTION_BODY_MIN_HEIGHT: Record<MemoSection, number> = { main: 200, am: 145, pm: 145 };

/** 커서에서 이만큼 벗어난 구역까지는 그 구역에 놓는 것으로 본다(px). 더 멀면 삽입선이 없고 놓아도 아무 일도 없다. */
const SECTION_REACH = 32;
/**
 * 끄는 동안 자동 스크롤은 창의 정말 가장자리에서만, 천천히. 기본값(위아래 20%)은 위쪽 메모들 사이에 놓으려 할 때도
 * 화면이 저절로 움직여 삽입 위치가 어긋난다.
 */
const DRAG_AUTO_SCROLL = { threshold: { x: 0, y: 0.08 }, acceleration: 6 };

interface DropTarget {
  section: ItemSection;
  index: number;
}
interface DropLine {
  section: ItemSection;
  top: number;
  left: number;
  width: number;
}

function DraggableMemo({ item, location, firstInPlace }: { item: MemoItem; location: Location; firstInPlace: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `memo:${item.id}`, data: { item } });
  return (
    <Box ref={setNodeRef} data-drop-row={item.id}>
      <MemoRow
        item={item}
        location={location}
        variant="full"
        comfortable
        firstInPlace={firstInPlace}
        dragging={isDragging}
        dragHandleProps={{ ...(attributes as object), ...(listeners as object) }}
      />
    </Box>
  );
}

const Section = memo(function Section({
  title,
  items,
  location,
  section,
  hint,
  minRows,
  autoFocus,
  area,
  grow,
  bodyMinHeight = 0,
  isOver,
}: {
  title: string | null;
  items: MemoItem[];
  location: Location;
  section: ItemSection;
  hint: string;
  minRows: number;
  autoFocus: boolean;
  area: string;
  /** Next List — 메모가 있어도 입력칸을 minRows 로 두고 창 높이를 채운다. 날짜 상세는 메모가 있으면 한 줄부터(기본 높이의 남은 자리는 채운다). */
  grow: boolean;
  /** 본문의 기본 높이. 입력칸은 이 안에서만 채운다 — 같은 줄의 긴 카드에 맞춰 늘어난 자리까지 따라가지 않는다. */
  bodyMinHeight?: number;
  isOver: boolean;
}) {
  const checklist = items.filter(m => m.kind === 'checklist');
  const done = checklist.filter(m => m.completed).length;
  return (
    <Box
      data-testid={`memo-section-${section}`}
      data-drop-section={section}
      tabIndex={-1}
      aria-label={title || `${NEXT_LABEL} 메모`}
      sx={{
        gridArea: area,
        outline: 'none',
        border: '1px solid',
        borderColor: isOver ? 'primary.main' : MEMO_CARD_BORDER,
        borderRadius: MEMO_RADIUS,
        px: { xs: 1.5, sm: 2.25 },
        pt: { xs: 1.25, sm: 2 },
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
          <Typography sx={{ fontWeight: 700, fontSize: '0.98rem', flex: 1, letterSpacing: '-0.01em' }}>{title}</Typography>
          {checklist.length > 0 && (
            <Typography sx={{ fontSize: '0.72rem', color: MEMO_MUTED, fontVariantNumeric: 'tabular-nums' }}>
              {done}/{checklist.length} 완료
            </Typography>
          )}
        </Box>
      )}
      <Box sx={{ flex: grow ? '1 1 0' : '0 0 auto', minHeight: bodyMinHeight, display: 'flex', flexDirection: 'column' }}>
        {items.map((item, index) => (
          <DraggableMemo key={item.id} item={item} location={location} firstInPlace={index === 0} />
        ))}
        <Box data-drop-input sx={{ mt: items.length ? 1 : 0, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <QuickInput
            location={location}
            section={section}
            placeholder={hint}
            minRows={grow ? minRows : items.length ? 1 : minRows}
            autoFocus={autoFocus}
            fill
          />
        </Box>
      </Box>
    </Box>
  );
});

export default function DayView({
  location,
  focusSection = null,
  editItemId = null,
  highlight = null,
}: {
  location: Location;
  focusSection?: MemoSection | null;
  editItemId?: string | null;
  highlight?: { itemId: string; tokens: string[] } | null;
}) {
  const { actions, setEditingId } = usePersonalMemo();
  const isNext = location.kind === 'next';
  const dayQuery = useDay(isNext ? null : location.date);
  const listQuery = useNextList(isNext ? location.listId : null, isNext);
  const query = isNext ? listQuery : dayQuery;
  const items: MemoItem[] = useMemo(() => query.data?.items ?? [], [query.data]);
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

  // ── 끌어서 옮기기 ───────────────────────────────────────────────
  const [activeItem, setActiveItem] = useState<MemoItem | null>(null);
  const [dropLine, setDropLine] = useState<DropLine | null>(null);
  const dropTarget = useRef<DropTarget | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const stopTracking = useRef<(() => void) | null>(null);
  const bySectionRef = useRef(bySection);
  bySectionRef.current = bySection;

  // 커서 자리에서 구역과 틈을 계산해 삽입선을 옮긴다. 값이 바뀔 때만 다시 그린다.
  const updateDrop = useCallback((active: MemoItem) => {
    const grid = gridRef.current;
    if (!grid) return;
    const { x, y } = pointer.current;
    let nearest: { el: HTMLElement; distance: number } | null = null;
    grid.querySelectorAll<HTMLElement>('[data-drop-section]').forEach(el => {
      const rect = el.getBoundingClientRect();
      const distance = Math.hypot(Math.max(rect.left - x, 0, x - rect.right), Math.max(rect.top - y, 0, y - rect.bottom));
      if (!nearest || distance < nearest.distance) nearest = { el, distance };
    });
    const found = nearest as { el: HTMLElement; distance: number } | null;
    if (!found || found.distance > SECTION_REACH) {
      dropTarget.current = null;
      setDropLine(null);
      return;
    }
    const section = found.el.dataset.dropSection as ItemSection;
    const rows = Array.from(found.el.querySelectorAll<HTMLElement>('[data-drop-row]')).map(el => el.getBoundingClientRect());
    const previous = dropTarget.current?.section === section ? dropTarget.current.index : null;
    const index = insertIndex(rows.map(rect => rect.top + rect.height / 2), y, previous);
    dropTarget.current = { section, index };
    const ids = bySectionRef.current[section].map(m => m.id);
    // 제자리에 놓는 위치에는 선을 그리지 않는다(놓아도 바뀌는 것이 없다).
    if (active.section === section && !planDrop(ids, active.id, index)) {
      setDropLine(null);
      return;
    }
    const box = found.el.getBoundingClientRect();
    const input = found.el.querySelector<HTMLElement>('[data-drop-input]')?.getBoundingClientRect();
    const top = !rows.length
      ? input?.top ?? box.top + 40
      : index === 0
        ? rows[0].top
        : index >= rows.length
          ? rows[rows.length - 1].bottom
          : (rows[index - 1].bottom + rows[index].top) / 2;
    const left = box.left + 8;
    const width = box.width - 16;
    setDropLine(line =>
      line && line.section === section && line.top === top && line.left === left && line.width === width ? line : { section, top, left, width },
    );
  }, []);

  const endDrag = useCallback(() => {
    stopTracking.current?.();
    stopTracking.current = null;
    setActiveItem(null);
    setDropLine(null);
  }, []);
  useEffect(() => () => stopTracking.current?.(), []);

  const onDragStart = (event: DragStartEvent) => {
    const active = (event.active.data.current as { item?: MemoItem })?.item;
    if (!active) return;
    const start = event.activatorEvent as PointerEvent;
    pointer.current = { x: start.clientX, y: start.clientY };
    dropTarget.current = { section: active.section, index: bySection[active.section].findIndex(m => m.id === active.id) };
    setActiveItem(active);
    // 여러 번의 움직임·스크롤을 한 프레임에 한 번만 계산한다(스크롤만 해도 삽입선이 맞게 따라온다).
    let frame = 0;
    const schedule = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          updateDrop(active);
        });
      }
    };
    const onMove = (move: PointerEvent) => {
      pointer.current = { x: move.clientX, y: move.clientY };
      schedule();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('scroll', schedule, true);
    stopTracking.current = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('scroll', schedule, true);
    };
  };

  const onDragEnd = () => {
    const active = activeItem;
    if (active) updateDrop(active); // 마지막 프레임을 놓치지 않게 놓은 자리에서 한 번 더
    const target = dropTarget.current;
    endDrag();
    if (!active || !target) return;
    const ids = planDrop(bySection[target.section].map(m => m.id), active.id, target.index);
    if (ids) actions.reorder(location, target.section, ids);
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

  return (
    <Box
      data-testid="personal-memo-day"
      sx={{
        display: 'flex', flexDirection: 'column', gap: 1, minHeight: 0,
        ...(isNext ? { flex: 1 } : { flex: '0 0 auto' }),
        ...(activeItem ? { userSelect: 'none', '& *': { cursor: 'grabbing !important' } } : {}),
        '& [data-search-hit="true"]': {
          bgcolor: 'rgba(250, 204, 21, 0.16)',
          boxShadow: '0 0 0 2px rgba(234, 179, 8, 0.45)',
          transition: 'background-color 0.4s, box-shadow 0.4s',
        },
      }}
    >
      <DndContext sensors={sensors} autoScroll={DRAG_AUTO_SCROLL} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={endDrag}>
        <Box
          ref={gridRef}
          data-testid="personal-memo-day-sections"
          sx={{
            display: 'grid',
            flex: isNext ? '1 1 0' : '0 0 auto',
            minHeight: 0,
            gap: { xs: 1.25, sm: 1.5 },
            gridTemplateColumns: isNext ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))',
            // 날짜 상세: 각 줄은 자기 내용 높이만큼(파일 머리 설명). Next List 는 구역 하나가 남은 자리를 채운다.
            gridTemplateRows: isNext ? 'minmax(min-content, 1fr)' : 'auto auto',
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
              grow
              isOver={dropLine?.section === 'next'}
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
                minRows={3}
                grow={false}
                bodyMinHeight={SECTION_BODY_MIN_HEIGHT[section]}
                isOver={dropLine?.section === section}
                autoFocus={focusSection === section && !editItemId}
                hint={SECTION_PLACEHOLDERS[section]}
              />
            ))
          )}
        </Box>
        {/* 화면에 떠 있어 메모 자리를 밀지 않는다. */}
        {dropLine && (
          <Box
            data-testid="memo-drop-line"
            aria-hidden
            style={{ top: dropLine.top, left: dropLine.left, width: dropLine.width }}
            sx={{ position: 'fixed', height: 2, mt: '-1px', bgcolor: 'primary.main', borderRadius: 1, pointerEvents: 'none', zIndex: theme => theme.zIndex.modal + 1 }}
          >
            <Box
              component="span"
              sx={{
                position: 'absolute', left: '50%', top: 1, transform: 'translate(-50%, -50%)', px: 1, lineHeight: '18px', borderRadius: '9px', whiteSpace: 'nowrap',
                fontSize: '0.68rem', fontWeight: 700, color: '#fff', bgcolor: 'primary.main',
              }}
            >
              여기에 놓기
            </Box>
          </Box>
        )}
        <DragOverlay dropAnimation={null} style={{ pointerEvents: 'none' }}>
          {activeItem && (
            <Box
              data-testid="memo-drag-preview"
              sx={{
                width: 'fit-content', maxWidth: 420, px: 1.5, py: 0.75, borderRadius: '8px', bgcolor: MEMO_CARD, cursor: 'grabbing',
                border: '1px solid rgba(37, 99, 235, 0.45)', boxShadow: '0 6px 18px rgba(28, 25, 23, 0.16)',
                fontSize: '0.86rem', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere',
              }}
            >
              {textOf(activeItem.contentHtml) || '(이미지·표 메모)'}
            </Box>
          )}
        </DragOverlay>
      </DndContext>
      {location.kind === 'day' && (
        <>
          <CarryReviews date={location.date} />
          <CarryoverNotice date={location.date} />
          <UpcomingWeekday date={location.date} />
        </>
      )}
    </Box>
  );
}
