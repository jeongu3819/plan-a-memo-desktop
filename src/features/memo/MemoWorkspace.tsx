/**
 * PLAN-A Memo 메인 화면 — Web 개인 메모 창(PersonalMemoWorkspaceDialog + Workspace)을 창 전체로.
 *
 *   ┌ October 7, 2026                       [동기화 문제 시만] ⚙
 *   │ 오늘도 좋은 하루예요~!         저장상태 · ‹ 이번 주 › · 오늘 · 🔍 · List · 내보내기
 *   └ 주간(2×4) ↔ 날짜 상세 ↔ List(찾아보기)를 같은 자리에서 전환
 */
import { useState } from 'react';
import { Box, Button, ButtonBase, Chip, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import SearchIcon from '@mui/icons-material/Search';
import ViewListOutlinedIcon from '@mui/icons-material/ViewListOutlined';
import CheckIcon from '@mui/icons-material/Check';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import {
  addDays,
  dayLabelWithYear,
  longEnglishDate,
  SAME_WEEKDAY_RELATIVE,
  sameWeekdayAround,
  weekRangeLabel,
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
import { GlobalStyles } from '@mui/material';
import type { Location, MemoSection } from '../../domain/types';
import { isNextKey, locationKey, parseLocationKey } from '../../domain/location';
import { useLists, useSyncOverview } from '../../services/queries';
import { useAppUi } from '../../app/AppUi';
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

/** 머리 줄의 보조 버튼(오늘 · List) — 이동 묶음(32px)과 같은 높이·모서리. */
const HEADER_BUTTON_SX = { height: 32, px: 1.5, minWidth: 0, fontSize: '0.78rem', borderRadius: '8px', borderColor: MEMO_CARD_BORDER, boxShadow: MEMO_CARD_SHADOW } as const;
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

export default function MemoWorkspace() {
  const { today, store, notify, setEditingId } = usePersonalMemo();
  const ui = useAppUi();
  const lists = useLists();
  const [view, setViewState] = useState<View>({ kind: 'week', monday: weekStart(today) });
  const [lastDay, setLastDay] = useState<string | null>(null);
  const [jumpAnchor, setJumpAnchor] = useState<HTMLElement | null>(null);
  const [browseQuery, setBrowseQuery] = useState('');
  const [beforeBrowse, setBeforeBrowse] = useState<View | null>(null);

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
  const dayKey = isDay ? view.key : null;
  const onNext = isDay && isNextKey(dayKey);
  const location: Location | null = dayKey ? parseLocationKey(dayKey) : null;
  const listName =
    location?.kind === 'next' && location.listId ? lists.data?.find(l => l.id === location.listId)?.name ?? null : null;

  const openDay = (key: string, options: OpenDayOptions = {}) => {
    setLastDay(key);
    setView({ kind: 'day', key, monday: view.monday, ...options });
  };
  const browseToDay = (key: string) => {
    setJumpAnchor(null);
    if (view.kind === 'day' && view.key === key) return;
    if (setView({ kind: 'day', key, monday: weekStart(key) })) setLastDay(key);
  };
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

  const browseControls = (
    <>
      <Tooltip title="메모 전체 검색">
        <IconButton size="small" aria-label="메모 검색" data-testid="memo-search-open" onClick={() => openBrowse(true)} sx={{ ml: 0.25 }}>
          <SearchIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Button
        size="small"
        variant="outlined"
        startIcon={<ViewListOutlinedIcon sx={{ fontSize: 16 }} />}
        aria-pressed={isBrowse}
        data-testid="memo-browse-open"
        onClick={() => (isBrowse ? leaveBrowse() : openBrowse(false))}
        sx={{ ...HEADER_BUTTON_SX, ...(isBrowse ? HEADER_BUTTON_ACTIVE_SX : {}) }}
      >
        List
      </Button>
      <Tooltip title="내보내기">
        <IconButton size="small" aria-label="내보내기" onClick={ui.openExport}>
          <FileDownloadOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </>
  );

  const navControls = isBrowse ? (
    <>
      <Button size="small" startIcon={<ArrowBackIcon sx={{ fontSize: 16 }} />} onClick={leaveBrowse} data-testid="memo-browse-back" sx={{ mr: 0.5, height: 32, color: MEMO_SECTION_TITLE }}>
        메모장
      </Button>
      {browseControls}
    </>
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
        {isDay && !onNext ? (
          <ButtonBase
            aria-haspopup="menu"
            aria-expanded={!!jumpAnchor}
            aria-label={`${dayLabelWithYear(dayKey!, today)} — 같은 요일 날짜 고르기`}
            onClick={event => setJumpAnchor(event.currentTarget)}
            sx={{ borderRadius: '6px', pl: 0.75, pr: 0.25, py: 0.25, height: 26, '&:hover': { bgcolor: 'action.hover' } }}
          >
            <Typography data-testid="personal-memo-view-label" sx={{ fontWeight: 700, fontSize: '0.9rem', color: dayTone(dayKey!).text }}>
              {dayLabelWithYear(dayKey!, today)}
            </Typography>
            <ArrowDropDownIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
          </ButtonBase>
        ) : (
          <Typography data-testid="personal-memo-view-label" sx={{ fontWeight: 700, fontSize: '0.9rem', minWidth: 76, textAlign: 'center', color: 'text.primary', px: onNext ? 1.5 : 0.5 }}>
            {isDay ? NEXT_LABEL : weekRangeLabel(view.monday, today)}
          </Typography>
        )}
        {isDay && dayKey === today && <TodayBadge />}
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
      <Button
        size="small"
        variant="outlined"
        onClick={() => setView(isDay ? { kind: 'day', key: today, monday: weekStart(today) } : { kind: 'week', monday: weekStart(today) })}
        sx={{ ...HEADER_BUTTON_SX, ml: 0.5 }}
      >
        오늘
      </Button>
      {browseControls}
    </>
  );

  return (
    <Box data-testid="personal-memo-workspace" sx={{ height: '100vh', display: 'flex', flexDirection: 'column', bgcolor: MEMO_SURFACE }}>
      <GlobalStyles styles={{ [`::highlight(${MEMO_SEARCH_HIGHLIGHT})`]: { backgroundColor: 'rgba(250, 204, 21, 0.55)', color: 'inherit' } }} />
      {/* 노트 표지 — 오늘 날짜(serif) + 인사말, 오른쪽에 이동·찾기 조작(Web 메모 창 머리와 같다). */}
      <Box
        component="header"
        data-testid="memo-dialog-header"
        sx={{ display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', columnGap: 2, rowGap: 0.5, px: 3, pt: 2, pb: 1.25, flexShrink: 0 }}
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
        <Box sx={{ ml: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.5, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mr: -1, minHeight: 32 }}>
            <SyncProblems />
            <Tooltip title="설정">
              <IconButton aria-label="설정" data-testid="open-settings" onClick={ui.openSettings}>
                <SettingsOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
          <Box data-testid="personal-memo-view-header" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <MemoSaveIndicator hideSaved fixedSlot />
            {navControls}
          </Box>
        </Box>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 3, pb: 2.5, pt: 0.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {view.kind === 'browse' ? (
          <BrowseView query={browseQuery} onQueryChange={setBrowseQuery} focusSearch={!!view.focusSearch} onOpen={openFromBrowse} />
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
              listName={listName}
            />
          </>
        ) : (
          <WeekView monday={view.monday} onOpenDay={openDay} activeKey={lastDay} />
        )}
      </Box>

      {isDay && !onNext && (
        <Menu anchorEl={jumpAnchor} open={!!jumpAnchor} onClose={() => setJumpAnchor(null)} slotProps={{ paper: { sx: { minWidth: 230 } } }}>
          {sameWeekdayAround(dayKey!).map((day, index) => (
            <MenuItem key={day} dense selected={day === dayKey} onClick={() => browseToDay(day)}>
              <ListItemIcon>{day === dayKey ? <CheckIcon fontSize="small" /> : null}</ListItemIcon>
              <ListItemText
                primary={dayLabelWithYear(day, today)}
                secondary={SAME_WEEKDAY_RELATIVE[index]}
                primaryTypographyProps={{ fontWeight: day === dayKey ? 800 : 500, color: dayTone(day).text }}
              />
              {day === today && <Box sx={{ ml: 1 }}><TodayBadge /></Box>}
            </MenuItem>
          ))}
        </Menu>
      )}
    </Box>
  );
}
