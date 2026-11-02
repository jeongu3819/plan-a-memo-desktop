/**
 * 찾아보기의 '지난 메모' — 날짜별 긴 목록 대신 월 카드(메모의 실제 날짜 기준, 최신 월부터). 오늘(이 PC 의 날짜)까지의 메모만 보인다 —
 *   미래 날짜 메모는 지워지거나 숨겨진 것이 아니라 검색·주간·날짜 상세·다가오는 같은 요일에서 본다.
 *   · 올해는 '11월', 다른 해는 '2025년 12월'. 메모가 없는 월은 카드가 없다.
 *   · 처음에는 이번 달(없으면 가장 최근 달)만 펼친다. 누르면 그 자리에서 전체 폭으로 펼쳐져 날짜별 메모를 보여 준다.
 *   · 접혀 있어도 검색은 모든 달을 찾는다(이 화면은 둘러보기용이다).
 */
import { useState } from 'react';
import { Box, Button, ButtonBase, CircularProgress, Typography } from '@mui/material';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { Location } from '../../domain/types';
import { monthLabel } from '../../domain/memoBrowse';
import { shortDate, weekdayOf, WEEKDAY_LABELS } from '../../vendor/plan-a-work/utils/personalMemoDates';
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
} from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import { useDayMonths, useDaysInMonth } from '../../services/queries';

/** 처음에 보여 주는 월 카드 수(더 보기로 늘린다). */
const MONTH_STEP = 12;

function MonthDays({ month, today, onOpen }: { month: string; today: string; onOpen: (location: Location) => void }) {
  const { data, isPending } = useDaysInMonth(month, today);
  if (isPending) return <CircularProgress size={18} sx={{ m: 1.5 }} />;
  return (
    <Box data-testid="memo-month-days" sx={{ borderTop: '1px solid', borderColor: MEMO_GROUP_DIVIDER }}>
      {(data ?? []).map(day => (
        <ButtonBase
          key={day.date}
          data-testid="memo-day-summary"
          onClick={() => onOpen({ kind: 'day', date: day.date })}
          sx={{
            display: 'flex', alignItems: 'baseline', justifyContent: 'flex-start', gap: 1, width: '100%', textAlign: 'left', px: 2, py: 0.875,
            borderBottom: '1px solid', borderColor: MEMO_GROUP_DIVIDER, '&:last-of-type': { borderBottom: 0 },
            '&:hover': { bgcolor: 'action.hover' },
            '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
          }}
        >
          <Typography sx={{ fontWeight: 700, fontSize: '0.86rem', color: dayTone(day.date).text, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
            {shortDate(day.date)} ({WEEKDAY_LABELS[weekdayOf(day.date)]})
          </Typography>
          {day.date === today && <Typography sx={{ fontSize: '0.7rem', color: 'primary.main', fontWeight: 800, flexShrink: 0 }}>Today</Typography>}
          <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: '0.84rem', color: 'text.secondary' }}>
            {day.previews.filter(Boolean).join(' · ') || '(이미지·표 메모)'}
          </Typography>
          <Typography sx={{ fontSize: '0.72rem', color: MEMO_MUTED, flexShrink: 0 }}>
            메모 {day.itemCount}개{day.checklistCount ? ` · 완료 ${day.doneCount}/${day.checklistCount}` : ''}
          </Typography>
        </ButtonBase>
      ))}
    </Box>
  );
}

export default function PastMemos({ today, onOpen }: { today: string; onOpen: (location: Location) => void }) {
  const { data: months, isPending } = useDayMonths(today);
  const [limit, setLimit] = useState(MONTH_STEP);
  // null = 사용자가 아직 고르지 않음 → 가장 최근 달(보통 이번 달)만 펼친다.
  const [picked, setPicked] = useState<string[] | null>(null);
  const initial = months?.[0]?.month;
  const open = picked ?? (initial ? [initial] : []);
  const toggle = (month: string) => setPicked(open.includes(month) ? open.filter(m => m !== month) : [...open, month]);

  if (isPending) return <CircularProgress size={18} sx={{ m: 1 }} />;
  if (!months?.length) {
    return <Typography sx={{ fontSize: '0.85rem', color: MEMO_MUTED, px: 0.5 }}>아직 지난 메모가 없습니다.</Typography>;
  }
  return (
    <>
      <Box data-testid="memo-month-grid" sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 0.75, alignItems: 'start' }}>
        {months.slice(0, limit).map(month => {
          const expanded = open.includes(month.month);
          return (
            <Box
              key={month.month}
              data-testid="memo-month-card"
              data-month={month.month}
              sx={{
                // 펼친 달은 그 자리에서 한 줄 전체를 쓴다.
                ...(expanded ? { gridColumn: '1 / -1' } : {}),
                border: '1px solid', borderColor: MEMO_CARD_BORDER, borderRadius: MEMO_RADIUS, bgcolor: MEMO_CARD, boxShadow: MEMO_CARD_SHADOW, overflow: 'hidden',
                transition: 'border-color 0.15s, box-shadow 0.2s',
                '&:hover': { borderColor: MEMO_CARD_BORDER_HOVER, boxShadow: MEMO_CARD_SHADOW_HOVER },
              }}
            >
              <ButtonBase
                aria-expanded={expanded}
                data-testid="memo-month-toggle"
                onClick={() => toggle(month.month)}
                sx={{
                  display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 1, width: '100%', textAlign: 'left', px: 2, py: 1.25,
                  '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography data-testid="memo-month-label" noWrap sx={{ fontWeight: 800, fontSize: '0.9rem' }}>{monthLabel(month.month, today)}</Typography>
                  <Typography noWrap sx={{ fontSize: '0.74rem', color: MEMO_MUTED }}>메모 {month.itemCount}개</Typography>
                </Box>
                {expanded ? <ExpandLessIcon sx={{ fontSize: 18, color: MEMO_MUTED }} /> : <ExpandMoreIcon sx={{ fontSize: 18, color: MEMO_MUTED }} />}
              </ButtonBase>
              {expanded && <MonthDays month={month.month} today={today} onOpen={onOpen} />}
            </Box>
          );
        })}
      </Box>
      {months.length > limit && (
        <Button size="small" data-testid="memo-month-more" onClick={() => setLimit(value => value + MONTH_STEP)} sx={{ alignSelf: 'center', mt: 1 }}>
          이전 달 더 보기 · {months.length - limit}개
        </Button>
      )}
    </>
  );
}
