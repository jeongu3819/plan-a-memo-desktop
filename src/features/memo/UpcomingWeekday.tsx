/**
 * 날짜 상세 아래 '다가오는 토요일' — **보고 있는 날짜** 기준 다음 주·다다음 주 같은 요일에 미리 써 둔 메모.
 *
 * · 날짜마다 가벼운 카드 하나(메인·오전·오후는 작은 구역 표시로만) — 큰 편집기를 날짜마다 만들지 않는다.
 * · 카드의 메모는 그 자리에서 체크·편집(기존 MemoRow + Rich Editor)·삭제·이동한다. 바뀌는 것은 **그 날짜의 DAY 문서**다
 *   (보고 있는 날짜에 복사하지 않는다 — 각 카드가 자기 날짜 문서를 읽고 쓴다).
 * · 표시만 할 뿐 연결(PLAN-A Work)·업로드를 시작하지 않는다. 연결된 날짜면 그 날짜의 변경으로 평소처럼 동기화된다.
 * · 메모가 없는 날짜는 한 줄 안내 + [미리 작성]. 더 먼 같은 요일은 [이후 ○요일의 예정 더 보기]로 메모가 있는 날만 더 읽는다.
 */
import { useMemo, useState } from 'react';
import { Box, Button, ButtonBase, CircularProgress, IconButton, Tooltip, Typography } from '@mui/material';
import NotificationsNoneOutlinedIcon from '@mui/icons-material/NotificationsNoneOutlined';
import NotificationsActiveOutlinedIcon from '@mui/icons-material/NotificationsActiveOutlined';
import AddIcon from '@mui/icons-material/Add';
import type { Location, MemoItem, MemoSection } from '../../domain/types';
import { dateWithYear, formatFireAt, relativeWeekdayLabel, upcomingSameWeekdays, weekdayName } from '../../domain/dayTools';
import { shortDate } from '../../vendor/plan-a-work/utils/personalMemoDates';
import { SECTION_ORDER } from '../../vendor/plan-a-work/components/personalMemo/personalMemoPreview';
import {
  dayTone,
  MEMO_CARD_BORDER,
  MEMO_CARD_BORDER_HOVER,
  MEMO_GROUP_DIVIDER,
  MEMO_MUTED,
  MEMO_RADIUS,
  MEMO_SECTION_TITLE,
} from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import { useDay, useReminder, useSameWeekdayDates } from '../../services/queries';
import { usePersonalMemo } from './MemoProvider';
import MemoRow from './MemoRow';
import QuickInput from './QuickInput';
import ReminderDialog from '../reminders/ReminderDialog';

/** 카드에서 처음 보이는 항목 수(나머지는 펼치기). */
const CARD_PREVIEW = 4;
/** [더 보기] 한 번에 더 읽는 날짜 수. */
const MORE_STEP = 4;
const SHORT_SECTION: Record<MemoSection, string> = { main: '메인', am: '오전', pm: '오후' };

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

function FutureDayCard({
  base,
  date,
  onOpenDay,
  onReminder,
}: {
  base: string;
  date: string;
  onOpenDay: (date: string) => void;
  onReminder: (date: string) => void;
}) {
  const { today } = usePersonalMemo();
  const { data, isPending } = useDay(date);
  const [expanded, setExpanded] = useState(false);
  const [writing, setWriting] = useState(false);
  const location: Location = useMemo(() => ({ kind: 'day', date }), [date]);
  const items: MemoItem[] = data?.items ?? [];
  const checklist = items.filter(m => m.kind === 'checklist');
  const open = checklist.filter(m => !m.completed).length;
  const tone = dayTone(date);

  // 메인 → 오전 → 오후 순서로 앞에서부터 CARD_PREVIEW 개(펼치면 모두).
  const shown = expanded ? items : items.slice(0, CARD_PREVIEW);
  const groups = SECTION_ORDER.map(section => [section, shown.filter(m => m.section === section)] as [MemoSection, MemoItem[]]).filter(
    ([, list]) => list.length > 0,
  );
  const hidden = items.length - shown.length;
  const empty = !isPending && items.length === 0;

  return (
    <Box
      data-testid={`upcoming-card-${date}`}
      data-empty={empty ? 'true' : undefined}
      sx={{
        border: '1px solid',
        borderColor: MEMO_CARD_BORDER,
        borderRadius: MEMO_RADIUS,
        // 현재 날짜 메모(흰 카드·그림자)보다 가볍게 — 반투명 바탕, 그림자 없음.
        bgcolor: 'rgba(255, 255, 255, 0.62)',
        px: { xs: 1.5, sm: 1.75 },
        py: empty && !writing ? 0.75 : 1.25,
        transition: 'border-color 0.15s',
        '&:hover': { borderColor: MEMO_CARD_BORDER_HOVER },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minHeight: 28 }}>
        <ButtonBase
          onClick={() => onOpenDay(date)}
          aria-label={`${date} 날짜 상세로`}
          sx={{ borderRadius: '6px', px: 0.5, mx: -0.5, gap: 0.75, '&:hover .upcoming-open-hint': { opacity: 1 } }}
        >
          <Typography sx={{ fontSize: '0.86rem', fontWeight: 700, color: tone.kind === 'weekday' ? 'text.primary' : tone.text }}>
            {relativeWeekdayLabel(base, date)}
          </Typography>
          <Typography sx={{ fontSize: '0.8rem', color: MEMO_MUTED, fontVariantNumeric: 'tabular-nums' }}>· {dateWithYear(date, today)}</Typography>
          <Typography className="upcoming-open-hint" sx={{ fontSize: '0.7rem', color: MEMO_MUTED, opacity: 0, transition: 'opacity 0.15s' }}>
            열기 ›
          </Typography>
        </ButtonBase>
        <ReminderButton date={date} onOpen={() => onReminder(date)} />
        <Box sx={{ flex: 1 }} />
        {checklist.length > 0 && (
          <Typography sx={{ fontSize: '0.72rem', color: open ? MEMO_MUTED : '#15803D', fontVariantNumeric: 'tabular-nums' }}>
            {open ? `남은 할 일 ${open}` : '모두 완료'}
          </Typography>
        )}
        {empty && !writing && (
          <>
            <Typography sx={{ fontSize: '0.76rem', color: 'text.disabled' }}>아직 작성한 메모가 없어요</Typography>
            <Button
              size="small"
              startIcon={<AddIcon sx={{ fontSize: 15 }} />}
              onClick={() => setWriting(true)}
              data-testid="upcoming-write"
              sx={{ fontSize: '0.74rem', py: 0, minHeight: 26 }}
            >
              미리 작성
            </Button>
          </>
        )}
        {isPending && <CircularProgress size={14} />}
      </Box>

      {groups.length > 0 && (
        <Box sx={{ mt: 0.5 }}>
          {groups.map(([section, list], index) => (
            <Box
              key={section}
              data-testid={`upcoming-group-${section}`}
              sx={index > 0 ? { mt: 0.5, pt: 0.5, borderTop: '1px solid', borderColor: MEMO_GROUP_DIVIDER } : undefined}
            >
              <Typography sx={{ fontSize: '0.68rem', fontWeight: 600, color: MEMO_MUTED, letterSpacing: '0.02em', px: 0.25 }}>
                {SHORT_SECTION[section]}
              </Typography>
              {list.map(item => (
                <MemoRow key={item.id} item={item} location={location} variant="compact" comfortable />
              ))}
            </Box>
          ))}
          {hidden > 0 && (
            <Button size="small" onClick={() => setExpanded(true)} sx={{ fontSize: '0.72rem', py: 0, mt: 0.25 }}>
              나머지 {hidden}개 펼치기
            </Button>
          )}
          {expanded && items.length > CARD_PREVIEW && (
            <Button size="small" onClick={() => setExpanded(false)} sx={{ fontSize: '0.72rem', py: 0, mt: 0.25 }}>
              접기
            </Button>
          )}
        </Box>
      )}

      {(writing || (!empty && !isPending)) && (
        <Box sx={{ mt: 0.75 }}>
          {writing ? (
            <QuickInput location={location} section="main" placeholder={`${weekdayName(date)} 메인 할 일을 미리 적어보세요`} autoFocus />
          ) : (
            <Button
              size="small"
              startIcon={<AddIcon sx={{ fontSize: 15 }} />}
              onClick={() => setWriting(true)}
              sx={{ fontSize: '0.72rem', py: 0, color: MEMO_MUTED }}
            >
              메모 추가
            </Button>
          )}
        </Box>
      )}
    </Box>
  );
}

export default function UpcomingWeekday({ date, onOpenDay }: { date: string; onOpenDay: (date: string) => void }) {
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
        <Typography sx={{ fontSize: '0.74rem', color: MEMO_MUTED }}>다음 주와 그 이후에 미리 작성한 메모</Typography>
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        {[...base, ...moreDates].map(day => (
          <FutureDayCard key={day} base={date} date={day} onOpenDay={onOpenDay} onReminder={setReminderDate} />
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
          이후 {name}의 예정 더 보기
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
