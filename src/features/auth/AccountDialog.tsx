/**
 * PLAN-A Work 계정 연결 — 로컬 메모에는 필요 없다. 'PLAN-A Work와 연결' 할 때만 쓴다.
 *
 * memo-sync-v1: 기본 브라우저 로그인(Google/Naver/이메일) → Web 에서 [확인] → 127.0.0.1 loopback 으로 돌아옴
 * → Rust 가 PKCE verifier 로 교환 → Windows 자격 증명 관리자에 저장. 화면은 `auth://changed` 로 결과를 받는다.
 * 개발용 Mock 서버는 브라우저 대신 동의를 흉내 내고, 같은 loopback·교환 경로를 지난다.
 */
import { useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import { keys, refreshMemo, useAuthStatus } from '../../services/queries';
import { authService, errorMessage } from '../../tauri/api';

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('ko-KR');
}

export default function AccountDialog({
  open,
  reason,
  onClose,
  onConnected,
}: {
  open: boolean;
  reason?: string;
  onClose: () => void;
  onConnected?: () => void;
}) {
  const status = useAuthStatus();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const auth = status.data;
  const session = auth?.session ?? null;
  const loggedIn = !!auth?.loggedIn;
  const expired = !!auth?.expired;
  const isMock = auth?.provider === 'mock';

  // 브라우저에서 돌아와 연결이 끝나면(auth://changed → useAuthStatus 갱신) 닫는다.
  // (상태 갱신이 늦게 올 수 있으므로 '대기 아님' 만으로 실패라고 보지 않는다 — 실패는 auth://error 로.)
  useEffect(() => {
    if (!waiting || !auth?.loggedIn) return;
    setWaiting(false);
    onClose();
    onConnected?.();
  }, [auth, waiting, onClose, onConnected]);

  useEffect(() => {
    if (!waiting) return;
    const unlisten = listen<{ message: string }>('auth://error', event => {
      setWaiting(false);
      setError(event.payload.message);
    });
    return () => void unlisten.then(fn => fn());
  }, [waiting]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.auth });
    refreshMemo(queryClient);
  };

  const connect = async (reconnect: boolean) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await authService.beginLogin(reconnect);
      setWaiting(true);
      refresh();
    } catch (failure) {
      setError(errorMessage(failure, '계정을 연결하지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    await authService.cancelLogin().catch(() => undefined);
    setWaiting(false);
    refresh();
  };

  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await authService.logout();
      setNotice(
        result.serverRevoked
          ? '로그아웃했습니다. 연결돼 있던 날짜·List 는 이 PC 에만 남습니다.'
          : '이 PC 에서 로그아웃했습니다. 서버에 알리지 못했으니 PLAN-A Work 의 기기 관리에서 이 PC 를 해제해주세요.',
      );
      refresh();
    } catch (failure) {
      setError(errorMessage(failure, '로그아웃하지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth data-personal-memo-overlay="true" data-testid="account-dialog">
      <DialogTitle sx={{ fontSize: '1rem', fontWeight: 800 }}>PLAN-A Work 계정</DialogTitle>
      <DialogContent>
        {session && (loggedIn || expired) ? (
          <Box>
            <Typography sx={{ fontWeight: 700 }}>{session.displayName}</Typography>
            <Typography sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>
              이 PC: {session.deviceName} · 연결 {formatDate(session.connectedAt)} · {formatDate(session.expiresAt)} 까지
            </Typography>
            {expired && (
              <Alert severity="warning" sx={{ mt: 1.5, fontSize: '0.8rem' }}>
                연결이 만료되었거나 PLAN-A Work 에서 이 PC 가 해제되었습니다. 다시 연결하면 이어서 동기화합니다. 그동안의 변경은 이 PC 에 보관돼 있습니다.
              </Alert>
            )}
            {session.isMock && (
              <Alert severity="info" sx={{ mt: 1.5, fontSize: '0.8rem' }}>
                개발용 Mock 서버 계정입니다. 실제 PLAN-A Work 계정·서버와 연결되지 않았습니다.
              </Alert>
            )}
            <Typography sx={{ fontSize: '0.8rem', color: 'text.secondary', mt: 1.5 }}>
              로그아웃하면 이 PC 의 PLAN-A Work 연결이 해제되고 동기화가 멈춥니다. 이 PC 의 메모는 지워지지 않습니다.
            </Typography>
          </Box>
        ) : (
          <Box>
            <Typography sx={{ fontSize: '0.92rem', fontWeight: 700 }}>{reason || 'PLAN-A Work 계정 연결이 필요합니다.'}</Typography>
            <Typography sx={{ fontSize: '0.82rem', color: 'text.secondary', mt: 1 }}>
              메모 작성·검색·내보내기는 로그인 없이 쓸 수 있습니다. 연결은 직접 고른 날짜·List 를 PLAN-A Work 와 맞출 때만 필요합니다.
              로그인만으로 메모를 올리지 않습니다.
            </Typography>
            {isMock && (
              <Alert severity="info" sx={{ mt: 1.5, fontSize: '0.8rem' }}>
                개발 빌드 — 서버 주소가 없어 개발용 Mock 서버로 연결합니다(브라우저를 열지 않음).
              </Alert>
            )}
          </Box>
        )}
        {waiting && (
          <Alert severity="info" icon={<CircularProgress size={16} />} sx={{ mt: 1.5, fontSize: '0.8rem' }}>
            {isMock
              ? '연결하는 중…'
              : '브라우저에서 PLAN-A Work 로그인 후 [확인]을 누르면 자동으로 돌아옵니다(5분 안에).'}
          </Alert>
        )}
        {notice && <Alert severity="success" sx={{ mt: 1.5, fontSize: '0.8rem' }}>{notice}</Alert>}
        {error && <Alert severity="error" sx={{ mt: 1.5 }}>{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>닫기</Button>
        {waiting ? (
          <Button color="inherit" onClick={() => void cancel()}>취소</Button>
        ) : loggedIn ? (
          <Button color="inherit" onClick={() => void logout()} disabled={busy}>로그아웃</Button>
        ) : expired ? (
          <>
            <Button color="inherit" onClick={() => void logout()} disabled={busy}>다른 계정으로</Button>
            <Button variant="contained" onClick={() => void connect(true)} disabled={busy} data-testid="account-connect">
              다시 연결
            </Button>
          </>
        ) : (
          <Button variant="contained" onClick={() => void connect(false)} disabled={busy} data-testid="account-connect">
            계정 연결
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
