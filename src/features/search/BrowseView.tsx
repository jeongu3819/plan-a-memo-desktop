/**
 * 'List' 화면 — 찾아보는 화면(Web PersonalMemoBrowse 와 같은 역할).
 *   검색어가 없으면: 즐겨찾기 · Next List · 지난 날짜 메모
 *   검색어가 있으면: List 이름 · 메모 본문(DayMemo + Next) · History(지금은 없는 내용)
 */
import { useEffect, useRef, useState } from 'react';
import { Box, Button, ButtonBase, CircularProgress, IconButton, InputAdornment, InputBase, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import StarRoundedIcon from '@mui/icons-material/StarRounded';
import HistoryIcon from '@mui/icons-material/History';
import { useQuery } from '@tanstack/react-query';
import type { Location } from '../../domain/types';
import { keys, useFavorites, useLists } from '../../services/queries';
import { dayMemoService, searchService } from '../../tauri/api';
import { textOf } from '../../services/text';
import { weekdayOf, WEEKDAY_LABELS } from '../../vendor/plan-a-work/utils/personalMemoDates';
import {
  dayTone,
  MEMO_CARD,
  MEMO_CARD_BORDER,
  MEMO_CARD_BORDER_HOVER,
  MEMO_CARD_SHADOW,
  MEMO_CARD_SHADOW_HOVER,
  MEMO_MUTED,
  MEMO_RADIUS,
  MEMO_SECTION_TITLE,
  NEXT_LABEL,
} from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import { SECTION_LABELS } from '../memo/MemoMenu';
import { usePersonalMemo } from '../memo/MemoProvider';
import type { MemoSection } from '../../domain/types';

export interface OpenTarget {
  location: Location;
  itemId?: string;
  tokens?: string[];
}

const SEARCH_DEBOUNCE_MS = 250;

export function dottedDayLabel(day: string): string {
  const [y, m, d] = day.split('-');
  return `${y}.${m}.${d} (${WEEKDAY_LABELS[weekdayOf(day)]})`;
}

function placeLabel(location: Location, listName: string | null, section?: string): string {
  if (location.kind === 'day') {
    const label = section && section in SECTION_LABELS ? ` · ${SECTION_LABELS[section as MemoSection]}` : '';
    return `${dottedDayLabel(location.date)}${label}`;
  }
  return listName ? `${NEXT_LABEL} > ${listName}` : NEXT_LABEL;
}

function Highlighted({ text, tokens }: { text: string; tokens: string[] }) {
  if (!tokens.length) return <>{text}</>;
  const escaped = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = text.split(new RegExp(`(${escaped.join('|')})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        tokens.some(t => t.toLowerCase() === part.toLowerCase()) ? (
          <Box key={i} component="mark" sx={{ bgcolor: 'rgba(250, 204, 21, 0.55)', color: 'inherit', borderRadius: 0.5, px: '1px' }}>
            {part}
          </Box>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function Card({ onClick, children, testId }: { onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <ButtonBase
      onClick={onClick}
      data-testid={testId}
      sx={{
        display: 'block', textAlign: 'left', width: '100%', border: '1px solid', borderColor: MEMO_CARD_BORDER,
        borderRadius: MEMO_RADIUS, bgcolor: MEMO_CARD, px: 2, py: 1.5, boxShadow: MEMO_CARD_SHADOW,
        transition: 'border-color 0.15s, box-shadow 0.2s',
        '&:hover': { borderColor: MEMO_CARD_BORDER_HOVER, boxShadow: MEMO_CARD_SHADOW_HOVER },
        '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' },
      }}
    >
      {children}
    </ButtonBase>
  );
}

function GroupTitle({ children }: { children: React.ReactNode }) {
  return (
    <Typography sx={{ fontSize: '0.78rem', fontWeight: 800, color: MEMO_SECTION_TITLE, mt: 1.5, mb: 0.75, display: 'flex', alignItems: 'center', gap: 0.5 }}>
      {children}
    </Typography>
  );
}

export default function BrowseView({
  query,
  onQueryChange,
  focusSearch,
  onOpen,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  focusSearch: boolean;
  onOpen: (target: OpenTarget) => void;
}) {
  const { today } = usePersonalMemo();
  const inputRef = useRef<HTMLInputElement>(null);
  const [debounced, setDebounced] = useState(query.trim());
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (focusSearch) inputRef.current?.focus();
  }, [focusSearch]);

  const searching = debounced.length > 0;
  const results = useQuery({ queryKey: keys.search(debounced), queryFn: () => searchService.search(debounced), enabled: searching });
  const lists = useLists();
  const favorites = useFavorites(!searching);
  const [before, setBefore] = useState<string | null>(null);
  const days = useQuery({ queryKey: [...keys.days, before ?? 'latest'], queryFn: () => dayMemoService.days(before), enabled: !searching });
  const [allDays, setAllDays] = useState<NonNullable<typeof days.data>>([]);
  useEffect(() => {
    if (!days.data) return;
    setAllDays(prev => (before ? [...prev.filter(d => !days.data!.some(n => n.date === d.date)), ...days.data!] : days.data!));
  }, [days.data, before]);

  return (
    <Box data-testid="personal-memo-browse" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, maxWidth: 880, width: '100%', mx: 'auto' }}>
      <InputBase
        inputRef={inputRef}
        value={query}
        onChange={event => onQueryChange(event.target.value)}
        placeholder="메모 전체 검색 — 날짜 메모 · Next · 지난 기록(History)"
        inputProps={{ 'aria-label': '메모 검색', 'data-testid': 'memo-search-input' }}
        startAdornment={<InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>}
        endAdornment={
          query ? (
            <InputAdornment position="end">
              <IconButton size="small" aria-label="검색어 지우기" onClick={() => onQueryChange('')}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </InputAdornment>
          ) : undefined
        }
        sx={{
          border: '1px solid', borderColor: MEMO_CARD_BORDER, borderRadius: '10px', bgcolor: MEMO_CARD, boxShadow: MEMO_CARD_SHADOW, px: 1.75, py: 0.75, fontSize: '0.92rem',
          transition: 'border-color 0.15s, box-shadow 0.15s',
          '&.Mui-focused': { borderColor: 'rgba(37, 99, 235, 0.45)', boxShadow: '0 0 0 3px rgba(37, 99, 235, 0.08)' },
        }}
      />

      {searching ? (
        results.isPending ? (
          <CircularProgress size={20} sx={{ m: 2 }} />
        ) : results.data ? (
          <>
            {results.data.lists.length > 0 && (
              <>
                <GroupTitle>List</GroupTitle>
                {results.data.lists.map(list => (
                  <Card key={list.id} onClick={() => onOpen({ location: { kind: 'next', listId: list.isDefault ? null : list.id } })}>
                    <Typography sx={{ fontWeight: 700, color: dayTone('next').text }}>
                      {NEXT_LABEL} &gt; <Highlighted text={list.name} tokens={results.data!.tokens} />
                    </Typography>
                  </Card>
                ))}
              </>
            )}
            <GroupTitle>메모 {results.data.items.length}{results.data.truncated ? '+' : ''}개</GroupTitle>
            {results.data.items.length === 0 && (
              <Typography sx={{ fontSize: '0.85rem', color: MEMO_MUTED, px: 0.5 }}>'{debounced}' 이(가) 들어간 메모가 없습니다.</Typography>
            )}
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
              {results.data.items.map(hit => (
                <Card
                  key={hit.item.id}
                  testId="memo-search-hit"
                  onClick={() => onOpen({ location: hit.location, itemId: hit.item.id, tokens: results.data!.tokens })}
                >
                  <Typography sx={{ fontSize: '0.74rem', color: MEMO_MUTED, mb: 0.25 }}>
                    {placeLabel(hit.location, hit.listName, hit.item.section)}
                    {hit.item.kind === 'checklist' && hit.item.completed ? ' · 완료' : ''}
                  </Typography>
                  <Typography sx={{ fontSize: '0.9rem' }}>
                    <Highlighted text={hit.excerpt} tokens={results.data!.tokens} />
                  </Typography>
                </Card>
              ))}
            </Box>
            {results.data.history.length > 0 && (
              <>
                <GroupTitle><HistoryIcon sx={{ fontSize: 16 }} /> History — 지금은 없는 내용</GroupTitle>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                  {results.data.history.map(hit => (
                    <Card key={hit.versionId} testId="memo-search-history-hit" onClick={() => onOpen({ location: hit.location })}>
                      <Typography sx={{ fontSize: '0.74rem', color: MEMO_MUTED, mb: 0.25 }}>
                        {placeLabel(hit.location, hit.listName)} · {hit.reasonLabel} · {hit.createdAt.slice(0, 16).replace('T', ' ')}
                      </Typography>
                      <Typography sx={{ fontSize: '0.9rem' }}>
                        <Highlighted text={hit.excerpt} tokens={results.data!.tokens} />
                      </Typography>
                    </Card>
                  ))}
                </Box>
              </>
            )}
          </>
        ) : (
          <Typography color="error" sx={{ fontSize: '0.85rem', m: 1 }}>검색하지 못했습니다.</Typography>
        )
      ) : (
        <>
          {(favorites.data?.length ?? 0) > 0 && (
            <>
              <GroupTitle><StarRoundedIcon sx={{ fontSize: 16, color: '#F5B301' }} /> 즐겨찾기</GroupTitle>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                {favorites.data!.map(fav => (
                  <Card key={fav.item.id} testId="memo-favorite" onClick={() => onOpen({ location: fav.location, itemId: fav.item.id, tokens: [] })}>
                    <Typography sx={{ fontSize: '0.74rem', color: MEMO_MUTED, mb: 0.25 }}>{placeLabel(fav.location, fav.listName, fav.item.section)}</Typography>
                    <Typography noWrap sx={{ fontSize: '0.9rem' }}>{textOf(fav.item.contentHtml) || '(이미지)'}</Typography>
                  </Card>
                ))}
              </Box>
            </>
          )}

          <GroupTitle>Next List</GroupTitle>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 0.75 }}>
            {(lists.data ?? []).map(list => (
              <Card key={list.id} onClick={() => onOpen({ location: { kind: 'next', listId: list.isDefault ? null : list.id } })}>
                <Typography sx={{ fontWeight: 800, color: dayTone('next').text, fontSize: '0.9rem' }} noWrap>
                  {list.isDefault ? NEXT_LABEL : list.name}
                </Typography>
                <Typography sx={{ fontSize: '0.74rem', color: MEMO_MUTED }}>
                  메모 {list.itemCount}개{list.document?.syncEnabled ? ' · PLAN-A Work 연결됨' : ''}
                </Typography>
              </Card>
            ))}
          </Box>

          <GroupTitle>지난 메모</GroupTitle>
          {allDays.length === 0 && !days.isPending && (
            <Typography sx={{ fontSize: '0.85rem', color: MEMO_MUTED, px: 0.5 }}>아직 메모가 있는 날짜가 없습니다.</Typography>
          )}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
            {allDays.map(day => (
              <Card key={day.date} testId="memo-day-summary" onClick={() => onOpen({ location: { kind: 'day', date: day.date } })}>
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
                  <Typography sx={{ fontWeight: 800, fontSize: '0.9rem', color: dayTone(day.date).text }}>{dottedDayLabel(day.date)}</Typography>
                  {day.date === today && <Typography sx={{ fontSize: '0.7rem', color: 'primary.main', fontWeight: 800 }}>Today</Typography>}
                  <Box sx={{ flex: 1 }} />
                  <Typography sx={{ fontSize: '0.74rem', color: MEMO_MUTED }}>
                    메모 {day.itemCount}개{day.checklistCount ? ` · 완료 ${day.doneCount}/${day.checklistCount}` : ''}
                  </Typography>
                </Box>
                <Typography noWrap sx={{ fontSize: '0.84rem', color: 'text.secondary', mt: 0.25 }}>{day.previews.filter(Boolean).join(' · ')}</Typography>
              </Card>
            ))}
          </Box>
          {(days.data?.length ?? 0) >= 40 && (
            <Button size="small" onClick={() => setBefore(allDays[allDays.length - 1]?.date ?? null)} sx={{ alignSelf: 'center', mt: 1 }}>
              더 지난 메모 보기
            </Button>
          )}
        </>
      )}
    </Box>
  );
}
