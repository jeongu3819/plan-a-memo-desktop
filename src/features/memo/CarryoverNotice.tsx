/**
 * 지난 미완료 가져오기 — 바로 지난주 같은 요일(D-7)에 완료하지 않은 체크리스트를 이 날짜(D)로 **복사**한다.
 *
 * · 이번 주 날짜를 처음 열 때 가져올 항목이 있으면 작은 안내 줄 하나(큰 팝업 없이). 사용자가 고르기 전에는 아무것도 바꾸지 않는다.
 * · [항목 선택] → 가져올 항목을 고른다. 여기 체크박스는 **가져올 항목 선택**이다(완료 체크가 아니다 — 원본의 완료 상태를 바꾸지 않는다).
 * · [이번에는 건너뛰기] 는 이 날짜에 다시 저절로 안내하지 않는다(앱을 다시 열어도). 날짜 메뉴 '지난 미완료 가져오기' 로 언제든 다시 연다.
 * · 원본은 그대로 남고, 복사본은 새 메모·미완료·같은 구역의 맨 뒤. 같은 원본은 같은 날짜로 한 번만 복사된다(Rust 가 보장).
 */
import { useEffect, useRef, useState } from 'react';
import { Box, Button, Checkbox, CircularProgress, Typography } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import type { MemoSection } from '../../domain/types';
import { weekdayName } from '../../domain/dayTools';
import { shortDate } from '../../vendor/plan-a-work/utils/personalMemoDates';
import { MEMO_MUTED, MEMO_SECTION_TITLE } from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import { refreshMemo, useCarryover } from '../../services/queries';
import { textOf } from '../../services/text';
import { dayToolsService, errorMessage } from '../../tauri/api';
import { usePersonalMemo } from './MemoProvider';

const SHORT_SECTION: Record<MemoSection, string> = { main: '메인', am: '오전', pm: '오후' };

export default function CarryoverNotice({ date, manual, onCloseManual }: { date: string; manual: boolean; onCloseManual: () => void }) {
  const { notify } = usePersonalMemo();
  const queryClient = useQueryClient();
  const { data } = useCarryover(date);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const markedRef = useRef<string | null>(null);

  const auto = !!data?.autoPrompt && !dismissed;
  const visible = manual || auto;

  // 처음 저절로 보였다는 기록(안내 여부) — 결정(건너뛰기·가져오기) 전까지는 다시 보일 수 있다.
  useEffect(() => {
    if (auto && !manual && data?.status == null && markedRef.current !== date) {
      markedRef.current = date;
      void dayToolsService.carryoverShown(date).catch(() => undefined);
    }
  }, [auto, manual, data?.status, date]);

  useEffect(() => {
    setPicking(manual);
    setDismissed(false);
  }, [date, manual]);

  // 고르기를 열 때 한 번만 모두 고른 상태로(다른 메모 저장으로 다시 읽어도 사용자가 고른 것을 되돌리지 않는다).
  useEffect(() => {
    if (picking && data) setSelected(data.items.map(i => i.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking, !!data]);

  if (!visible || !data) return null;
  const name = weekdayName(date);
  const count = data.items.length;

  const close = () => {
    setPicking(false);
    setDismissed(true);
    if (manual) onCloseManual();
  };

  const skip = async () => {
    try {
      await dayToolsService.carryoverSkip(date);
      refreshMemo(queryClient);
    } catch (error) {
      notify({ message: errorMessage(error, '처리하지 못했습니다.'), variant: 'error' });
    }
    close();
  };

  const importSelected = async () => {
    if (busy || selected.length === 0) return;
    setBusy(true);
    try {
      const result = await dayToolsService.carryoverImport(date, selected);
      refreshMemo(queryClient);
      notify({
        message: result.created.length
          ? `${result.created.length}개를 이번 ${name}로 가져왔습니다. 지난 ${name} 기록은 그대로 남아 있습니다.`
          : '이미 가져온 항목입니다. 새로 추가한 것은 없습니다.',
        variant: result.created.length ? 'success' : 'default',
      });
      close();
    } catch (error) {
      notify({ message: errorMessage(error, '가져오지 못했습니다.'), variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const frame = {
    border: '1px solid',
    borderColor: 'rgba(28, 25, 23, 0.08)',
    borderRadius: '12px',
    bgcolor: 'rgba(255, 255, 255, 0.55)',
    px: 1.75,
    py: 1,
  } as const;

  if (!data.available || count === 0) {
    // 보조 메뉴로 직접 열었을 때만 보인다.
    return (
      <Box data-testid="carryover-notice" sx={{ ...frame, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography sx={{ fontSize: '0.8rem', color: MEMO_SECTION_TITLE, flex: 1 }}>
          {data.available
            ? `지난 ${name}(${shortDate(data.sourceDate)})에 가져올 미완료 체크리스트가 없습니다.`
            : `지난주 ${name}(${shortDate(data.sourceDate)})이 아직 지나지 않아 가져올 수 없습니다.`}
        </Typography>
        <Button size="small" onClick={close}>닫기</Button>
      </Box>
    );
  }

  if (!picking) {
    return (
      <Box data-testid="carryover-notice" sx={{ ...frame, display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 1.5, rowGap: 0.5 }}>
        <Box sx={{ flex: '1 1 260px', minWidth: 0 }}>
          <Typography sx={{ fontSize: '0.82rem', color: 'text.primary' }}>
            지난 {name}에 완료하지 않은 체크리스트가 <b>{count}개</b> 있습니다. 이번 {name}에 가져올까요?
          </Typography>
          <Typography sx={{ fontSize: '0.72rem', color: MEMO_MUTED }}>이전 날짜의 기록은 그대로 남습니다.</Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          <Button size="small" variant="outlined" onClick={() => setPicking(true)} data-testid="carryover-pick" sx={{ fontSize: '0.76rem' }}>
            항목 선택
          </Button>
          <Button size="small" color="inherit" onClick={() => void skip()} data-testid="carryover-skip" sx={{ fontSize: '0.76rem', color: MEMO_MUTED }}>
            이번에는 건너뛰기
          </Button>
        </Box>
      </Box>
    );
  }

  const allSelected = selected.length === count;
  return (
    <Box data-testid="carryover-picker" sx={{ ...frame, py: 1.25 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.5 }}>
        <Typography sx={{ fontSize: '0.84rem', fontWeight: 700 }}>
          지난 {name} · {shortDate(data.sourceDate)}
        </Typography>
        <Typography sx={{ fontSize: '0.72rem', color: MEMO_MUTED, flex: 1 }}>가져올 항목을 고르세요(완료 표시가 아닙니다)</Typography>
        <Button
          size="small"
          onClick={() => setSelected(allSelected ? [] : data.items.map(i => i.id))}
          sx={{ fontSize: '0.72rem', py: 0, minWidth: 0 }}
        >
          {allSelected ? '모두 해제' : '모두 선택'}
        </Button>
      </Box>
      <Box role="group" aria-label="가져올 항목">
        {data.items.map(item => {
          const checked = selected.includes(item.id);
          return (
            <Box
              key={item.id}
              component="label"
              data-testid="carryover-option"
              sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75, py: 0.25, cursor: 'pointer', borderRadius: '8px', '&:hover': { bgcolor: 'action.hover' } }}
            >
              <Checkbox
                size="small"
                color="primary"
                checked={checked}
                onChange={() => setSelected(current => (checked ? current.filter(id => id !== item.id) : [...current, item.id]))}
                inputProps={{ 'aria-label': `가져오기: ${textOf(item.contentHtml) || '메모'}` }}
                sx={{ p: '3px' }}
              />
              <Typography component="span" sx={{ fontSize: '0.68rem', color: MEMO_MUTED, minWidth: 28, pt: '5px' }}>
                {SHORT_SECTION[item.section as MemoSection] ?? ''}
              </Typography>
              <Typography component="span" sx={{ fontSize: '0.86rem', pt: '3px', minWidth: 0, overflowWrap: 'anywhere' }}>
                {textOf(item.contentHtml) || '(이미지·표 메모)'}
              </Typography>
            </Box>
          );
        })}
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 0.5, mt: 0.75 }}>
        <Button size="small" color="inherit" onClick={manual ? close : () => setPicking(false)} sx={{ color: MEMO_MUTED }}>
          취소
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={busy || selected.length === 0}
          onClick={() => void importSelected()}
          data-testid="carryover-import"
          startIcon={busy ? <CircularProgress size={12} color="inherit" /> : undefined}
        >
          선택한 항목 가져오기{selected.length ? ` (${selected.length})` : ''}
        </Button>
      </Box>
    </Box>
  );
}
