/** 설정 — 저장 위치 · Backup · PLAN-A Work 연결 · (개발용) Mock 서버 · 로그 · 정보. */
import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppInfo, LocationInspection } from '../../domain/types';
import { keys, refreshMemo, useSyncOverview } from '../../services/queries';
import { attachmentService, errorMessage, mockServerService, storageService, syncService } from '../../tauri/api';
import { useAppUi } from '../../app/AppUi';

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Typography sx={{ fontWeight: 800, fontSize: '0.9rem', mb: 1 }}>{children}</Typography>;
}

function RelocateDialog({ target, onClose, onDone }: { target: LocationInspection | null; onClose: () => void; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!target) return null;
  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth data-testid="relocate-dialog">
      <DialogTitle sx={{ fontSize: '1rem', fontWeight: 800 }}>저장 위치 변경</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ fontSize: '0.88rem' }}>
          메모 DB · 첨부 이미지 · History · Backup · Sync 대기열을 아래 위치로 복사하고 검증한 뒤 새 위치를 사용합니다.
          실패하면 지금 위치를 그대로 씁니다. 기존 폴더는 지우지 않으니 확인 후 직접 정리해주세요.
        </DialogContentText>
        <Typography sx={{ mt: 1.5, fontSize: '0.85rem', fontWeight: 700, wordBreak: 'break-all' }}>{target.resolvedPath}</Typography>
        {target.resolvedPath !== target.path && (
          <Typography sx={{ fontSize: '0.75rem', color: 'text.secondary' }}>고른 폴더에 다른 파일이 있어 그 안에 'PLAN-A Memo' 폴더를 만듭니다.</Typography>
        )}
        {error && <Alert severity="error" sx={{ mt: 1.5 }}>{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>취소</Button>
        <Button
          variant="contained"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const report = await storageService.relocate(target.path);
              onDone(`새 위치로 옮겼습니다(파일 ${report.copiedFiles}개). 예전 폴더: ${report.oldRoot}`);
            } catch (failure) {
              setError(errorMessage(failure, '옮기지 못했습니다. 지금 위치를 그대로 사용합니다.'));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '복사·검증 중…' : '옮기기'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function MockTools() {
  const queryClient = useQueryClient();
  const sync = useSyncOverview();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [text, setText] = useState('Web 에서 추가한 메모');
  const [message, setMessage] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMessage(null);
    try {
      await fn();
      await syncService.syncNow();
      refreshMemo(queryClient);
      setMessage(ok);
    } catch (failure) {
      setMessage(errorMessage(failure));
    }
  };
  return (
    <Box data-testid="mock-tools" sx={{ border: '1px dashed', borderColor: 'warning.main', borderRadius: 2, p: 1.5 }}>
      <Typography sx={{ fontSize: '0.8rem', color: 'warning.dark', fontWeight: 700, mb: 1 }}>
        개발용 Mock 서버(memo-sync-v1 흉내) — 실제 PLAN-A Work 가 아닙니다. 개발 빌드에서 서버 주소가 없을 때만 보입니다.
        상태는 저장 폴더 sync/mock-server-v1.json 에 있습니다.
      </Typography>
      <FormControlLabel
        control={<Switch size="small" checked={sync.data?.mockOnline ?? true} onChange={e => void act(() => mockServerService.setOnline(e.target.checked), e.target.checked ? '온라인' : '오프라인 — 변경은 전달 대기로 남습니다.')} />}
        label={<Typography sx={{ fontSize: '0.85rem' }}>서버 연결(온라인)</Typography>}
      />
      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        <TextField size="small" type="date" value={date} onChange={e => setDate(e.target.value)} sx={{ width: 160 }} />
        <TextField size="small" value={text} onChange={e => setText(e.target.value)} sx={{ flex: 1 }} />
      </Stack>
      <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap">
        <Button size="small" variant="outlined" onClick={() => void act(() => mockServerService.remoteEdit({ kind: 'day', date }, text), 'Web 수정을 만들었습니다.')}>
          이 날짜를 Web 에서 수정
        </Button>
        <Button size="small" variant="outlined" onClick={() => void act(() => mockServerService.remoteEdit({ kind: 'next', listId: null }, text), 'Web 수정을 만들었습니다.')}>
          Next 를 Web 에서 수정
        </Button>
        <Button size="small" variant="outlined" color="error" onClick={() => void act(() => mockServerService.remoteDelete({ kind: 'day', date }), 'Web 에서 삭제했습니다.')}>
          이 날짜를 Web 에서 삭제
        </Button>
        <Button size="small" variant="outlined" onClick={() => void act(() => mockServerService.remoteUnlink({ kind: 'day', date }), 'Web 에서 연결을 해제했습니다.')}>
          이 날짜를 Web 에서 연결 해제
        </Button>
        <Button size="small" variant="outlined" onClick={() => void act(() => mockServerService.revokeDevice(), 'Web 기기 관리에서 이 PC 를 해제했습니다.')}>
          Web 에서 이 PC 해제
        </Button>
        <Button size="small" variant="outlined" onClick={() => void act(() => mockServerService.failUploads(1), '다음 이미지 업로드 1회를 실패시킵니다.')}>
          이미지 업로드 1회 실패
        </Button>
        <Button size="small" variant="outlined" onClick={() => void act(() => mockServerService.dropPushResponses(1), '다음 전송은 서버 저장 후 응답이 끊깁니다.')}>
          전송 응답 1회 유실
        </Button>
        <Button size="small" variant="outlined" onClick={() => void act(() => mockServerService.setAccount(2), '다음 Mock 로그인은 계정 #2 입니다(계정 바꾸기 확인).')}>
          다음 로그인 = 계정 #2
        </Button>
      </Stack>
      {message && <Typography sx={{ fontSize: '0.78rem', mt: 1 }}>{message}</Typography>}
    </Box>
  );
}

export default function SettingsDialog({ open, info, onClose }: { open: boolean; info: AppInfo; onClose: () => void }) {
  const ui = useAppUi();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['storage', 'status'], queryFn: storageService.status, enabled: open });
  const backups = useQuery({ queryKey: ['storage', 'backups'], queryFn: storageService.backups, enabled: open });
  const sync = useSyncOverview();
  const [target, setTarget] = useState<LocationInspection | null>(null);
  const [notice, setNotice] = useState<{ severity: 'success' | 'error' | 'info'; text: string } | null>(null);

  const chooseNewLocation = async () => {
    setNotice(null);
    const picked = await openDialog({ directory: true, multiple: false, title: '새 저장 위치 선택' });
    if (!picked || Array.isArray(picked)) return;
    const inspection = await storageService.inspect(picked);
    if (inspection.problem) {
      setNotice({ severity: 'error', text: inspection.problem });
      return;
    }
    if (inspection.isStorage) {
      setNotice({ severity: 'error', text: '선택한 위치에 이미 PLAN-A Memo 데이터가 있습니다. 비어 있는 폴더를 선택해주세요.' });
      return;
    }
    setTarget(inspection);
  };

  const tryOpen = (kind: Parameters<typeof storageService.openFolder>[0]) =>
    void storageService.openFolder(kind).catch(error => setNotice({ severity: 'error', text: errorMessage(error) }));

  const s = sync.data;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth data-personal-memo-overlay="true" data-testid="settings-dialog">
      <DialogTitle sx={{ fontSize: '1rem', fontWeight: 800 }}>설정</DialogTitle>
      <DialogContent>
        {notice && <Alert severity={notice.severity} sx={{ mb: 2 }} onClose={() => setNotice(null)}>{notice.text}</Alert>}

        <SectionTitle>저장 위치</SectionTitle>
        <Typography data-testid="storage-path" sx={{ fontSize: '0.85rem', wordBreak: 'break-all', mb: 1 }}>{status.data?.path ?? info.storage.path}</Typography>
        <Stack direction="row" spacing={1}>
          <Button size="small" variant="outlined" onClick={() => tryOpen('root')}>폴더 열기</Button>
          <Button size="small" variant="outlined" onClick={() => void chooseNewLocation()}>위치 변경</Button>
        </Stack>

        <Divider sx={{ my: 2 }} />
        <SectionTitle>Backup</SectionTitle>
        <Typography sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>
          Migration 전 · 저장 위치 변경 전 · 앱 업데이트 후 첫 실행 · 하루 한 번 자동으로 만듭니다(최대 20개 · 1GB).
        </Typography>
        <Typography sx={{ fontSize: '0.85rem', mt: 0.5 }}>
          보관 중 {backups.data?.length ?? 0}개{backups.data?.[0]?.createdAt ? ` · 최근 ${new Date(backups.data[0].createdAt).toLocaleString('ko-KR')}` : ''}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          <Button
            size="small"
            variant="outlined"
            onClick={() =>
              void storageService
                .backupNow()
                .then(() => {
                  void backups.refetch();
                  setNotice({ severity: 'success', text: 'Backup 을 만들었습니다.' });
                })
                .catch(error => setNotice({ severity: 'error', text: errorMessage(error) }))
            }
          >
            지금 Backup
          </Button>
          <Button size="small" onClick={() => tryOpen('backups')}>Backup 폴더 열기</Button>
        </Stack>
        <Typography sx={{ fontSize: '0.8rem', color: 'text.secondary', mt: 1.5 }}>
          이미지 정리 — 메모·History·비교 화면·Backup 어디에서도 쓰지 않고 7일 넘은 이미지만 지웁니다.
        </Typography>
        <Button
          size="small"
          variant="outlined"
          sx={{ mt: 0.5 }}
          onClick={() =>
            void attachmentService
              .cleanup(true)
              .then(async preview => {
                if (!preview.candidates) {
                  setNotice({ severity: 'info', text: `정리할 이미지가 없습니다(전체 ${preview.total}개${preview.keptForBackups ? ` · Backup 때문에 보관 ${preview.keptForBackups}개` : ''}).` });
                  return;
                }
                const mb = (preview.candidateBytes / 1024 / 1024).toFixed(1);
                if (!window.confirm(`쓰지 않는 이미지 ${preview.candidates}개(${mb}MB)를 지울까요? 메모와 History 는 바뀌지 않습니다.`)) return;
                const done = await attachmentService.cleanup(false);
                setNotice({ severity: 'success', text: `이미지 ${done.removed}개를 정리했습니다.` });
              })
              .catch(error => setNotice({ severity: 'error', text: errorMessage(error) }))
          }
        >
          쓰지 않는 이미지 정리
        </Button>

        <Divider sx={{ my: 2 }} />
        <SectionTitle>PLAN-A Work 연결</SectionTitle>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Chip
            size="small"
            label={s?.isMock ? 'Mock 서버(개발용)' : s?.serverOrigin ? s.serverOrigin.replace(/^https?:\/\//, '') : 'PLAN-A Work'}
            color={s?.isMock ? 'warning' : 'primary'}
            variant="outlined"
          />
          <Typography sx={{ fontSize: '0.85rem' }}>
            {s?.auth.loggedIn
              ? `${s.auth.session?.displayName} 연결됨`
              : s?.auth.expired
                ? '연결 만료 — 다시 연결 필요'
                : '계정 연결 안 됨'}
          </Typography>
          <Button size="small" onClick={() => ui.openAccount()}>{s?.auth.loggedIn ? '계정' : s?.auth.expired ? '다시 연결' : '계정 연결'}</Button>
        </Stack>
        <Typography sx={{ fontSize: '0.8rem', color: 'text.secondary', mt: 1 }}>
          연결된 메모 {s?.linkedDocuments ?? 0}건 · 전달 대기 {s?.outbox ?? 0} · 확인 필요 {s?.conflicts ?? 0} · 오류 {s?.errors ?? 0}
          {(s?.otherAccount ?? 0) > 0 ? ` · 다른 계정 연결 ${s?.otherAccount}건(보내지 않음)` : ''}
        </Typography>
        {s?.lastReport?.unavailable && (
          <Alert severity="info" sx={{ mt: 1, fontSize: '0.8rem' }}>
            PLAN-A Work 에서 Desktop 연결을 아직 사용할 수 없습니다. 변경은 이 PC 에 보관되어 있다가 열리면 보냅니다.
          </Alert>
        )}
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          <Button
            size="small"
            variant="outlined"
            onClick={() =>
              void syncService
                .syncNow()
                .then(report => {
                  refreshMemo(queryClient);
                  void queryClient.invalidateQueries({ queryKey: keys.sync });
                  setNotice({
                    severity: report.offline || report.failed ? 'info' : 'success',
                    text: report.offline
                      ? '서버에 연결할 수 없습니다. 변경은 전달 대기로 남아 있습니다.'
                      : `동기화 — 보냄 ${report.pushed} · 받음 ${report.pulled} · 확인 필요 ${report.conflicts}${report.failed ? ` · 실패 ${report.failed}` : ''}`,
                  });
                })
                .catch(error => setNotice({ severity: 'error', text: errorMessage(error) }))
            }
          >
            지금 동기화
          </Button>
          {(s?.conflicts ?? 0) > 0 && <Button size="small" color="error" onClick={() => ui.openConflicts()}>충돌 확인</Button>}
        </Stack>
        {s?.isMock && (
          <Box sx={{ mt: 1.5 }}>
            <MockTools />
          </Box>
        )}

        <Divider sx={{ my: 2 }} />
        <SectionTitle>로그 · 정보</SectionTitle>
        <Typography sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>
          PLAN-A Memo {info.version} · {info.env} · 로그에는 메모 본문·이미지·토큰을 남기지 않습니다.
        </Typography>
        <Button size="small" sx={{ mt: 0.5 }} onClick={() => tryOpen('logs')}>로그 폴더 열기</Button>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>닫기</Button>
      </DialogActions>
      <RelocateDialog
        target={target}
        onClose={() => setTarget(null)}
        onDone={text => {
          setTarget(null);
          setNotice({ severity: 'success', text });
          void status.refetch();
          refreshMemo(queryClient);
        }}
      />
    </Dialog>
  );
}
