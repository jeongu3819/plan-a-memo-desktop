/**
 * 날짜 알림 설정 — '10월 24일 토요일 알림'. 날짜당 하나(체크리스트 항목마다 만들지 않는다).
 *   미리 알림: □ 1주 전  □ 2일 전 (하나·둘 다·없음) · 알림 시각(기본 오전 9:00) · 실제 알림 예정 시각 미리 보기.
 *   그 날짜에만 적용(매주 반복 없음). 이미 지난 시각은 소급해서 알리지 않는다. 알림 내용(완료하지 않은 체크리스트 수)은
 *   알릴 시각에 센다 — 모두 완료하면 알리지 않는다.
 *
 * PLAN-A Work 와 연결된 날짜(memo-sync-v2)는 같은 화면에서 **공통 알림 설정**을 바꾼다 — Web 과 따로 설정하지 않는다.
 * 양쪽이 동시에 다르게 바꿨으면 두 설정을 보여 주고 고르게 한다(자동으로 덮어쓰지 않는다). 확인한 알림은 '확인함' 으로 보인다.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  TextField,
  Typography,
} from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import type { ReminderOffset, ReminderStatus } from '../../domain/types';
import {
  DEFAULT_REMINDER_TIME,
  describeRule,
  formatFireAt,
  koreanLongDate,
  localMinuteString,
  REMINDER_OFFSET_LABELS,
  REMINDER_OFFSETS,
  reminderPreview,
} from '../../domain/dayTools';
import { MEMO_MUTED } from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import { keys, useManagementDay, useReminder, useReminderStatus } from '../../services/queries';
import { dayToolsService, errorMessage } from '../../tauri/api';
import { usePersonalMemo } from '../memo/MemoProvider';

/** Windows 알림 권한·예약 상태 안내(문제가 있을 때만). */
export function reminderProblem(status: ReminderStatus | undefined): string | null {
  if (!status) return null;
  switch (status.notifications) {
    case 'disabled_app':
      return 'Windows 설정에서 PLAN-A Memo 알림이 꺼져 있습니다. [설정 > 시스템 > 알림]에서 켜야 알림이 보입니다.';
    case 'disabled_user':
      return 'Windows 알림이 모두 꺼져 있습니다. [설정 > 시스템 > 알림]에서 켜야 알림이 보입니다.';
    case 'disabled_policy':
      return '회사(관리자) 정책으로 Windows 알림이 꺼져 있어 알림이 보이지 않습니다.';
    case 'disabled_manifest':
      return '이 앱의 Windows 알림이 꺼져 있습니다.';
    case 'unsupported':
      return '이 환경에서는 Windows 알림을 쓸 수 없습니다.';
    case 'unregistered':
      return '설치하지 않은 실행 파일(개발용)이라 Windows 알림이 보이지 않을 수 있습니다. 설치한 앱에서는 정상적으로 표시됩니다.';
    default:
      break;
  }
  if (status.task?.error) return `알림 예약에 실패했습니다 — ${status.task.error} 앱이 켜져 있는 동안에는 알림이 표시됩니다.`;
  return null;
}
export default function ReminderDialog({ date, onClose }: { date: string | null; onClose: () => void }) {
  const { today, notify } = usePersonalMemo();
  const queryClient = useQueryClient();
  const reminder = useReminder(date);
  const status = useReminderStatus(!!date);
  const management = useManagementDay(date);
  const [offsets, setOffsets] = useState<ReminderOffset[]>([]);
  const [time, setTime] = useState(DEFAULT_REMINDER_TIME);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(localMinuteString());

  useEffect(() => {
    if (!date || reminder.isPending) return;
    setOffsets(reminder.data?.offsets ?? []);
    setTime(reminder.data?.time ?? DEFAULT_REMINDER_TIME);
    setNow(localMinuteString());
  }, [date, reminder.isPending, reminder.data]);

  const preview = useMemo(
    () => (date && /^\d{2}:\d{2}$/.test(time) ? reminderPreview(date, offsets, time, now) : []),
    [date, offsets, time, now],
  );
  if (!date) return null;
  const pastDay = date <= today;
  const existing = !!reminder.data;
  const problem = reminderProblem(status.data);
  const validTime = /^\d{2}:\d{2}$/.test(time);
  const mode = management.data?.mode ?? 'local';
  const blocked = management.data?.blockedReason ?? null;
  const conflict = management.data?.reminderConflict ?? null;
  const acknowledged = reminder.data?.fires.filter(f => f.acknowledged) ?? [];

  const applySaved = (saved: Awaited<ReturnType<typeof dayToolsService.setReminder>>) => {
    queryClient.setQueryData(keys.reminder(date), saved.reminder);
    queryClient.setQueryData(keys.reminderStatus, saved.status);
    void queryClient.invalidateQueries({ queryKey: keys.management(date) });
  };

  const resolveConflict = async (choice: 'server' | 'mine') => {
    setSaving(true);
    try {
      applySaved(await dayToolsService.resolveReminderConflict(date, choice));
      notify({
        message: choice === 'server' ? 'PLAN-A Work 의 알림 설정을 사용합니다.' : '이 PC 의 알림 설정을 PLAN-A Work 에도 저장합니다.',
        variant: 'success',
      });
      onClose();
    } catch (error) {
      notify({ message: errorMessage(error, '알림 설정을 고르지 못했습니다.'), variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const save = async (nextOffsets: ReminderOffset[]) => {
    setSaving(true);
    try {
      const saved = await dayToolsService.setReminder(date, nextOffsets, validTime ? time : DEFAULT_REMINDER_TIME);
      applySaved(saved);
      const pending = saved.reminder?.fires.filter(f => f.status === 'pending') ?? [];
      if (saved.status.task?.error) {
        notify({ message: `알림 설정은 저장했지만 Windows 예약에 실패했습니다. ${saved.status.task.error}`, variant: 'error' });
      } else if (!saved.reminder) {
        notify({ message: `${koreanLongDate(date)} 알림을 껐습니다.` });
      } else if (pending.length === 0) {
        notify({ message: '알림 시각이 모두 지나 이번에는 알림이 없습니다.' });
      } else {
        notify({ message: `알림을 설정했습니다 — ${pending.map(f => formatFireAt(f.fireAt)).join(', ')}`, variant: 'success' });
      }
      onClose();
    } catch (error) {
      notify({ message: errorMessage(error, '알림을 저장하지 못했습니다.'), variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const toggle = (offset: ReminderOffset) =>
    setOffsets(current => (current.includes(offset) ? current.filter(o => o !== offset) : [...current, offset]));

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth data-personal-memo-overlay="true" data-testid="reminder-dialog">
      <DialogTitle sx={{ pb: 0.5 }}>{koreanLongDate(date)} 알림</DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: '0.8rem', color: MEMO_MUTED, mb: 1.5 }}>
          이 날짜에만 알립니다(매주 반복하지 않음). 알릴 때 완료하지 않은 체크리스트 수를 알려 드리고, 모두 완료했으면 알리지 않습니다.
          {mode === 'shared' && ' PLAN-A Work 와 함께 쓰는 알림이라 Web 에서도 같은 설정이 보입니다.'}
        </Typography>
        {conflict && (
          <Alert severity="warning" data-testid="reminder-conflict" sx={{ mb: 1.5, fontSize: '0.8rem' }}>
            <Typography sx={{ fontSize: '0.8rem', fontWeight: 700 }}>
              {conflict.initial ? '이 PC 와 PLAN-A Work 의 알림 설정이 서로 다릅니다.' : '그 사이 PLAN-A Work 에서 알림 설정이 바뀌었습니다.'}
            </Typography>
            <Typography sx={{ fontSize: '0.8rem' }}>PLAN-A Work: {describeRule(conflict.current.days_before, conflict.current.local_time)}</Typography>
            <Typography sx={{ fontSize: '0.8rem' }}>이 PC: {describeRule(conflict.proposed.daysBefore, conflict.proposed.localTime)}</Typography>
            <Box sx={{ display: 'flex', gap: 0.5, mt: 0.75 }}>
              <Button size="small" variant="outlined" disabled={saving} onClick={() => void resolveConflict('server')} data-testid="reminder-conflict-server">
                PLAN-A Work 설정 사용
              </Button>
              <Button size="small" disabled={saving} onClick={() => void resolveConflict('mine')} data-testid="reminder-conflict-mine">
                이 PC 설정 유지
              </Button>
            </Box>
          </Alert>
        )}
        {blocked && (
          <Alert severity="info" data-testid="reminder-blocked" sx={{ mb: 1.5, fontSize: '0.8rem' }}>
            {blocked}
          </Alert>
        )}
        {acknowledged.length > 0 && (
          <Typography data-testid="reminder-acknowledged" sx={{ fontSize: '0.78rem', color: MEMO_MUTED, mb: 1 }}>
            확인함: {acknowledged.map(f => REMINDER_OFFSET_LABELS[f.offsetDays]).join(' · ')} — 다시 알리지 않습니다.
          </Typography>
        )}
        {pastDay ? (
          <Alert severity="info" sx={{ fontSize: '0.8rem' }}>오늘과 지난 날짜에는 미리 알림을 설정할 수 없습니다.</Alert>
        ) : (
          <>
            <Typography sx={{ fontSize: '0.8rem', fontWeight: 700, mb: 0.25 }}>미리 알림</Typography>
            <Box sx={{ display: 'flex', gap: 2, mb: 1.5 }}>
              {REMINDER_OFFSETS.map(offset => (
                <FormControlLabel
                  key={offset}
                  control={
                    <Checkbox
                      size="small"
                      checked={offsets.includes(offset)}
                      onChange={() => toggle(offset)}
                      inputProps={{ 'aria-label': REMINDER_OFFSET_LABELS[offset] }}
                    />
                  }
                  label={<Typography sx={{ fontSize: '0.86rem' }}>{REMINDER_OFFSET_LABELS[offset]}</Typography>}
                />
              ))}
            </Box>
            <Typography sx={{ fontSize: '0.8rem', fontWeight: 700, mb: 0.5 }}>알림 시각</Typography>
            <TextField
              type="time"
              size="small"
              value={time}
              onChange={event => setTime(event.target.value)}
              inputProps={{ 'aria-label': '알림 시각', step: 300, 'data-testid': 'reminder-time' }}
              sx={{ width: 160, mb: 1.5 }}
            />
            <Box data-testid="reminder-preview" sx={{ minHeight: 44 }}>
              {preview.length === 0 ? (
                <Typography sx={{ fontSize: '0.8rem', color: MEMO_MUTED }}>고른 미리 알림이 없으면 알림이 없습니다.</Typography>
              ) : (
                preview.map(p => (
                  <Typography key={p.offset} sx={{ fontSize: '0.84rem', color: p.past ? 'text.disabled' : 'text.primary' }}>
                    • {formatFireAt(p.fireAt)}
                    <Box component="span" sx={{ color: MEMO_MUTED, fontSize: '0.76rem' }}>
                      {' '}· {REMINDER_OFFSET_LABELS[p.offset]}
                      {p.past ? ' — 이미 지난 시각이라 알리지 않습니다' : ''}
                    </Box>
                  </Typography>
                ))
              )}
            </Box>
          </>
        )}
        {problem && (
          <Alert severity="warning" data-testid="reminder-problem" sx={{ mt: 1.5, fontSize: '0.78rem' }}>
            {problem}
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {existing && !blocked && (
          <Button color="inherit" disabled={saving} onClick={() => void save([])} sx={{ mr: 'auto' }}>
            알림 끄기
          </Button>
        )}
        <Button onClick={onClose}>취소</Button>
        <Button
          variant="contained"
          disabled={saving || pastDay || !validTime || !!blocked || (!existing && offsets.length === 0)}
          onClick={() => void save(offsets)}
          data-testid="reminder-save"
        >
          저장
        </Button>
      </DialogActions>
    </Dialog>
  );
}
