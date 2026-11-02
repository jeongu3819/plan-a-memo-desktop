/**
 * PLAN-A Memo 메인 화면 — Web 개인 메모 창(PersonalMemoWorkspaceDialog + Workspace)을 창 전체로.
 *
 *   ┌ October 10, 2026          (주간)  ‹ 이번 주 ›  │ [🔍] [오늘] [☁] [≡+] [⚙]
 *   │ 오늘도 좋은 하루예요~!    (날짜 상세) ← 주간 ‹ 토 10/10 Today › │ [🔍] [오늘] [☁] [≡+] [⚙]
 *   └ 주간(2×4) ↔ 날짜 상세 ↔ 검색·List(찾아보기)를 같은 자리에서 전환
 *
 * 머리는 한 줄 — 왼쪽 표지(날짜·인사말), 오른쪽 조작 묶음(화면 이동 │ 도구). 본문 위에 따로 줄을 두지 않는다.
 * 오른쪽 도구는 어느 화면에서나 같은 순서·크기다: 검색 — 아이콘 자리가 입력칸으로 펼쳐지고 결과·찾아보기(즐겨찾기 · Next List ·
 * 지난 메모 · History)는 본문에 · 오늘(**오늘 날짜의 상세**) · 연동(연결 상태·동기화·해제) · 지난 미완료 가져오기(날짜 상세에서만) · 설정.
 * History 는 연동과 상관없는 메모 기록이다 — 가운데 날짜·List 이름을 누르면 나오는 보조 메뉴(메모가 없는 날에도)와 메모 행 메뉴에 있다.
 * 주간의 ‹ › 가운데는 '이번 주·지난주·다음 주' — 더 먼 주는 실제 기간, 실제 기간은 항상 툴팁으로 볼 수 있다.
 * 날짜 이동은 도구 왼쪽의 ‹ › 뿐이다(주간은 기간, 날짜 상세는 그 날짜를 가운데 표시) — 같은 요일 고르기 메뉴는 두지 않는다
 * (날짜 상세 아래 '다가오는 같은 요일' 카드가 대신한다).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Button, ButtonBase, Chip, IconButton, InputBase, ListItemIcon, ListItemText, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import { GlobalStyles } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HistoryIcon from '@mui/icons-material/History';
import NotificationsActiveOutlinedIcon from '@mui/icons-material/NotificationsActiveOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import { listen } from '@tauri-apps/api/event';
import {
  addDays,
  dayLabelWithYear,
  localDayString,
  longEnglishDate,
  weekStart,
} from '../../vendor/plan-a-work/utils/personalMemoDates';
import {
  dayTone,
  MEMO_CARD,
  MEMO_CARD_BORDER,
  MEMO_CARD_SHADOW,
  MEMO_NOTE_DATE,
  MEMO_NOTE_GREETING,
  MEMO_NOTE_SERIF,
  MEMO_SECTION_TITLE,
  MEMO_SURFACE,
  NEXT_LABEL,
  TodayBadge,
} from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import { MEMO_SEARCH_HIGHLIGHT } from '../../vendor/plan-a-work/components/personalMemo/memoSearchHighlight';
import type { DueReminder, Location, MemoSection } from '../../domain/types';
import { isNextKey, koreanMonthDay, locationKey, locationLabel, parseLocationKey } from '../../domain/location';
import { weekLabel, weekRangeText } from '../../domain/memoBrowse';
import { koreanLongDate } from '../../domain/dayTools';
import { dayToolsService, isTauri } from '../../tauri/api';
import { useDay, useLists, useNextList, useSyncOverview } from '../../services/queries';
import { useAppUi } from '../../app/AppUi';
import { SyncHeaderButton } from '../sync/SyncMark';
import { CarryoverButton } from './CarryoverNotice';
import { usePersonalMemo } from './MemoProvider';
import { MemoSaveIndicator } from './MemoSaveIndicator';
import WeekView, { type OpenDayOptions } from './WeekView';
import DayView from './DayView';
import NextListTabs from '../next/NextListTabs';
import BrowseView, { type OpenTarget } from '../search/BrowseView';

type View =
  | { kind: 'week'; monday: string }
  | {
      kind: 'day';
      key: string;
      monday: string;
      focusSection?: MemoSection;
      editItemId?: string;
      highlight?: { itemId: string; tokens: string[] };
      fromBrowse?: boolean;
    }
  | { kind: 'browse'; monday: string; focusSearch?: boolean };

/** 머리 줄 오른쪽 도구(검색 · 오늘 · 설정) — 이동 묶음과 같은 32px 높이·모서리·테두리·hover. */
const HEADER_BUTTON_SX = {
  height: 32,
  px: 1.5,
  minWidth: 0,
  fontSize: '0.78rem',
  borderRadius: '8px',
  border: '1px solid',
  borderColor: MEMO_CARD_BORDER,
  boxShadow: MEMO_CARD_SHADOW,
  bgcolor: MEMO_CARD,
  color: MEMO_SECTION_TITLE,
  '&:hover': { bgcolor: 'action.hover', borderColor: MEMO_CARD_BORDER },
} as const;
const HEADER_ICON_SX = { ...HEADER_BUTTON_SX, width: 32, px: 0 } as const;
const HEADER_BUTTON_ACTIVE_SX = {
  bgcolor: 'rgba(37, 99, 235, 0.08)', color: 'primary.main', borderColor: 'rgba(37, 99, 235, 0.35)',
  '&:hover': { bgcolor: 'rgba(37, 99, 235, 0.12)', borderColor: 'rgba(37, 99, 235, 0.5)' },
} as const;

/** 동기화에 문제가 있을 때만 머리에 작게 보인다(평소에는 아무것도 없다). */
function SyncProblems() {
  const ui = useAppUi();
  const { data } = useSyncOverview();
  if (!data || data.linkedDocuments === 0) return null;
  const chips: Array<{ label: string; color: 'error' | 'warning' | 'default'; onClick?: () => void }> = [];
  if (data.conflicts > 0) chips.push({ label: `내용 확인 필요 ${data.conflicts}`, color: 'error', onClick: () => ui.openConflicts() });
  if (data.authRequired > 0) chips.push({ label: '로그인 필요', color: 'warning', onClick: () => ui.openAccount('PLAN-A Work 계정 연결이 필요합니다.') });
  if (data.errors > 0) chips.push({ label: '동기화 오류', color: 'error', onClick: ui.openSettings });
  if (data.pending > 0 && data.lastReport?.offline) chips.push({ label: '전달 대기', color: 'default', onClick: ui.openSettings });
  return (
    <>
      {chips.map(chip => (
        <Chip
          key={chip.label}
          size="small"
          label={chip.label}
          color={chip.color}
          variant={chip.color === 'default' ? 'outlined' : 'filled'}
          onClick={chip.onClick}
          data-testid="header-sync-problem"
          sx={{ height: 22, fontSize: '0.68rem', fontWeight: 700 }}
        />
      ))}
    </>
  );
}

/** 앱을 다시 열 때 찾은 놓친 알림 — 닫을 때까지 한 줄로(한 번만, 반복해서 띄우지 않는다). */
function MissedReminders({ items, onOpen, onDismiss }: { items: DueReminder[]; onOpen: (date: string) => void; onDismiss: () => void }) {
  if (!items.length) return null;
  return (
    <Box
      role="status"
      data-testid="missed-reminders"
      sx={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, px: 1.75, py: 0.75, borderRadius: '12px', flexShrink: 0,
        border: '1px solid', borderColor: 'rgba(37, 99, 235, 0.18)', bgcolor: 'rgba(37, 99, 235, 0.05)',
      }}
    >
      <NotificationsActiveOutlinedIcon sx={{ fontSize: 18, color: 'primary.main' }} />
      <Typography sx={{ fontSize: '0.8rem', fontWeight: 700 }}>놓친 알림</Typography>
      {items.map(item => (
        <Button key={item.date} size="small" onClick={() => onOpen(item.date)} sx={{ fontSize: '0.78rem', py: 0 }}>
          {koreanLongDate(item.date)} · 완료하지 않은 체크리스트 {item.openCount}개
        </Button>
      ))}
      <Box sx={{ flex: 1 }} />
      <IconButton size="small" aria-label="놓친 알림 닫기" onClick={onDismiss} sx={{ p: 0.5 }}>
        <CloseIcon sx={{ fontSize: 16 }} />
      </IconButton>
    </Box>
  );
}

export default function MemoWorkspace() {
  const { today, store, notify, setEditingId, openHistory } = usePersonalMemo();
  const ui = useAppUi();
  const lists = useLists();
  const [view, setViewState] = useState<View>({ kind: 'week', monday: weekStart(today) });
  const [lastDay, setLastDay] = useState<string | null>(null);
  const [browseQuery, setBrowseQuery] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const [beforeBrowse, setBeforeBrowse] = useState<View | null>(null);
  const [missed, setMissed] = useState<DueReminder[]>([]);
  const [docMenu, setDocMenu] = useState<HTMLElement | null>(null);

  // 화면 전환 — 편집 중인 메모는 닫으며 저장한다(저장 실패한 초안은 저장소에 남아 다시 시도할 수 있다).
  // 이미지를 넣는 중에는 옮기지 않는다(넣던 이미지를 잃지 않게).
  const setView = (next: View): boolean => {
    if (store.anyUploading()) {
      notify({ message: '이미지를 넣는 중입니다. 끝난 뒤 이동할 수 있습니다.' });
      return false;
    }
    setEditingId(null);
    setViewState(next);
    return true;
  };

  const isDay = view.kind === 'day';
  const isBrowse = view.kind === 'browse';
  const focusSearch = view.kind === 'browse' && !!view.focusSearch;
  // 검색 아이콘을 누르면 펼쳐진 머리 줄 입력칸에 바로 커서.
  useEffect(() => {
    if (focusSearch) searchInput.current?.focus({ preventScroll: true });
  }, [focusSearch, view]);
  const dayKey = isDay ? view.key : null;
  const onNext = isDay && isNextKey(dayKey);
  const location: Location | null = dayKey ? parseLocationKey(dayKey) : null;
  const listName =
    location?.kind === 'next' && location.listId ? lists.data?.find(l => l.id === location.listId)?.name ?? null : null;
  // 연동 아이콘이 보여 줄 지금 화면의 문서(본문과 같은 조회 — 캐시를 함께 쓴다).
  const dayDoc = useDay(location?.kind === 'day' ? location.date : null);
  const listDoc = useNextList(location?.kind === 'next' ? location.listId : null, location?.kind === 'next');
  const document = location?.kind === 'day' ? dayDoc.data?.document ?? null : location?.kind === 'next' ? listDoc.data?.list.document ?? null : null;

  const openDay = (key: string, options: OpenDayOptions = {}) => {
    setLastDay(key);
    setView({ kind: 'day', key, monday: view.monday, ...options });
  };
  /** 날짜 하나의 상세로(같은 요일 메뉴 · 다가오는 같은 요일 카드 · 알림 클릭 · 오늘). 이미 그 날짜면 화면을 다시 만들지 않는다. */
  const goToDate = (key: string) => {
    if (view.kind === 'day' && view.key === key && !view.fromBrowse) return;
    if (setView({ kind: 'day', key, monday: weekStart(key) })) setLastDay(key);
  };
  /** [오늘] — 누르는 순간 이 PC 의 날짜(자정을 지났으면 새 날짜)의 날짜 상세. */
  const goToday = () => goToDate(localDayString());
  const onToday = isDay && dayKey === today;

  // 알림을 눌러 앱이 열렸거나(실행 중이었거나) 링크로 온 날짜 → 그 날짜 상세. 놓친 알림은 한 줄 안내.
  const goToDateRef = useRef(goToDate);
  goToDateRef.current = goToDate;
  const takeMissed = useCallback(() => {
    void dayToolsService
      .takeMissedReminders()
      .then(items => {
        if (items.length) setMissed(current => [...current.filter(c => !items.some(i => i.date === c.date)), ...items]);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!isTauri()) return undefined;
    let alive = true;
    void dayToolsService
      .takePendingOpen()
      .then(date => {
        if (alive && date) goToDateRef.current(date);
      })
      .catch(() => undefined);
    takeMissed();
    const unlisten = [
      listen<string>('app://open-day', event => {
        void dayToolsService.takePendingOpen().catch(() => undefined);
        goToDateRef.current(event.payload);
      }),
      listen('reminder://missed', () => takeMissed()),
    ];
    return () => {
      alive = false;
      unlisten.forEach(p => void p.then(fn => fn()));
    };
  }, [takeMissed]);

  const openBrowse = (focusSearch: boolean) => {
    if (view.kind === 'browse') {
      setViewState({ ...view, focusSearch });
      return;
    }
    const keepOrigin = view.kind === 'day' && view.fromBrowse && beforeBrowse;
    if (setView({ kind: 'browse', monday: view.monday, focusSearch }) && !keepOrigin) setBeforeBrowse(view);
  };
  const leaveBrowse = () => {
    const back = beforeBrowse;
    setView(back && back.kind === 'day' ? { kind: 'day', key: back.key, monday: back.monday } : back ?? { kind: 'week', monday: view.monday });
  };
  const openFromBrowse = (target: OpenTarget) => {
    const key = locationKey(target.location);
    const monday = target.location.kind === 'day' ? weekStart(target.location.date) : view.monday;
    if (
      setView({
        kind: 'day',
        key,
        monday,
        fromBrowse: true,
        ...(target.itemId && target.tokens?.length ? { highlight: { itemId: target.itemId, tokens: target.tokens } } : {}),
      }) &&
      target.location.kind === 'day'
    ) {
      setLastDay(target.location.date);
    }
  };

  // 오른쪽 도구 — 어느 화면에서나 [검색] [오늘] [연동] [가져오기] [설정]. 찾아보기 화면에서 검색을 다시 누르면 검색창으로 돌아간다.
  const tools = (
    <Box data-testid="memo-header-tools" sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
      {isBrowse ? (
        // 아이콘 자리가 그대로 검색 입력칸이 된다(Web 과 같은 인라인 검색). 결과·찾아보기는 본문에.
        <Box
          role="search"
          data-testid="memo-search-field"
          sx={{
            display: 'flex', alignItems: 'center', height: 32, boxSizing: 'border-box', width: 260, minWidth: 0, flexShrink: 1, pl: 1, pr: 0.25,
            border: '1px solid', borderColor: 'primary.main', borderRadius: '8px', bgcolor: MEMO_CARD, boxShadow: '0 0 0 3px rgba(37, 99, 235, 0.10)',
          }}
        >
          <SearchIcon sx={{ fontSize: 18, color: 'primary.main', flexShrink: 0 }} />
          <InputBase
            inputRef={searchInput}
            value={browseQuery}
            placeholder="메모 · 날짜 검색 (11.2)"
            onChange={event => setBrowseQuery(event.target.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.key !== 'Escape') return;
              event.preventDefault();
              if (browseQuery) setBrowseQuery('');
              else leaveBrowse();
            }}
            inputProps={{ 'aria-label': '메모 검색', 'data-testid': 'memo-search-input', maxLength: 200 }}
            sx={{ flex: 1, minWidth: 0, mx: 0.75, fontSize: '0.84rem', '& input': { p: 0, height: 30 } }}
          />
          <IconButton size="small" aria-label="검색 닫기" data-testid="memo-search-close" onClick={leaveBrowse} sx={{ p: 0.5 }}>
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Box>
      ) : (
        <Tooltip title="검색 · List" disableInteractive>
          <IconButton
            aria-label="메모 검색 · List"
            data-testid="memo-search-open"
            onClick={() => openBrowse(true)}
            sx={HEADER_ICON_SX}
          >
            <SearchIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      )}
      <Tooltip title="오늘 날짜의 메모" disableInteractive>
        <Button
          size="small"
          aria-pressed={onToday}
          data-testid="memo-today"
          onClick={goToday}
          sx={{ ...HEADER_BUTTON_SX, ...(onToday ? HEADER_BUTTON_ACTIVE_SX : {}) }}
        >
          오늘
        </Button>
      </Tooltip>
      <SyncHeaderButton
        document={document}
        location={location}
        label={location?.kind === 'day' ? koreanMonthDay(location.date) : listName || NEXT_LABEL}
        sx={HEADER_ICON_SX}
      />
      <CarryoverButton date={location?.kind === 'day' ? location.date : null} sx={HEADER_ICON_SX} />
      <Tooltip title="설정" disableInteractive>
        <IconButton aria-label="설정" data-testid="open-settings" onClick={ui.openSettings} sx={HEADER_ICON_SX}>
          <SettingsOutlinedIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );

  // 도구 왼쪽의 화면 이동 — 주간: ‹ 이번 주 › · 날짜 상세: ← 주간 ‹ 날짜 Today › · 찾아보기: ← 메모장.
  const navControls = isBrowse ? (
    <Button size="small" startIcon={<ArrowBackIcon sx={{ fontSize: 16 }} />} onClick={leaveBrowse} data-testid="memo-browse-back" sx={{ height: 32, color: MEMO_SECTION_TITLE }}>
      메모장
    </Button>
  ) : (
    <>
      {isDay && view.fromBrowse && (
        <Button size="small" startIcon={<ArrowBackIcon sx={{ fontSize: 16 }} />} onClick={() => openBrowse(false)} data-testid="memo-back-to-browse" sx={{ mr: 0.25, height: 32, color: MEMO_SECTION_TITLE }}>
          목록
        </Button>
      )}
      {isDay && (
        <Button
          size="small"
          data-testid="memo-back-to-week"
          startIcon={view.fromBrowse ? undefined : <ArrowBackIcon sx={{ fontSize: 16 }} />}
          onClick={() => setView({ kind: 'week', monday: dayKey && !isNextKey(dayKey) ? weekStart(dayKey) : view.monday })}
          sx={{ mr: 0.5, height: 32, color: MEMO_SECTION_TITLE }}
        >
          주간
        </Button>
      )}
      <Box
        data-testid="personal-memo-nav"
        sx={{
          display: 'inline-flex', alignItems: 'center', gap: 0.25, px: 0.25, height: 32,
          borderRadius: '8px', border: '1px solid', borderColor: MEMO_CARD_BORDER, bgcolor: MEMO_CARD, boxShadow: MEMO_CARD_SHADOW,
          '& .MuiIconButton-root': { p: 0.5, borderRadius: '6px' },
        }}
      >
        {!onNext && (
          <Tooltip title={isDay ? '전날' : '지난주'}>
            <IconButton
              size="small"
              aria-label={isDay ? '전날' : '지난주'}
              onClick={() =>
                setView(isDay ? { kind: 'day', key: addDays(dayKey!, -1), monday: view.monday } : { kind: 'week', monday: addDays(view.monday, -7) })
              }
            >
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {/* 기간은 표시만 — 같은 요일 앞뒤 날짜는 아래 '다가오는 같은 요일' 카드가 맡는다(Web 과 같은 배치). 날짜·List 이름은 보조 메뉴를 연다. */}
        {!isDay && (
          <Tooltip title={weekRangeText(view.monday, today)} disableInteractive>
            <Typography
              data-testid="personal-memo-week-range"
              sx={{ fontWeight: 600, fontSize: '0.84rem', px: 0.5, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: 'text.primary' }}
            >
              {weekLabel(view.monday, today)}
            </Typography>
          </Tooltip>
        )}
        {isDay && (
          <Tooltip title="이 메모의 변경 이력" disableInteractive disableHoverListener={!!docMenu}>
            <ButtonBase
              aria-label={`${onNext ? NEXT_LABEL : dayLabelWithYear(dayKey!, today)} 메뉴`}
              aria-haspopup="menu"
              data-testid="memo-doc-menu"
              onClick={event => setDocMenu(event.currentTarget)}
              sx={{
                gap: 0.25, height: 28, px: 0.5, borderRadius: '6px',
                '&:hover': { bgcolor: 'action.hover' },
                '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
              }}
            >
              <Typography
                data-testid="personal-memo-view-label"
                sx={{
                  fontWeight: 700, fontSize: '0.9rem', px: onNext ? 1 : 0.25, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
                  color: onNext ? 'text.primary' : dayTone(dayKey!).text,
                }}
              >
                {onNext ? NEXT_LABEL : dayLabelWithYear(dayKey!, today)}
              </Typography>
              {dayKey === today && <TodayBadge />}
              <ExpandMoreIcon sx={{ fontSize: 16, color: MEMO_SECTION_TITLE }} />
            </ButtonBase>
          </Tooltip>
        )}
        {isDay && location && (
          <Menu anchorEl={docMenu} open={!!docMenu} onClose={() => setDocMenu(null)} data-personal-memo-overlay="true" data-testid="memo-doc-menu-list">
            <MenuItem
              dense
              data-testid="memo-open-history"
              onClick={() => {
                setDocMenu(null);
                openHistory(location, locationLabel(location, listName));
              }}
            >
              <ListItemIcon><HistoryIcon fontSize="small" /></ListItemIcon>
              <ListItemText primary="변경 이력(History)" secondary="이전 내용 보기 · 복원 (연동 없이 사용)" />
            </MenuItem>
          </Menu>
        )}
        {!onNext && (
          <Tooltip title={isDay ? '다음 날' : '다음 주'}>
            <IconButton
              size="small"
              aria-label={isDay ? '다음 날' : '다음 주'}
              onClick={() =>
                setView(isDay ? { kind: 'day', key: addDays(dayKey!, 1), monday: view.monday } : { kind: 'week', monday: addDays(view.monday, 7) })
              }
            >
              <ChevronRightIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>
    </>
  );

  return (
    <Box data-testid="personal-memo-workspace" sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: MEMO_SURFACE }}>
      <GlobalStyles styles={{ [`::highlight(${MEMO_SEARCH_HIGHLIGHT})`]: { backgroundColor: 'rgba(250, 204, 21, 0.55)', color: 'inherit' } }} />
      {/* 노트 표지 — 왼쪽 오늘 날짜(serif) + 인사말, 오른쪽 같은 줄에 조작 묶음(화면 이동 │ 검색·오늘·설정).
          창이 좁으면 조작 묶음이 표지 아래로 내려간다(겹치지 않는다). */}
      <Box
        component="header"
        data-testid="memo-dialog-header"
        sx={{ display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', columnGap: 2, rowGap: 1, px: 3, pt: 2, pb: 1.5, flexShrink: 0 }}
      >
        <Box sx={{ flex: '1 1 220px', minWidth: 0, pt: 0.25, pl: 0.25 }}>
          <Typography
            component="h1"
            data-testid="memo-header-date"
            noWrap
            sx={{ fontFamily: MEMO_NOTE_SERIF, fontSize: '1.875rem', fontWeight: 400, letterSpacing: '0.4px', lineHeight: 1.15, color: MEMO_NOTE_DATE }}
          >
            {longEnglishDate(today)}
          </Typography>
          <Typography
            data-testid="memo-header-greeting"
            noWrap
            sx={{ mt: 0.75, fontSize: '0.875rem', fontWeight: 400, lineHeight: 1.4, letterSpacing: '0.2px', color: MEMO_NOTE_GREETING }}
          >
            오늘도 좋은 하루예요~!
          </Typography>
        </Box>
        <Box
          data-testid="personal-memo-view-header"
          sx={{ ml: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', columnGap: 1, rowGap: 0.75, flexWrap: 'wrap', minHeight: 32, pt: 0.25 }}
        >
          {/* 동기화에 문제가 있을 때만 작게 · 저장 상태(알릴 것이 있을 때만 — 비어 있으면 빈 자리) */}
          <SyncProblems />
          <MemoSaveIndicator hideSaved fixedSlot />
          <Box data-testid="memo-header-nav" sx={{ display: 'flex', alignItems: 'center', gap: 0.25, minWidth: 0 }}>{navControls}</Box>
          <Box aria-hidden sx={{ width: '1px', height: 20, bgcolor: MEMO_CARD_BORDER, mx: 0.25 }} />
          {tools}
        </Box>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 3, pb: 2.5, pt: 0.25, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <MissedReminders
          items={missed}
          onOpen={date => {
            setMissed(current => current.filter(m => m.date !== date));
            // 알림 안내에서 그 날짜를 연 것은 명시적 확인 — 연결된 날짜면 PLAN-A Work 에도 확인으로 남는다(날짜만 연 것과 다르다).
            void dayToolsService.confirmReminder(date).catch(() => undefined);
            goToDate(date);
          }}
          onDismiss={() => setMissed([])}
        />
        {view.kind === 'browse' ? (
          <BrowseView query={browseQuery} onQueryChange={setBrowseQuery} focusSearch={!!view.focusSearch} onOpen={openFromBrowse} headerSearch />
        ) : view.kind === 'day' && location ? (
          <>
            {location.kind === 'next' && (
              <NextListTabs
                activeListId={location.listId}
                onSelect={listId => setView({ kind: 'day', key: locationKey({ kind: 'next', listId }), monday: view.monday, fromBrowse: view.fromBrowse })}
              />
            )}
            <DayView
              key={view.key}
              location={location}
              focusSection={view.focusSection ?? null}
              editItemId={view.editItemId ?? null}
              highlight={view.highlight ?? null}
            />
          </>
        ) : (
          <WeekView monday={view.monday} onOpenDay={openDay} activeKey={lastDay} />
        )}
      </Box>

    </Box>
  );
}
