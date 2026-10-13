/**
 * 날짜 상세 아래 '다가오는 토요일' — **보고 있는 날짜** 기준 다음 주·2주 후 같은 요일의 메모장.
 *
 * · 카드 하나가 그 날짜의 **그 자리 메모장**이다(메인·오전·오후). 입력·체크·편집·삭제는 카드의 날짜(그 날짜의 DAY 문서)로
 *   저장되고, 보고 있는 날짜·화면은 바뀌지 않는다 — 날짜 상세로 옮겨 가는 버튼이 없다(Web MemoUpcomingDays 와 같다).
 * · 각 카드는 자기 날짜 하루만 읽고 쓴다(보고 있는 날짜에 복사하지 않는다 — 다른 주와 섞이지 않는다).
 * · 표시만 할 뿐 연동(PLAN-A Work)·업로드를 시작하지 않는다. 연동된 날짜면 그 날짜의 변경으로 평소처럼 동기화된다.
 * · 더 먼 같은 요일은 [이후 ○요일 더 보기]로 메모가 있는 날만 더 읽는다.
 */
import { useMemo, useState } from 'react';
import { Box, Button, CircularProgress, IconButton, Tooltip, Typography } from '@mui/material';
import NotificationsNoneOutlinedIcon from '@mui/icons-material/NotificationsNoneOutlined';
import NotificationsActiveOutlinedIcon from '@mui/icons-material/NotificationsActiveOutlined';
import type { Location, MemoItem, MemoSection } from '../../domain/types';
import { formatFireAt, upcomingCardTitle, upcomingSameWeekdays, weekdayName } from '../../domain/dayTools';
import { shortDate } from '../../vendor/plan-a-work/utils/personalMemoDates';
import { SECTION_ORDER } from '../../vendor/plan-a-work/components/personalMemo/personalMemoPreview';
import {
  MEMO_CARD_BORDER,
  MEMO_CARD_BORDER_HOVER,
  MEMO_MUTED,
  MEMO_RADIUS,
  MEMO_SECTION_TITLE,
} from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import { useDay, useReminder, useSameWeekdayDates } from '../../services/queries';
import { usePersonalMemo } from './MemoProvider';
import { SECTION_LABELS } from './MemoMenu';
import MemoRow from './MemoRow';
import QuickInput from './QuickInput';
import ReminderDialog from '../reminders/ReminderDialog';

/** [더 보기] 한 번에 더 읽는 날짜 수. */
const MORE_STEP = 4;
const FUTURE_PLACEHOLDER = '진행할 일을 기록하세요';

function ReminderButton({ date, onOpen }: { date: string; onOpen: () => void }) {
  const { today } = usePersonalMemo();
  const reminder = useReminder(date);
  if (date <= today) return null;
  const pending = reminder.data?.fires.filter(f => f.status === 'pending') ?? [];
  const on = pending.length > 0;
  const title = on ? `알림: ${pending.map(f => formatFireAt(f.fireAt)).join(', ')}` : reminder.data ? '알림(예정된 시각 없음)' : '이 날짜 알림 설정';
  return (
    <Tooltip title={title}>
      <IconButton
        size="small"
        aria-label={`${date} 알림`}
        data-testid="upcoming-reminder-button"
        data-reminder-on={on ? 'true' : undefined}
        onClick={onOpen}
        sx={{ p: 0.5, color: on ? 'primary.main' : MEMO_MUTED, '&:hover': { color: on ? 'primary.dark' : MEMO_SECTION_TITLE } }}
      >
        {on ? <NotificationsActiveOutlinedIcon sx={{ fontSize: 18 }} /> : <NotificationsNoneOutlinedIcon sx={{ fontSize: 18 }} />}
      </IconButton>
    </Tooltip>
  );
}

function FutureDayCard({ base, date, onReminder }: { base: string; date: string; onReminder: (date: string) => void }) {
  const { today } = usePersonalMemo();
  const { data, isPending } = useDay(date);
  const location: Location = useMemo(() => ({ kind: 'day', date }), [date]);
  const items: MemoItem[] = data?.items ?? [];
  const checklist = items.filter(m => m.kind === 'checklist');
  const open = checklist.filter(m => !m.completed).length;

  return (
    <Box
      component="section"
      data-testid={`upcoming-card-${date}`}
      aria-label={upcomingCardTitle(base, date, today)}
      sx={{
        border: '1px solid',
        borderColor: MEMO_CARD_BORDER,
        borderRadius: MEMO_RADIUS,
        // 현재 날짜 메모(흰 카드·그림자)보다 가볍게 — 반투명 바탕, 그림자 없음.
        bgcolor: 'rgba(255, 255, 255, 0.62)',
        px: { xs: 1.5, sm: 1.75 },
        py: 1.25,
        transition: 'border-color 0.15s',
        '&:hover': { borderColor: MEMO_CARD_BORDER_HOVER },
        '&:focus-within': { borderColor: 'rgba(37, 99, 235, 0.45)' },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minHeight: 28, mb: 0.5 }}>
        <Typography component="h3" data-testid="upcoming-card-title" sx={{ fontSize: '0.86rem', fontWeight: 700, color: 'text.primary' }}>
          {upcomingCardTitle(base, date, today)}
        </Typography>
        <ReminderButton date={date} onOpen={() => onReminder(date)} />
        <Box sx={{ flex: 1 }} />
        {checklist.length > 0 && (
          <Typography sx={{ fontSize: '0.72rem', color: open ? MEMO_MUTED : '#15803D', fontVariantNumeric: 'tabular-nums' }}>
            {open ? `남은 할 일 ${open}` : '모두 완료'}
          </Typography>
        )}
        {isPending && <CircularProgress size={14} />}
      </Box>

      {!isPending && (
        <Box
          data-testid={`upcoming-sections-${date}`}
          sx={{
            display: 'grid', gap: 1, alignItems: 'start',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gridTemplateAreas: '"main main" "am pm"',
          }}
        >
          {SECTION_ORDER.map((section: MemoSection) => {
            const rows = items.filter(m => m.section === section);
            return (
              <Box key={section} data-testid={`upcoming-group-${section}`} sx={{ gridArea: section, minWidth: 0 }}>
                <Typography sx={{ fontSize: '0.7rem', fontWeight: 600, color: MEMO_SECTION_TITLE, letterSpacing: '0.02em', px: 0.25 }}>
                  {SECTION_LABELS[section]}
                </Typography>
                {rows.map(item => (
                  <MemoRow key={item.id} item={item} location={location} variant="compact" comfortable />
                ))}
                <Box sx={{ mt: rows.length ? 0.5 : 0.25 }}>
                  <QuickInput location={location} section={section} placeholder={FUTURE_PLACEHOLDER} />
                </Box>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

export default function UpcomingWeekday({ date }: { date: string }) {
  const base = upcomingSameWeekdays(date);
  const lastBase = base[base.length - 1];
  const [moreLimit, setMoreLimit] = useState(0);
  const [reminderDate, setReminderDate] = useState<string | null>(null);
  // 버튼을 보일지 정하려고 하나만 미리 본다(날짜만 — 본문은 카드가 읽는다).
  const probe = useSameWeekdayDates(lastBase, 1);
  const more = useSameWeekdayDates(lastBase, moreLimit, moreLimit > 0);
  const moreDates = moreLimit > 0 ? more.data ?? [] : [];
  const hasMore = moreLimit === 0 ? (probe.data?.length ?? 0) > 0 : moreDates.length >= moreLimit;
  const name = weekdayName(date);

  return (
    <Box component="section" data-testid="upcoming-weekday" aria-label={`다가오는 ${name}`} sx={{ mt: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, px: 0.25, mb: 0.75 }}>
        <Typography component="h2" sx={{ fontSize: '0.92rem', fontWeight: 700, color: MEMO_SECTION_TITLE, letterSpacing: '-0.01em' }}>
          다가오는 {name}
        </Typography>
        <Typography sx={{ fontSize: '0.74rem', color: MEMO_MUTED }}>이 자리에서 바로 적으면 그 날짜에 저장됩니다</Typography>
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        {[...base, ...moreDates].map(day => (
          <FutureDayCard key={day} base={date} date={day} onReminder={setReminderDate} />
        ))}
      </Box>
      {hasMore ? (
        <Button
          size="small"
          data-testid="upcoming-more"
          disabled={more.isFetching}
          onClick={() => setMoreLimit(limit => limit + MORE_STEP)}
          sx={{ mt: 0.5, fontSize: '0.76rem', color: MEMO_SECTION_TITLE }}
        >
          이후 {name} 더 보기
        </Button>
      ) : (
        moreLimit > 0 && (
          <Typography sx={{ mt: 0.75, px: 0.5, fontSize: '0.74rem', color: 'text.disabled' }}>
            {shortDate(moreDates[moreDates.length - 1] ?? lastBase)} 이후에는 미리 작성한 {name} 메모가 없어요
          </Typography>
        )
      )}
      <ReminderDialog date={reminderDate} onClose={() => setReminderDate(null)} />
    </Box>
  );
}
