/**
 * 앱 시작: 저장 위치 확인 → (첫 실행이면 위치 선택) → 메모장.
 * 전역 Dialog(설정·계정·충돌·내보내기)와 Rust 이벤트(sync://updated, auth://changed)를 여기서 잇는다.
 */
import { useEffect, useMemo, useState } from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { AppInfo, SyncReport } from '../domain/types';
import { appService, isTauri } from '../tauri/api';
import { keys, refreshMemo } from '../services/queries';
import { localDayString } from '../vendor/plan-a-work/utils/personalMemoDates';
import { MEMO_SURFACE } from '../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import { MemoProvider, usePersonalMemo } from '../features/memo/MemoProvider';
import MemoWorkspace from '../features/memo/MemoWorkspace';
import StorageSetup from '../features/settings/StorageSetup';
import SettingsDialog from '../features/settings/SettingsDialog';
import AccountDialog from '../features/auth/AccountDialog';
import ConflictDialog from '../features/sync/ConflictDialog';
import ExportDialog from '../features/export/ExportDialog';
import { AppUiContext, type AppUi } from './AppUi';

/** 자정이 지나면 '오늘' 이 바뀐다(창을 켜 둔 채 날짜가 넘어가도 Today 배지가 맞게). */
function useToday(): string {
  const [today, setToday] = useState(localDayString());
  useEffect(() => {
    const timer = window.setInterval(() => setToday(localDayString()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return today;
}

function Shell({ info, onStorageChanged }: { info: AppInfo; onStorageChanged: () => void }) {
  const queryClient = useQueryClient();
  const { store, notify } = usePersonalMemo();
  const [settings, setSettings] = useState(false);
  const [account, setAccount] = useState<{ reason?: string; onConnected?: () => void } | null>(null);
  const [conflicts, setConflicts] = useState<{ documentId?: string } | null>(null);
  const [exporting, setExporting] = useState(false);

  const ui: AppUi = useMemo(
    () => ({
      openSettings: () => setSettings(true),
      openAccount: (reason, onConnected) => setAccount({ reason, onConnected }),
      openConflicts: documentId => setConflicts({ documentId }),
      openExport: () => setExporting(true),
    }),
    [],
  );

  // Rust 쪽 Sync·인증 결과를 화면에 반영한다.
  useEffect(() => {
    const unlisten = [
      listen<SyncReport>('sync://updated', event => {
        refreshMemo(queryClient);
        const report = event.payload;
        if (report.conflicts > 0) {
          notify({
            // 출처(desktop/web·첫 연결)는 비교 화면이 알려 준다 — 여기서는 어느 쪽이라고 단정하지 않는다.
            message: '⚠ 메모 내용이 서로 다릅니다. 어느 쪽도 지우지 않았습니다 — 비교해서 최신으로 쓸 내용을 골라주세요.',
            variant: 'error',
            actionLabel: '비교하기',
            onAction: () => setConflicts({}),
          });
        } else if (report.notices.length) {
          notify({ message: report.notices.join('\n') });
        }
      }),
      listen('auth://changed', () => {
        void queryClient.invalidateQueries({ queryKey: keys.auth });
        void queryClient.invalidateQueries({ queryKey: keys.sync });
        refreshMemo(queryClient);
      }),
      listen<{ message: string }>('auth://error', event => notify({ message: event.payload.message, variant: 'error' })),
      listen('storage://changed', () => onStorageChanged()),
    ];
    return () => unlisten.forEach(p => void p.then(fn => fn()));
  }, [queryClient, notify, onStorageChanged]);

  // 창을 닫기 전에 남은 입력을 저장한다(저장이 끝난 뒤 닫힌다).
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested(async () => {
      await store.flushAll();
    });
    return () => void unlisten.then(fn => fn());
  }, [store]);

  return (
    <AppUiContext.Provider value={ui}>
      <MemoWorkspace />
      <SettingsDialog open={settings} info={info} onClose={() => setSettings(false)} />
      <AccountDialog open={!!account} reason={account?.reason} onClose={() => setAccount(null)} onConnected={account?.onConnected} />
      <ConflictDialog open={!!conflicts} documentId={conflicts?.documentId} onClose={() => setConflicts(null)} />
      <ExportDialog open={exporting} onClose={() => setExporting(false)} />
    </AppUiContext.Provider>
  );
}

function BrowserOnly() {
  return (
    <Box sx={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: MEMO_SURFACE, p: 4 }}>
      <Typography sx={{ maxWidth: 520, textAlign: 'center', color: 'text.secondary' }}>
        PLAN-A Memo 는 Windows 앱에서 실행됩니다. 개발 중에는 <b>npm run tauri dev</b> 로 실행해주세요.
        (브라우저만으로는 로컬 저장소에 접근하지 않습니다.)
      </Typography>
    </Box>
  );
}

export default function App() {
  const today = useToday();
  const info = useQuery({ queryKey: ['app', 'info'], queryFn: appService.info, enabled: isTauri() });
  const queryClient = useQueryClient();
  if (!isTauri()) return <BrowserOnly />;
  if (info.isPending) {
    return (
      <Box sx={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: MEMO_SURFACE }}>
        <CircularProgress size={24} />
      </Box>
    );
  }
  if (info.isError || !info.data) {
    return (
      <Box sx={{ p: 4 }}>
        <Typography color="error">앱 정보를 읽지 못했습니다. 다시 실행해주세요.</Typography>
      </Box>
    );
  }
  const reload = () => {
    queryClient.clear();
    void info.refetch();
  };
  if (info.data.storage.state !== 'ready') {
    return <StorageSetup status={info.data.storage} onReady={reload} />;
  }
  return (
    <MemoProvider today={today}>
      <Shell info={info.data} onStorageChanged={reload} />
    </MemoProvider>
  );
}
