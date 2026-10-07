/** 변경 이력 — 날짜 하루(또는 List) 단위 버전 목록 · 보기 · 이 버전으로 되돌리기. */
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
import type { Location } from '../../domain/types';
import { useHistory } from '../../services/queries';
import { errorMessage, historyService } from '../../tauri/api';
import { MEMO_MUTED } from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import SnapshotView from './SnapshotView';

function when(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function HistoryDialog({
  location,
  title,
  onClose,
  onRestored,
}: {
  location: Location | null;
  title: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const versions = useHistory(location);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setSelected(null);
    setError(null);
  }, [location]);
  useEffect(() => {
    if (selected === null && versions.data?.length) setSelected(versions.data[0].id);
  }, [versions.data, selected]);
  const detail = useQuery({
    queryKey: ['memo', 'history-detail', selected],
    queryFn: () => historyService.get(selected!),
    enabled: selected !== null,
  });

  return (
    <Dialog open={!!location} onClose={onClose} maxWidth="md" fullWidth data-personal-memo-overlay="true" data-testid="history-dialog">
      <DialogTitle sx={{ fontSize: '1rem', fontWeight: 800 }}>변경 이력 · {title}</DialogTitle>
      <DialogContent sx={{ display: 'flex', gap: 2, minHeight: 360 }}>
        {versions.isPending ? (
          <CircularProgress size={20} />
        ) : !versions.data?.length ? (
          <Typography sx={{ fontSize: '0.88rem', color: MEMO_MUTED }}>
            아직 남은 이력이 없습니다. 수정·삭제·이동·충돌 해결 전에 자동으로 남습니다.
          </Typography>
        ) : (
          <>
            <List dense sx={{ width: 260, flexShrink: 0, overflowY: 'auto', maxHeight: 460, borderRight: '1px solid', borderColor: 'divider', pr: 1 }}>
              {versions.data.map(version => (
                <ListItemButton key={version.id} selected={version.id === selected} onClick={() => setSelected(version.id)} sx={{ borderRadius: 1.5 }}>
                  <ListItemText
                    primary={`${version.reasonLabel}`}
                    secondary={`${when(version.createdAt)} · 메모 ${version.itemCount}개`}
                    primaryTypographyProps={{ fontSize: '0.84rem', fontWeight: 700 }}
                    secondaryTypographyProps={{ fontSize: '0.72rem' }}
                  />
                </ListItemButton>
              ))}
            </List>
            <Box sx={{ flex: 1, minWidth: 0, overflowY: 'auto', maxHeight: 460 }}>
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
          이 버전으로 되돌리기
        </Button>
      </DialogActions>
    </Dialog>
  );
}
