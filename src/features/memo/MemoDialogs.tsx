import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  TextField,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import type { MemoItem, MovePolicy } from '../../domain/types';
import MemoEditor from '../../editor/MemoEditor';
import { usePersonalMemo } from './MemoProvider';
import { MemoSaveIndicator } from './MemoSaveIndicator';

/**
 * 연결된 날짜 → 연결되지 않은 날짜로 옮길 때. 다른 날짜를 몰래 Cloud 에 연결하지 않는다.
 * PLAN-A Work 와 같은 의미: 기본(이동만)은 원래 날짜의 PLAN-A Work 문서에서 빠지고 대상은 연결하지 않는다.
 * 대상 연결은 사용자가 고를 때만(로그인 필요) — 대상에 Web 내용이 있으면 덮지 않고 비교한다.
 */
export function MoveDecisionDialog({
  request,
  targetLabel,
  onClose,
  onChoose,
}: {
  request: unknown | null;
  targetLabel: string;
  onClose: () => void;
  onChoose: (policy: MovePolicy) => void;
}) {
  return (
    <Dialog open={!!request} onClose={onClose} data-personal-memo-overlay="true" data-testid="move-decision-dialog" maxWidth="xs" fullWidth>
      <DialogTitle>{targetLabel}은 PLAN-A Work와 연결되어 있지 않습니다.</DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: '0.88rem', color: 'text.secondary' }}>
          옮기면 이 메모는 PLAN-A Work 의 원래 날짜에서 빠집니다. {targetLabel}은 연결하지 않으면 이 PC 에만 저장됩니다(PLAN-A Work 의 이동과 같은
          규칙).
        </Typography>
      </DialogContent>
      <DialogActions sx={{ flexDirection: 'column', alignItems: 'stretch', gap: 1, px: 3, pb: 2.5 }}>
        <Button variant="contained" onClick={() => onChoose('local_only')}>
          Desktop에서만 이동
        </Button>
        <Button variant="outlined" onClick={() => onChoose('link_target')} sx={{ ml: '0 !important' }}>
          {targetLabel}도 연결하고 이동
        </Button>
        <Button color="inherit" onClick={onClose} sx={{ ml: '0 !important' }}>
          취소
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** '날짜 선택…' — 과거/먼 미래로 옮길 때만 쓰는 작은 창(Web 과 같다). */
export function DatePickerDialog({
  item,
  today,
  onClose,
  onPick,
}: {
  item: MemoItem | null;
  today: string;
  onClose: () => void;
  onPick: (item: MemoItem, date: string) => void;
}) {
  const [value, setValue] = useState('');
  useEffect(() => {
    if (item) setValue(today);
  }, [item, today]);
  if (!item) return null;
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return (
    <Dialog open onClose={onClose} data-personal-memo-overlay="true">
      <DialogTitle>날짜 선택</DialogTitle>
      <DialogContent>
        <TextField
          type="date"
          size="small"
          value={value}
          onChange={event => setValue(event.target.value)}
          inputProps={{ 'aria-label': '이동할 날짜' }}
          sx={{ mt: 0.5 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>취소</Button>
        <Button variant="contained" disabled={!valid} onClick={() => onPick(item, value)}>
          이동
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** 긴 메모의 「크게 편집」 — 같은 초안을 편집하므로 인라인과 내용이 갈라지지 않는다. */
export function LargeEditorDialog({ item, onClose }: { item: MemoItem | null; onClose: () => void }) {
  const { store, setEditingId, notify } = usePersonalMemo();
  useEffect(() => {
    if (item) {
      setEditingId(null);
      store.open(item);
    }
  }, [item, store, setEditingId]);
  const onChange = useCallback((html: string) => item && store.edit(item, html), [item, store]);
  const onUploading = useCallback((uploading: boolean) => item && store.setUploading(item.id, uploading), [item, store]);
  if (!item) return null;
  const draft = store.draft(item.id);
  const close = () => {
    if (draft?.uploading) {
      notify({ message: '이미지를 넣는 중입니다. 끝난 뒤 닫을 수 있습니다.' });
      return;
    }
    void store.close(item.id);
    onClose();
  };
  return (
    <Dialog
      open
      onClose={close}
      maxWidth={false}
      data-personal-memo-overlay="true"
      data-testid="personal-memo-large-editor"
      PaperProps={{ sx: { width: 'min(920px, 92vw)', height: 'min(680px, 86vh)', display: 'flex', flexDirection: 'column' } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1.25 }}>
        <Typography component="span" noWrap sx={{ flex: 1, fontWeight: 800 }}>메모 크게 편집</Typography>
        <MemoSaveIndicator />
        <IconButton aria-label="닫기" onClick={close}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <MemoEditor
            itemId={item.id}
            value={draft?.content ?? item.contentHtml}
            onChange={onChange}
            onUploadingChange={onUploading}
            onError={message => notify({ message, variant: 'error' })}
            fill
            minHeight={120}
            maxHeight="none"
            placeholder="메모 (이미지는 Ctrl+V · 굵게 Ctrl+B · 밑줄 Ctrl+U · 글자 크기·색은 드래그 후 우클릭)"
          />
        </Box>
      </DialogContent>
      <DialogActions>
        {draft?.status === 'error' ? (
          <>
            <Typography variant="caption" color="error" sx={{ mr: 'auto' }}>{draft.error}</Typography>
            <Button onClick={() => store.retry(item.id)}>다시 시도</Button>
          </>
        ) : (
          <Button onClick={close}>닫기</Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
