/**
 * 연결 상태 — 평소에는 조용하게. 문제가 있을 때만 '전달 대기 · 로그인 필요 · 동기화 오류 · 내용 확인 필요'.
 *
 *   SyncMark  : 주간 칸의 작은 표시(연결 안 됨이면 아무것도 그리지 않는다)
 *   SyncHeaderButton : 머리 줄의 연동 아이콘 — 지금 화면(날짜·List)의 연결 상태를 아이콘으로 보이고, 눌러서 연결·동기화·해제.
 *     문제가 있으면 아이콘에 색 점이 붙는다(메뉴를 열지 않아도 동기화 실패를 알 수 있다).
 */
import { useState } from 'react';
import { Box, Chip, Divider, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import CloudDoneOutlinedIcon from '@mui/icons-material/CloudDoneOutlined';
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined';
import CloudUploadOutlinedIcon from '@mui/icons-material/CloudUploadOutlined';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import SyncIcon from '@mui/icons-material/Sync';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import { useQueryClient } from '@tanstack/react-query';
import type { DocumentInfo, Location } from '../../domain/types';
import { koreanMonthDay } from '../../domain/location';
import { refreshMemo, useSyncOverview } from '../../services/queries';
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

/** 머리 줄의 연동 아이콘(문서 전체가 연결 단위 — 항목별 버튼은 없다). 주간·찾아보기처럼 문서가 없는 화면에서는 전체 현황과 연결 관리만. */
export function SyncHeaderButton({
  document,
  location,
  label,
  sx,
}: {
  document: DocumentInfo | null;
  location: Location | null;
  /** '10월 7일' · '앱 개발' */
  label: string;
  sx: object;
}) {
  const ui = useAppUi();
  const { notify } = usePersonalMemo();
  const queryClient = useQueryClient();
  const { data: overview } = useSyncOverview();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const linked = !!document?.syncEnabled;
  const problem = syncProblem(document);
  // 문서가 없는 화면 — 어딘가에 문제가 있으면 여기서도 알린다.
  const overviewProblem = !location && !!overview && overview.conflicts + overview.errors + overview.authRequired > 0;
  const dotColor = problem ? (problem.color === 'default' ? '#9CA3AF' : problem.color === 'error' ? '#DC2626' : '#D97706') : overviewProblem ? '#DC2626' : null;
  const state = problem || overviewProblem ? 'problem' : linked ? 'linked' : 'local';
  const statusText = !location
    ? `연동 중인 메모 ${overview?.linkedDocuments ?? 0}개${overviewProblem ? ' · 확인 필요' : ''}`
    : problem?.label ?? (linked ? '연동 중' : '이 PC에만 저장');
  const linkLabel = location?.kind === 'next' ? '이 List 연결하기' : '현재 날짜 연결하기';

  const link = async () => {
    if (!location) return;
    setAnchor(null);
    setBusy(true);
    try {
      await syncService.link(location);
      refreshMemo(queryClient);
      notify({ message: 'PLAN-A Work와 연결되었습니다.', variant: 'success' });
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
    if (!location) return;
    setAnchor(null);
    try {
      await syncService.unlink(location);
      refreshMemo(queryClient);
      notify({ message: '이 PC 의 연동을 해제했습니다. 이 PC 의 메모는 그대로 있고, 다른 기기의 연동과 PLAN-A Work 의 메모도 그대로입니다.' });
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

  const solveProblem = () => {
    setAnchor(null);
    if (problem?.conflict && document) ui.openConflicts(document.id);
    else if (document?.syncStatus === 'auth_required') ui.openAccount('PLAN-A Work 계정 연결이 필요합니다.');
    else ui.openSettings();
  };

  return (
    <>
      <Tooltip
        disableInteractive
        disableHoverListener={!!anchor}
        title={
          <>
            <b>PLAN-A Work 연동</b>
            <br />
            현재 날짜 또는 List를 PLAN-A Work와 연결하고 동기화 상태를 관리합니다.
            <br />
            지금: {statusText}
          </>
        }
      >
        <IconButton
          aria-label={`PLAN-A Work 연동 — ${statusText}`}
          aria-haspopup="menu"
          data-testid="sync-header-button"
          data-sync-state={state}
          disabled={busy}
          onClick={event => setAnchor(event.currentTarget)}
          sx={{ ...sx, position: 'relative', ...(state === 'linked' ? { color: 'primary.main' } : {}) }}
        >
          {state === 'linked' ? <CloudDoneOutlinedIcon sx={{ fontSize: 18 }} /> : <CloudOutlinedIcon sx={{ fontSize: 18 }} />}
          {dotColor && (
            <Box aria-hidden data-testid="sync-header-dot" sx={{ position: 'absolute', top: 4, right: 4, width: 8, height: 8, borderRadius: '50%', bgcolor: dotColor, border: '1px solid #fff', boxSizing: 'content-box' }} />
          )}
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} data-personal-memo-overlay="true" data-testid="sync-header-menu">
        <Box sx={{ px: 2, pt: 0.5, pb: 1, maxWidth: 300 }}>
          <Typography sx={{ fontSize: '0.8rem', fontWeight: 700 }}>PLAN-A Work 연동</Typography>
          <Typography data-testid="sync-status-line" sx={{ fontSize: '0.74rem', color: 'text.secondary', mt: 0.25 }}>
            {location ? `${label} · ${statusText}` : statusText}
          </Typography>
          {problem && <Typography sx={{ fontSize: '0.72rem', color: 'text.secondary', mt: 0.25 }}>{problem.tip}</Typography>}
        </Box>
        <Divider />
        {location && !linked && (
          <MenuItem dense data-testid="sync-link-button" onClick={() => void link()}>
            <ListItemIcon><CloudUploadOutlinedIcon fontSize="small" /></ListItemIcon>
            <ListItemText primary={linkLabel} />
          </MenuItem>
        )}
        {problem && problem.color !== 'default' && (
          <MenuItem dense data-testid="sync-solve-problem" onClick={solveProblem}>
            <ListItemIcon><ReportProblemOutlinedIcon fontSize="small" /></ListItemIcon>
            <ListItemText primary={problem.conflict ? '내용 비교하기' : document?.syncStatus === 'auth_required' ? '다시 로그인' : '오류 확인'} />
          </MenuItem>
        )}
        {(linked || !location) && (
          <MenuItem dense data-testid="sync-now" onClick={() => void syncNow()}>
            <ListItemIcon><SyncIcon fontSize="small" /></ListItemIcon>
            <ListItemText primary="지금 동기화" />
          </MenuItem>
        )}
        {location && linked && (
          <MenuItem dense data-testid="sync-unlink" onClick={() => void unlink()}>
            <ListItemIcon><LinkOffIcon fontSize="small" /></ListItemIcon>
            <ListItemText primary="이 PC 연동 해제" secondary="이 PC 의 메모는 그대로 · 다른 기기 연동은 유지" />
          </MenuItem>
        )}
        <MenuItem
          dense
          data-testid="sync-manage"
          onClick={() => {
            setAnchor(null);
            ui.openSettings();
          }}
        >
          <ListItemIcon><SettingsOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="연결 관리" secondary="계정 · 연동 현황(설정)" />
        </MenuItem>
      </Menu>
    </>
  );
}

export function dayLinkLabel(date: string) {
  return koreanMonthDay(date);
}
