import { useEffect, useState } from 'react';
import { Button, Snackbar, SnackbarContent } from '@mui/material';

export interface Notice {
  id: number;
  message: string;
  variant?: 'default' | 'success' | 'error';
  actionLabel?: string;
  onAction?: () => void;
}

/** 결과 안내(실행 취소 포함) — Web MemoInlineNotice 와 같은 모양·위치. */
export default function MemoNotice({ notice, onDismiss }: { notice: Notice | null; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => setPaused(false), [notice?.id]);
  return (
    <Snackbar
      key={notice?.id}
      open={!!notice}
      autoHideDuration={paused ? null : notice?.onAction ? 8000 : 4000}
      onClose={(_, reason) => {
        if (!notice || reason === 'clickaway') return;
        onDismiss(notice.id);
      }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      data-testid="personal-memo-inline-notice"
    >
      <SnackbarContent
        role="status"
        aria-live="polite"
        message={notice?.message}
        sx={{
          whiteSpace: 'pre-line',
          bgcolor: notice?.variant === 'error' ? 'error.main' : notice?.variant === 'success' ? 'success.main' : 'grey.900',
        }}
        action={
          notice?.onAction ? (
            <Button
              size="small"
              color="inherit"
              sx={{ fontWeight: 700 }}
              onFocus={() => setPaused(true)}
              onBlur={() => setPaused(false)}
              onClick={() => {
                const run = notice.onAction!;
                onDismiss(notice.id);
                run();
              }}
            >
              {notice.actionLabel || '실행 취소'}
            </Button>
          ) : undefined
        }
      />
    </Snackbar>
  );
}
