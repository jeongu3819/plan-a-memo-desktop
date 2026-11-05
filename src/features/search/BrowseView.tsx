/**
 * 'List' 화면 — 찾아보는 화면(Web PersonalMemoBrowse 와 같은 역할).
 *   검색어가 없으면: 즐겨찾기 · Next List · 지난 메모(월 카드)
 *   검색어가 있으면: 날짜(검색어가 날짜로 읽힐 때) · List 이름 · 메모 본문(DayMemo + Next)
 *   입력칸은 하나다 — 날짜와 본문을 따로 고르지 않는다. 월 카드가 접혀 있어도 모든 달을 찾는다.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, ButtonBase, CircularProgress, IconButton, InputAdornment, InputBase, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import StarRoundedIcon from '@mui/icons-material/StarRounded';
import { useQuery } from '@tanstack/react-query';
import type { Location } from '../../domain/types';
import { parseDateQuery } from '../../domain/memoBrowse';
import { keys, useFavorites, useLists } from '../../services/queries';
import { searchService } from '../../tauri/api';
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
import PastMemos from './PastMemos';
import type { MemoSection } from '../../domain/types';

export interface OpenTarget {
  location: Location;
  itemId?: string;
  tokens?: string[];
}

const SEARCH_DEBOUNCE_MS = 250;
/** 본문 검색 결과를 한 번에 더 읽는 수(Rust 기본 한도와 같다). */
const SEARCH_STEP = 200;

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
  headerSearch = false,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  focusSearch: boolean;
  onOpen: (target: OpenTarget) => void;
  /** 검색어 입력칸이 머리 줄에 있다(Web 과 같은 인라인 검색) — 이 화면은 결과만 그린다. */
  headerSearch?: boolean;
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
  const [limit, setLimit] = useState(SEARCH_STEP);
  useEffect(() => setLimit(SEARCH_STEP), [debounced]);
  // 검색어·한도가 key 라 늦게 도착한 이전 검색 결과는 화면에 쓰이지 않는다. 입력하는 동안에는 직전 결과를 둔다(깜빡이지 않게).
  const results = useQuery({
    queryKey: [...keys.search(debounced, limit), today],
    queryFn: () => searchService.search(debounced, parseDateQuery(debounced, today), limit),
    enabled: searching,
    placeholderData: previous => previous,
  });
  // 날짜 결과에 이미 보인 메모는 본문 결과에서 다시 보이지 않는다.
  const textHits = useMemo(() => {
    const shown = new Set(results.data?.days.flatMap(day => day.items.map(hit => hit.item.id)));
    return results.data?.items.filter(hit => !shown.has(hit.item.id)) ?? [];
  }, [results.data]);
  const lists = useLists();
  const favorites = useFavorites(!searching);

  return (
    <Box data-testid="personal-memo-browse" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, maxWidth: 880, width: '100%', mx: 'auto' }}>
      {!headerSearch && <InputBase
        inputRef={inputRef}
        value={query}
        onChange={event => onQueryChange(event.target.value)}
        placeholder="메모 전체 검색 — 날짜 메모 · Next"
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
      />}

      {searching ? (
        results.isPending ? (
          <CircularProgress size={20} sx={{ m: 2 }} />
        ) : results.data ? (
          <>
            {results.data.days.map(day => (
              <Box key={day.date} data-testid="memo-search-date-group">
                <GroupTitle>{dottedDayLabel(day.date)} · 메모 {day.items.length}개</GroupTitle>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                  {day.items.map(hit => (
                    <Card
                      key={hit.item.id}
                      testId="memo-search-date-hit"
                      onClick={() => onOpen({ location: hit.location, itemId: hit.item.id, tokens: day.tokens })}
                    >
                      <Typography sx={{ fontSize: '0.74rem', color: MEMO_MUTED, mb: 0.25 }}>
                        {placeLabel(hit.location, hit.listName, hit.item.section)}
                        {hit.item.kind === 'checklist' && hit.item.completed ? ' · 완료' : ''}
                      </Typography>
                      <Typography sx={{ fontSize: '0.9rem' }}>
                        {hit.excerpt ? <Highlighted text={hit.excerpt} tokens={day.tokens} /> : '(이미지·표 메모)'}
                      </Typography>
                    </Card>
                  ))}
                </Box>
              </Box>
            ))}
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
            {(textHits.length > 0 || results.data.days.length === 0) && (
              <GroupTitle>메모 {textHits.length}{results.data.truncated ? '+' : ''}개</GroupTitle>
            )}
            {textHits.length === 0 && results.data.days.length === 0 && (
              <Typography sx={{ fontSize: '0.85rem', color: MEMO_MUTED, px: 0.5 }}>'{results.data.query}' 이(가) 들어간 메모가 없습니다.</Typography>
            )}
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
              {textHits.map(hit => (
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
            {results.data.truncated && (
              <Button size="small" data-testid="memo-search-more" onClick={() => setLimit(value => value + SEARCH_STEP)} sx={{ alignSelf: 'center', mt: 0.5 }}>
                결과 더 보기
              </Button>
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
          <PastMemos today={today} onOpen={location => onOpen({ location })} />
        </>
      )}
    </Box>
  );
}
