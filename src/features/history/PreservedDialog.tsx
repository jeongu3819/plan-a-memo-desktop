/** 보존된 내용 — 충돌에서 선택하지 않은 내용, 삭제·이동·PLAN-A Work 변경 반영 직전의 내용. 보기 · 이 내용으로 되돌리기(설정에서 연다). */
import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { locationLabel } from '../../domain/location';
import { usePreserved } from '../../services/queries';
import { errorMessage, historyService } from '../../tauri/api';
import { MEMO_MUTED } from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import SnapshotView from './SnapshotView';

function when(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function PreservedDialog({ open, onClose, onRestored }: { open: boolean; onClose: () => void; onRestored: () => void }) {
  const versions = usePreserved(open);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setSelected(null);
    setError(null);
  }, [open]);
  useEffect(() => {
    if (selected === null && versions.data?.length) setSelected(versions.data[0].id);
  }, [versions.data, selected]);
  const detail = useQuery({
    queryKey: ['memo', 'preserved-detail', selected],
    queryFn: () => historyService.get(selected!),
    enabled: open && selected !== null,
  });

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth data-personal-memo-overlay="true" data-testid="preserved-dialog">
      <DialogTitle>보존된 내용</DialogTitle>
      <DialogContent sx={{ display: 'flex', gap: 2, minHeight: 360 }}>
        {versions.isPending ? (
          <CircularProgress size={20} />
        ) : !versions.data?.length ? (
          <Typography data-testid="preserved-empty" sx={{ fontSize: '0.88rem', color: MEMO_MUTED }}>
            보존된 내용이 없습니다. 충돌에서 선택하지 않은 내용이나 삭제·이동 직전의 내용이 여기에 남습니다.
          </Typography>
        ) : (
          <>
            <List dense sx={{ width: 280, flexShrink: 0, overflowY: 'auto', maxHeight: 460, borderRight: '1px solid', borderColor: 'divider', pr: 1 }}>
              {versions.data.map(version => (
                <ListItemButton
                  key={version.id}
                  data-testid="preserved-entry"
                  data-reason={version.reason}
                  selected={version.id === selected}
                  onClick={() => setSelected(version.id)}
                  sx={{ borderRadius: 1.5 }}
                >
                  <ListItemText
                    primary={version.reasonLabel}
                    secondary={`${locationLabel(version.location, version.listName)} · ${when(version.createdAt)} · 메모 ${version.itemCount}개`}
                    primaryTypographyProps={{ fontSize: '0.84rem', fontWeight: 700 }}
                    secondaryTypographyProps={{ fontSize: '0.72rem' }}
                  />
                </ListItemButton>
              ))}
            </List>
            <Box data-testid="preserved-detail" sx={{ flex: 1, minWidth: 0, overflowY: 'auto', maxHeight: 460 }}>
              {detail.data ? <SnapshotView snapshot={detail.data.snapshot} /> : <CircularProgress size={20} />}
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions>
        {error && <Typography variant="caption" color="error" sx={{ mr: 'auto', ml: 2 }}>{error}</Typography>}
        <Button onClick={onClose}>닫기</Button>
        <Button
          variant="contained"
          data-testid="preserved-restore"
          disabled={selected === null || busy}
          onClick={async () => {
            if (selected === null) return;
            setBusy(true);
            setError(null);
            try {
              await historyService.restore(selected);
              onClose();
              onRestored();
            } catch (failure) {
              setError(errorMessage(failure, '되돌리지 못했습니다.'));
            } finally {
              setBusy(false);
            }
          }}
        >
          이 내용으로 되돌리기
        </Button>
      </DialogActions>
    </Dialog>
  );
}
