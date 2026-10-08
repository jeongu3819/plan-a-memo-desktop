/**
 * 연결 상태 — 평소에는 조용하게. 문제가 있을 때만 '전달 대기 · 로그인 필요 · 동기화 오류 · 내용 확인 필요'.
 *
 *   SyncMark  : 주간 칸의 작은 표시(연결 안 됨이면 아무것도 그리지 않는다)
 *   LinkControl : 날짜 상세·Next List 의 [PLAN-A Work와 연결] / ✓ 연결됨(메뉴)
 */
import { useState } from 'react';
import { Box, Button, Chip, ListItemIcon, ListItemText, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import CloudDoneOutlinedIcon from '@mui/icons-material/CloudDoneOutlined';
import CloudUploadOutlinedIcon from '@mui/icons-material/CloudUploadOutlined';
import CloudOffOutlinedIcon from '@mui/icons-material/CloudOffOutlined';
import SyncIcon from '@mui/icons-material/Sync';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import HistoryIcon from '@mui/icons-material/History';
import { useQueryClient } from '@tanstack/react-query';
import type { DocumentInfo, Location } from '../../domain/types';
import { koreanMonthDay } from '../../domain/location';
import { refreshMemo } from '../../services/queries';
import { AppError, errorMessage, syncService } from '../../tauri/api';
import { useAppUi } from '../../app/AppUi';
import { usePersonalMemo } from '../memo/MemoProvider';

type Problem = { label: string; color: 'warning' | 'error' | 'default'; tip: string; conflict?: boolean };

export function syncProblem(document: DocumentInfo | null): Problem | null {
  if (!document?.syncEnabled) return null;
  if (document.hasConflict || document.syncStatus === 'conflict') {
    return { label: '내용 확인 필요', color: 'error', tip: '이 PC 와 PLAN-A Work 의 내용이 서로 다릅니다. 눌러서 비교하세요.', conflict: true };
  }
  switch (document.syncStatus) {
    case 'pending':
      return { label: '전달 대기', color: 'default', tip: '연결되면 PLAN-A Work 로 자동 전달됩니다.' };
    case 'auth_required':
      return { label: '로그인 필요', color: 'warning', tip: 'PLAN-A Work 계정 연결이 필요합니다.' };
    case 'error':
      return { label: '동기화 오류', color: 'error', tip: document.syncError || '잠시 후 다시 시도합니다.' };
    default:
      return null;
  }
}

export default function SyncMark({ document, compact = false }: { document: DocumentInfo | null; location: Location; compact?: boolean }) {
  const ui = useAppUi();
  const problem = syncProblem(document);
  if (!document?.syncEnabled) return null;
  if (!problem) {
    return (
      <Tooltip title="PLAN-A Work와 연결됨">
        <CloudDoneOutlinedIcon data-testid="sync-mark-linked" sx={{ fontSize: compact ? 15 : 17, color: '#7C8BA1' }} />
      </Tooltip>
    );
  }
  return (
    <Tooltip title={problem.tip}>
      <Chip
        size="small"
        data-memo-card-ignore
        data-testid="sync-mark-problem"
        label={problem.label}
        color={problem.color}
        variant={problem.color === 'default' ? 'outlined' : 'filled'}
        onClick={event => {
          event.stopPropagation();
          if (problem.conflict) ui.openConflicts(document.id);
          else if (document.syncStatus === 'auth_required') ui.openAccount('PLAN-A Work 계정 연결이 필요합니다.');
        }}
        sx={{ height: 20, fontSize: '0.66rem', fontWeight: 700, '& .MuiChip-label': { px: 0.75 } }}
      />
    </Tooltip>
  );
}

/** 날짜 상세 / Next List 의 연결 버튼(문서 전체가 연결 단위 — 항목별 버튼은 없다). */
export function LinkControl({
  document,
  location,
  label,
  onOpenHistory,
}: {
  document: DocumentInfo | null;
  location: Location;
  /** '10월 7일' · '앱 개발' */
  label: string;
  onOpenHistory: () => void;
}) {
  const ui = useAppUi();
  const { notify } = usePersonalMemo();
  const queryClient = useQueryClient();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const linked = !!document?.syncEnabled;

  const link = async () => {
    setBusy(true);
    try {
      await syncService.link(location);
      refreshMemo(queryClient);
      notify({ message: `${label} 메모를 PLAN-A Work와 연결했습니다. 이후 변경은 자동으로 맞춰집니다.`, variant: 'success' });
    } catch (error) {
      if (error instanceof AppError && error.code === 'auth_required') {
        ui.openAccount('PLAN-A Work 계정 연결이 필요합니다.', () => void link());
      } else {
        notify({ message: errorMessage(error, '연결하지 못했습니다.'), variant: 'error' });
      }
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    setAnchor(null);
    try {
      await syncService.unlink(location);
      refreshMemo(queryClient);
      notify({ message: '연결을 해제했습니다. 이 PC 의 메모는 그대로 있고, PLAN-A Work 의 사본도 지워지지 않습니다.' });
    } catch (error) {
      notify({ message: errorMessage(error, '연결을 해제하지 못했습니다.'), variant: 'error' });
    }
  };

  const syncNow = async () => {
    setAnchor(null);
    try {
      const report = await syncService.syncNow();
      refreshMemo(queryClient);
      notify({ message: report.offline ? 'PLAN-A Work 에 연결할 수 없습니다. 연결되면 자동으로 전달됩니다.' : '동기화했습니다.' });
    } catch (error) {
      notify({ message: errorMessage(error, '동기화하지 못했습니다.'), variant: 'error' });
    }
  };

  return (
    <Box data-testid="sync-link-control" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minHeight: 28 }}>
      {linked ? (
        <>
          <Button
            size="small"
            data-testid="sync-linked-button"
            startIcon={<CloudDoneOutlinedIcon sx={{ fontSize: 16 }} />}
            onClick={event => setAnchor(event.currentTarget)}
            sx={{ fontSize: '0.76rem', color: '#4B5563', borderRadius: '8px', px: 1.25 }}
          >
            PLAN-A Work와 연결됨
          </Button>
          {/* 문제가 있을 때만(전달 대기·로그인 필요·오류·충돌) 옆에 작게 */}
          {syncProblem(document) && <SyncMark document={document} location={location} />}
        </>
      ) : (
        <>
          <Typography sx={{ fontSize: '0.72rem', color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <CloudOffOutlinedIcon sx={{ fontSize: 14 }} /> 이 PC에만 저장
          </Typography>
          <Button
            size="small"
            variant="outlined"
            disabled={busy}
            data-testid="sync-link-button"
            startIcon={<CloudUploadOutlinedIcon sx={{ fontSize: 16 }} />}
            onClick={() => void link()}
            sx={{ fontSize: '0.76rem', borderRadius: '8px', py: 0.25, px: 1.25 }}
          >
            PLAN-A Work와 연결
          </Button>
        </>
      )}
      <Box sx={{ flex: 1 }} />
      <Tooltip title="변경 이력(History)">
        <Button size="small" startIcon={<HistoryIcon sx={{ fontSize: 16 }} />} onClick={onOpenHistory} sx={{ fontSize: '0.76rem', color: 'text.secondary' }}>
          History
        </Button>
      </Tooltip>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} data-personal-memo-overlay="true">
        <MenuItem dense onClick={() => void syncNow()}>
          <ListItemIcon><SyncIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="지금 동기화" />
        </MenuItem>
        <MenuItem dense onClick={() => void unlink()}>
          <ListItemIcon><LinkOffIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="연결 해제" secondary="이 PC 의 메모는 그대로 둡니다" />
        </MenuItem>
      </Menu>
    </Box>
  );
}

export function dayLinkLabel(date: string) {
  return koreanMonthDay(date);
}
