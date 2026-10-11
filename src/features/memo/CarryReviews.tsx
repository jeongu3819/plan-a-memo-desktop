/**
 * 복사본 선택 — 연결된 날짜(memo-sync-v2)에서 이 PC 의 복사본과 PLAN-A Work 쪽 복사본이 서로 다르게 바뀌어
 * 자동으로 합칠 수 없을 때만 보인다. 어느 쪽도 먼저 지우지 않고, 고르지 않은 쪽은 History 에 남는다.
 */
import { useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import type { CarryReview } from '../../domain/types';
import { MEMO_MUTED } from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import { refreshMemo, useManagementDay } from '../../services/queries';
import { textOf } from '../../services/text';
import { dayToolsService, errorMessage } from '../../tauri/api';
import { usePersonalMemo } from './MemoProvider';

const TITLES: Record<CarryReview['kind'], string> = {
  both_changed: '이 PC 와 PLAN-A Work 에서 같은 복사본을 서로 다르게 고쳤습니다.',
  server_removed: 'PLAN-A Work 에서 지우거나 다른 날짜로 옮긴 복사본을 이 PC 에서 고쳤습니다.',
  duplicate: '같은 항목이 이미 복사되어 있는데, 이 PC 에서 따로 고친 복사본이 있습니다.',
  copy_failed: 'PLAN-A Work 가 이 복사를 받지 않았습니다(원본이 바뀌었거나 완료·삭제됨).',
};

const LOCAL_LABEL: Record<CarryReview['kind'], string> = {
  both_changed: '이 PC 내용 사용',
  server_removed: '새 메모로 남기기',
  duplicate: '이 PC 수정 적용',
  copy_failed: '새 메모로 남기기',
};

const SERVER_LABEL: Record<CarryReview['kind'], string> = {
  both_changed: 'PLAN-A Work 내용 사용',
  server_removed: '이 PC 복사본 빼기',
  duplicate: '이미 있는 복사본만 두기',
  copy_failed: '이 복사본 빼기',
};

const preview = (html: string | null) => (html == null ? '(없음)' : textOf(html) || '(이미지·표 메모)');

export default function CarryReviews({ date }: { date: string }) {
  const { notify } = usePersonalMemo();
  const queryClient = useQueryClient();
  const { data } = useManagementDay(date);
  const [busy, setBusy] = useState<string | null>(null);
  const reviews = data?.reviews ?? [];
  if (!reviews.length) return null;

  const choose = async (review: CarryReview, choice: 'local' | 'server') => {
    setBusy(review.id);
    try {
      await dayToolsService.resolveCarryReview(review.id, choice);
      refreshMemo(queryClient);
      notify({ message: '선택한 내용으로 맞췄습니다. 고르지 않은 내용은 History 에 남아 있습니다.', variant: 'success' });
    } catch (error) {
      notify({ message: errorMessage(error, '처리하지 못했습니다.'), variant: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box data-testid="carry-reviews" sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      {reviews.map(review => (
        <Box
          key={review.id}
          data-testid="carry-review"
          sx={{ border: '1px solid', borderColor: 'rgba(217, 119, 6, 0.35)', bgcolor: 'rgba(254, 243, 199, 0.45)', borderRadius: '12px', px: 1.75, py: 1 }}
        >
          <Typography sx={{ fontSize: '0.82rem', fontWeight: 700 }}>{TITLES[review.kind]}</Typography>
          {review.kind !== 'copy_failed' && (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 1, rowGap: 0.25, mt: 0.5 }}>
              <Typography sx={{ fontSize: '0.72rem', color: MEMO_MUTED }}>이 PC</Typography>
              <Typography sx={{ fontSize: '0.82rem', overflowWrap: 'anywhere' }}>{preview(review.localHtml)}</Typography>
              <Typography sx={{ fontSize: '0.72rem', color: MEMO_MUTED }}>PLAN-A Work</Typography>
              <Typography sx={{ fontSize: '0.82rem', overflowWrap: 'anywhere' }}>{preview(review.serverHtml)}</Typography>
            </Box>
          )}
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 0.5, mt: 0.75 }}>
            <Button size="small" color="inherit" disabled={busy === review.id} onClick={() => void choose(review, 'server')} data-testid="carry-review-server">
              {SERVER_LABEL[review.kind]}
            </Button>
            <Button size="small" variant="outlined" disabled={busy === review.id} onClick={() => void choose(review, 'local')} data-testid="carry-review-local">
              {LOCAL_LABEL[review.kind]}
            </Button>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
