/**
 * 설정 — 저장 위치 · Backup · PLAN-A Work 연결 · (개발용) Mock 서버 · 앱 정보(버전 · 업데이트 확인).
 * 섹션마다 흰 카드 한 장(머리: 아이콘·제목·설명 / 몸: 줄 단위 항목) — 메모 칸과 같은 선·그림자·모서리.
 * 로그는 앱이 계속 남기지만(문제 확인용) 설정 화면에는 보이지 않는다. 실행 환경(staging/production)도 보이지 않는다.
 */
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
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import BackupOutlinedIcon from '@mui/icons-material/BackupOutlined';
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { getName, getVersion } from '@tauri-apps/api/app';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppInfo, LocationInspection, UpdateInfo } from '../../domain/types';
import { keys, refreshMemo, useSyncOverview } from '../../services/queries';
import { attachmentService, errorMessage, mockServerService, storageService, syncService, updateService } from '../../tauri/api';
import { useAppUi } from '../../app/AppUi';
import {
  MEMO_CARD,
  MEMO_CARD_BORDER,
  MEMO_CARD_SHADOW,
  MEMO_GROUP_DIVIDER,
  MEMO_MUTED,
  MEMO_SECTION_TITLE,
  MEMO_SURFACE,
  MEMO_WRITE_AREA,
} from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';

/** 설정 섹션 카드 — 머리(아이콘 · 제목 · 한 줄 설명 · 오른쪽 보조 표시) + 아래 줄들. */
function SettingsSection({
  icon,
  title,
  description,
  aside,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Box
      component="section"
      aria-label={title}
      sx={{ bgcolor: MEMO_CARD, border: '1px solid', borderColor: MEMO_CARD_BORDER, borderRadius: '12px', boxShadow: MEMO_CARD_SHADOW }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, px: 2, pt: 1.75, pb: 1.5 }}>
        <Box
          aria-hidden
          sx={{
            width: 32, height: 32, flexShrink: 0, borderRadius: '8px', bgcolor: MEMO_WRITE_AREA, color: MEMO_SECTION_TITLE,
            display: 'flex', alignItems: 'center', justifyContent: 'center', '& .MuiSvgIcon-root': { fontSize: 18 },
          }}
        >
          {icon}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0, pt: 0.25 }}>
          <Typography sx={{ fontWeight: 700, fontSize: '0.92rem', lineHeight: 1.4 }}>{title}</Typography>
          {description && <Typography sx={{ fontSize: '0.78rem', color: MEMO_MUTED, mt: 0.25, lineHeight: 1.55 }}>{description}</Typography>}
        </Box>
        {aside && <Box sx={{ flexShrink: 0, pt: 0.25 }}>{aside}</Box>}
      </Box>
      {children}
    </Box>
  );
}

/** 섹션 안 한 줄 — 왼쪽 내용, 오른쪽 버튼. 좁으면 버튼이 아래로 내려간다. */
function SettingsRow({ children, actions }: { children?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <Box
      sx={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 2, rowGap: 1,
        px: 2, py: 1.5, borderTop: '1px solid', borderColor: MEMO_GROUP_DIVIDER,
      }}
    >
      {children && <Box sx={{ flex: '1 1 240px', minWidth: 0 }}>{children}</Box>}
      {actions && <Stack direction="row" spacing={1} sx={{ flexShrink: 0, ml: 'auto' }}>{actions}</Stack>}
    </Box>
  );
}

/** 앱 정보 — 이름·현재 버전(실행 중인 앱에서 읽음) · [업데이트 확인]. */
function AboutSection({ open }: { open: boolean }) {
  const ui = useAppUi();
  const name = useQuery({ queryKey: ['app', 'name'], queryFn: getName, enabled: open, staleTime: Infinity });
  const version = useQuery({ queryKey: ['app', 'version'], queryFn: getVersion, enabled: open, staleTime: Infinity });
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ kind: 'latest' | 'available' | 'error'; text: string; info?: UpdateInfo } | null>(null);

  const check = async () => {
    setChecking(true);
    setResult(null);
    try {
      const found = await updateService.check();
      setResult(
        found
          ? { kind: 'available', text: `새 버전 ${found.version} 이 있습니다.`, info: found }
          : { kind: 'latest', text: '최신 버전을 사용 중입니다.' },
      );
    } catch (failure) {
      setResult({ kind: 'error', text: errorMessage(failure, '업데이트를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.') });
    } finally {
      setChecking(false);
    }
  };

  return (
    <SettingsSection icon={<InfoOutlinedIcon />} title="앱 정보">
      <SettingsRow
        actions={
          <Button size="small" variant="outlined" onClick={() => void check()} disabled={checking} data-testid="update-check">
            {checking ? '확인 중…' : '업데이트 확인'}
          </Button>
        }
      >
        <RowLabel title={name.data ?? 'PLAN-A Memo'} detail={<span data-testid="app-version">현재 버전 {version.data ?? '…'}</span>} />
      </SettingsRow>
      {result && (
        <Box sx={{ px: 2, pb: 1.5 }} data-testid="update-check-result" data-kind={result.kind}>
          <Alert
            severity={result.kind === 'error' ? 'warning' : result.kind === 'available' ? 'info' : 'success'}
            action={
              result.info ? (
                <Button size="small" color="inherit" onClick={() => ui.openUpdate(result.info!)}>
                  자세히
                </Button>
              ) : undefined
            }
          >
            {result.text}
          </Alert>
        </Box>
      )}
    </SettingsSection>
  );
}

function RowLabel({ title, detail }: { title: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <>
      <Typography sx={{ fontSize: '0.86rem', fontWeight: 600, color: 'text.primary' }}>{title}</Typography>
      {detail && <Typography sx={{ fontSize: '0.76rem', color: MEMO_MUTED, mt: 0.25, lineHeight: 1.5 }}>{detail}</Typography>}
    </>
  );
}

function Stat({ label, value, alert = false }: { label: string; value: number; alert?: boolean }) {
  return (
    <Box sx={{ px: 1.5, py: 1, borderRadius: '8px', bgcolor: alert ? 'rgba(239, 68, 68, 0.06)' : MEMO_WRITE_AREA, minWidth: 0 }}>
      <Typography sx={{ fontSize: '0.72rem', color: alert ? 'error.main' : MEMO_MUTED, whiteSpace: 'nowrap' }}>{label}</Typography>
      <Typography sx={{ fontSize: '1rem', fontWeight: 700, color: alert ? 'error.main' : 'text.primary', fontVariantNumeric: 'tabular-nums', lineHeight: 1.4 }}>
        {value}
      </Typography>
    </Box>
  );
}

function RelocateDialog({ target, onClose, onDone }: { target: LocationInspection | null; onClose: () => void; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!target) return null;
  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth data-testid="relocate-dialog">
      <DialogTitle>저장 위치 변경</DialogTitle>
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
    <Box data-testid="mock-tools" sx={{ border: '1px dashed', borderColor: 'rgba(245, 158, 11, 0.55)', bgcolor: 'rgba(254, 243, 199, 0.35)', borderRadius: '10px', p: 1.5 }}>
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

  const backupNow = () =>
    void storageService
      .backupNow()
      .then(() => {
        void backups.refetch();
        setNotice({ severity: 'success', text: 'Backup 을 만들었습니다.' });
      })
      .catch(error => setNotice({ severity: 'error', text: errorMessage(error) }));

  const cleanupImages = () =>
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
      .catch(error => setNotice({ severity: 'error', text: errorMessage(error) }));

  const syncNow = () =>
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
      .catch(error => setNotice({ severity: 'error', text: errorMessage(error) }));

  const s = sync.data;
  const latestBackup = backups.data?.[0]?.createdAt;
  const authState = s?.auth.loggedIn ? 'connected' : s?.auth.expired ? 'expired' : 'none';
  const authDot = { connected: '#16A34A', expired: '#F59E0B', none: '#B4BAC4' }[authState];
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth data-personal-memo-overlay="true" data-testid="settings-dialog">
      <DialogTitle sx={{ borderBottom: '1px solid', borderColor: MEMO_CARD_BORDER }}>설정</DialogTitle>
      <DialogContent
        sx={{
          bgcolor: MEMO_SURFACE,
          display: 'flex', flexDirection: 'column', gap: 1.5,
          // DialogTitle 바로 다음 칸의 padding-top: 0 규칙보다 앞서야 한다.
          '&&': { px: 2.5, py: 2 },
        }}
      >
        {notice && <Alert severity={notice.severity} onClose={() => setNotice(null)}>{notice.text}</Alert>}

        <SettingsSection icon={<FolderOutlinedIcon />} title="저장 위치" description="메모 · 이미지 · History · Backup 이 모두 이 폴더에 저장됩니다.">
          <SettingsRow
            actions={
              <>
                <Button size="small" variant="outlined" onClick={() => tryOpen('root')}>폴더 열기</Button>
                <Button size="small" variant="outlined" onClick={() => void chooseNewLocation()}>위치 변경</Button>
              </>
            }
          >
            <Typography
              data-testid="storage-path"
              sx={{
                fontSize: '0.8rem', color: MEMO_SECTION_TITLE, wordBreak: 'break-all', lineHeight: 1.5,
                fontFamily: "'Cascadia Mono', Consolas, 'Malgun Gothic', monospace",
                bgcolor: MEMO_WRITE_AREA, borderRadius: '6px', px: 1.25, py: 0.75,
              }}
            >
              {status.data?.path ?? info.storage.path}
            </Typography>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection
          icon={<BackupOutlinedIcon />}
          title="Backup"
          description="Migration 전 · 저장 위치 변경 전 · 앱 업데이트 후 첫 실행 · 하루 한 번 자동으로 만듭니다(최대 20개 · 1GB)."
        >
          <SettingsRow
            actions={
              <>
                <Button size="small" onClick={() => tryOpen('backups')} sx={{ color: MEMO_SECTION_TITLE }}>폴더 열기</Button>
                <Button size="small" variant="outlined" onClick={backupNow}>지금 Backup</Button>
              </>
            }
          >
            <RowLabel
              title={`보관 중 ${backups.data?.length ?? 0}개`}
              detail={latestBackup ? `최근 ${new Date(latestBackup).toLocaleString('ko-KR')}` : '아직 만든 Backup 이 없습니다.'}
            />
          </SettingsRow>
          <SettingsRow actions={<Button size="small" variant="outlined" onClick={cleanupImages}>쓰지 않는 이미지 정리</Button>}>
            <RowLabel title="이미지 정리" detail="메모·History·비교 화면·Backup 어디에서도 쓰지 않고 7일 넘은 이미지만 지웁니다." />
          </SettingsRow>
        </SettingsSection>

        <SettingsSection
          icon={<CloudOutlinedIcon />}
          title="PLAN-A Work 연결"
          description="직접 고른 날짜 · List 만 PLAN-A Work 와 맞춥니다."
          aside={
            <Chip
              size="small"
              label={s?.isMock ? 'Mock 서버(개발용)' : s?.serverOrigin ? s.serverOrigin.replace(/^https?:\/\//, '') : 'PLAN-A Work'}
              color={s?.isMock ? 'warning' : 'default'}
              variant="outlined"
              sx={{ height: 22, fontSize: '0.7rem', fontWeight: 600, borderRadius: '6px', ...(s?.isMock ? {} : { borderColor: MEMO_CARD_BORDER, color: MEMO_SECTION_TITLE }) }}
            />
          }
        >
          <SettingsRow
            actions={
              <Button size="small" variant={authState === 'connected' ? 'outlined' : 'contained'} onClick={() => ui.openAccount()}>
                {authState === 'connected' ? '계정' : authState === 'expired' ? '다시 연결' : '계정 연결'}
              </Button>
            }
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: authDot, flexShrink: 0 }} />
              <Typography sx={{ fontSize: '0.86rem', fontWeight: 600 }}>
                {authState === 'connected'
                  ? `${s?.auth.session?.displayName} 연결됨`
                  : authState === 'expired'
                    ? '연결 만료 — 다시 연결 필요'
                    : '계정 연결 안 됨'}
              </Typography>
            </Box>
          </SettingsRow>
          <Box sx={{ px: 2, py: 1.5, borderTop: '1px solid', borderColor: MEMO_GROUP_DIVIDER }}>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 1 }}>
              <Stat label="연결된 메모" value={s?.linkedDocuments ?? 0} />
              <Stat label="전달 대기" value={s?.outbox ?? 0} />
              <Stat label="확인 필요" value={s?.conflicts ?? 0} alert={(s?.conflicts ?? 0) > 0} />
              <Stat label="오류" value={s?.errors ?? 0} alert={(s?.errors ?? 0) > 0} />
            </Box>
            {(s?.otherAccount ?? 0) > 0 && (
              <Typography sx={{ fontSize: '0.76rem', color: MEMO_MUTED, mt: 1 }}>
                다른 계정 연결 {s?.otherAccount}건(보내지 않음)
              </Typography>
            )}
            {s?.lastReport?.unavailable && (
              <Alert severity="info" sx={{ mt: 1.25, fontSize: '0.8rem' }}>
                PLAN-A Work 에서 Desktop 연결을 아직 사용할 수 없습니다. 변경은 이 PC 에 보관되어 있다가 열리면 보냅니다.
              </Alert>
            )}
            <Stack direction="row" spacing={1} sx={{ mt: 1.25 }}>
              <Button size="small" variant="outlined" onClick={syncNow}>지금 동기화</Button>
              {(s?.conflicts ?? 0) > 0 && <Button size="small" color="error" onClick={() => ui.openConflicts()}>충돌 확인</Button>}
            </Stack>
          </Box>
          {s?.isMock && (
            <Box sx={{ px: 2, pb: 2 }}>
              <MockTools />
            </Box>
          )}
        </SettingsSection>

        <AboutSection open={open} />
      </DialogContent>
      <DialogActions sx={{ borderTop: '1px solid', borderColor: MEMO_CARD_BORDER }}>
        <Button variant="outlined" onClick={onClose}>닫기</Button>
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
