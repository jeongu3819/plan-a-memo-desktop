/**
 * 반복 중지 확인 — 미리 만들어 둔 앞으로의 회차를 정리할 때만 띄운다(정리할 것이 없으면 확인 없이 중지).
 * 정리되는 것은 손대지 않은 회차뿐이고 정리 전 상태는 History 에 남는다(memo/recurrence.rs::stop).
 */
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';

export interface RecurrenceStopRequest {
  ruleId: string;
  /** '토요일' */
  dayName: string;
  /** 정리될(손대지 않은 앞으로의) 회차 수 */
  removed: number;
  /** 남겨 둘(고쳤거나 완료한) 앞으로의 회차 수 */
  kept: number;
}

export default function RecurrenceStopDialog({
  request,
  busy = false,
  onCancel,
  onConfirm,
}: {
  request: RecurrenceStopRequest | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (request: RecurrenceStopRequest) => void;
}) {
  const line = { fontSize: '0.88rem', mt: 0.75 } as const;
  return (
    <Dialog
      open={!!request}
      onClose={onCancel}
      data-personal-memo-overlay="true"
      data-testid="recurrence-stop-confirm"
      maxWidth="xs"
      fullWidth
    >
      {/* 대화상자는 portal 이지만 React 이벤트는 메모 행·주간 칸으로 올라간다 — 편집 시작·날짜 열기로 번지지 않게 멈춘다. */}
      <Box
        onClick={event => event.stopPropagation()}
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
        onContextMenu={event => event.stopPropagation()}
      >
        <DialogTitle>{request?.dayName} 반복을 중지할까요?</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: '0.88rem' }}>앞으로 새 메모를 만들지 않습니다.</Typography>
          <Typography sx={line} data-testid="recurrence-stop-removed">
            미리 만들어 둔 이후 메모 중 손대지 않은 {request?.removed ?? 0}개를 정리합니다. 정리 전 내용은 History 에 남습니다.
          </Typography>
          <Typography sx={line} data-testid="recurrence-stop-kept">
            {request?.kept
              ? `고치거나 완료한 이후 메모 ${request.kept}개와 오늘까지의 메모는 그대로 둡니다.`
              : '고치거나 완료한 메모와 오늘까지의 메모는 그대로 둡니다.'}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={onCancel} autoFocus data-testid="recurrence-stop-cancel">취소</Button>
          <Button
            color="error"
            variant="contained"
            disabled={busy}
            data-testid="recurrence-stop-submit"
            onClick={() => request && onConfirm(request)}
          >
            반복 중지
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
