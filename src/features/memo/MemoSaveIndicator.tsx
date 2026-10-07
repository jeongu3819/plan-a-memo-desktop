import { Box, Button, Typography } from '@mui/material';
import { MEMO_MUTED } from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import { usePersonalMemo } from './MemoProvider';

/**
 * 저장 상태를 작게 — 저장 중 / 이미지 넣는 중 / 저장됨 / 저장 실패. 실패를 '저장됨' 으로 보이지 않는다.
 * `hideSaved` 면 '모두 저장됨' 은 그리지 않는다(알릴 것이 있을 때만). `fixedSlot` 이면 늘 같은 자리를 차지한다.
 */
export function MemoSaveIndicator({ hideSaved = false, fixedSlot = false }: { hideSaved?: boolean; fixedSlot?: boolean }) {
  const { store } = usePersonalMemo();
  const count = store.unsavedCount();
  const failed = store.failedCount();
  const uploading = store.anyUploading();
  const text = failed
    ? `저장 실패·확인 필요 ${failed}건`
    : uploading ? '이미지 넣는 중…' : count > 0 ? '저장 중…' : hideSaved ? '' : '모두 저장됨';
  const label = text ? (
    <Typography
      data-testid="personal-memo-save-indicator"
      role="status"
      sx={{
        fontSize: '0.72rem', lineHeight: '20px', color: failed ? 'error.main' : MEMO_MUTED, whiteSpace: 'nowrap',
        ...(fixedSlot ? { position: 'absolute', right: 0, top: 0 } : {}),
      }}
    >
      {text}
    </Typography>
  ) : null;
  if (!fixedSlot) return label;
  return (
    <Box data-testid="personal-memo-save-slot" sx={{ position: 'relative', width: 64, height: 20, flexShrink: 0 }}>
      {label}
      {failed > 0 && (
        <Button
          size="small"
          color="error"
          onClick={() => void store.flushAll()}
          sx={{ position: 'absolute', right: 0, top: 18, fontSize: '0.68rem', py: 0, minWidth: 0 }}
        >
          다시 시도
        </Button>
      )}
    </Box>
  );
}
