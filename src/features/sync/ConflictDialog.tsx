/**
 * 충돌 비교 — DayMemo 는 메인+오전+오후 전체, Next 는 List 전체를 나란히(좁으면 위아래) 비교한다.
 * '최근 수정 시각' 으로 자동 선택하지 않는다. 선택한 쪽이 최신이 되고, 선택하지 않은 쪽은 History 에 남는다.
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import type { ConflictView } from '../../domain/types';
import { locationLabel } from '../../domain/location';
import { refreshMemo, useConflicts } from '../../services/queries';
import { AppError, errorMessage, syncService } from '../../tauri/api';
import { MEMO_CARD, MEMO_CARD_BORDER, MEMO_RADIUS } from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import SnapshotView from '../history/SnapshotView';
import { conflictReason, remoteTitle } from './conflictText';

function Side({ title, children, onUse, busy }: { title: string; children: React.ReactNode; onUse: () => void; busy: boolean }) {
  return (
    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', border: '1px solid', borderColor: MEMO_CARD_BORDER, borderRadius: MEMO_RADIUS, bgcolor: MEMO_CARD, p: 2 }}>
      <Typography sx={{ fontWeight: 800, fontSize: '0.92rem', mb: 1 }}>{title}</Typography>
      <Box sx={{ flex: 1, minHeight: 80, overflowY: 'auto', maxHeight: 380 }}>{children}</Box>
      <Button variant="contained" onClick={onUse} disabled={busy} sx={{ mt: 1.5 }}>
        이 내용을 최신으로 사용
      </Button>
    </Box>
  );
}

export default function ConflictDialog({ open, documentId, onClose }: { open: boolean; documentId?: string; onClose: () => void }) {
  const conflicts = useConflicts();
  const queryClient = useQueryClient();
  const wide = useMediaQuery('(min-width: 900px)');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      void conflicts.refetch();
      setError(null);
      setInfo(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const list = conflicts.data ?? [];
  const current: ConflictView | undefined = list.find(c => c.documentId === documentId) ?? list[0];

  const resolve = async (choice: 'local' | 'remote') => {
    if (!current) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      // PLAN-A Work Resolve 가 성공한 뒤에만 로컬이 바뀐다(Rust).
      await syncService.resolve(current.id, choice);
      refreshMemo(queryClient);
      const rest = await conflicts.refetch();
      if (!rest.data?.length) onClose();
    } catch (failure) {
      refreshMemo(queryClient);
      await conflicts.refetch();
      if (failure instanceof AppError && ['conflict_stale', 'conflict_resolved_elsewhere', 'conflict_items_moved'].includes(failure.code)) {
        setInfo(failure.message); // 비교 화면이 최신으로 바뀌었다 — 다시 고른다
      } else {
        setError(errorMessage(failure, '선택을 보내지 못했습니다. 두 내용은 그대로 보관되어 있습니다.'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth data-personal-memo-overlay="true" data-testid="conflict-dialog">
      <DialogTitle sx={{ fontSize: '1rem', fontWeight: 800 }}>⚠ 메모 내용이 서로 다릅니다.</DialogTitle>
      <DialogContent>
        {!current ? (
          <Typography sx={{ fontSize: '0.9rem' }}>확인할 충돌이 없습니다.</Typography>
        ) : (
          <>
            <Typography sx={{ fontSize: '0.88rem', mb: 0.5 }}>
              <b>{locationLabel(current.location, current.listName)}</b> —{' '}
              {conflictReason(current)}
            </Typography>
            <Typography sx={{ fontSize: '0.84rem', color: 'text.secondary', mb: 2 }}>
              최신으로 사용할 내용을 선택해주세요. 선택하지 않은 내용은 History 에 보관됩니다.
              {list.length > 1 ? ` (확인할 메모 ${list.length}건)` : ''}
            </Typography>
            {info && <Alert severity="warning" sx={{ mb: 1.5 }}>{info}</Alert>}
            {error && <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert>}
            <Box sx={{ display: 'flex', flexDirection: wide ? 'row' : 'column', gap: 2 }}>
              <Side title="Desktop Version" onUse={() => void resolve('local')} busy={busy}>
                <SnapshotView snapshot={current.local} />
              </Side>
              <Side title={remoteTitle(current)} onUse={() => void resolve('remote')} busy={busy}>
                <SnapshotView snapshot={current.remote} />
              </Side>
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>나중에 선택</Button>
      </DialogActions>
    </Dialog>
  );
}
