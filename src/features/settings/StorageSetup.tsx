/**
 * 첫 실행 — 저장 위치 선택. 기본은 운영체제가 알려 준 사용자 폴더 + 'PLAN-A Memo'(드라이브를 가정하지 않는다).
 * 설정된 위치를 찾지 못했을 때도 이 화면을 쓴다 — 빈 DB 를 조용히 새로 만들지 않는다.
 */
import { useState } from 'react';
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { LocationInspection, StorageStatus } from '../../domain/types';
import { errorMessage, storageService } from '../../tauri/api';
import { MEMO_NOTE_DATE, MEMO_NOTE_SERIF, MEMO_SURFACE } from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';

export default function StorageSetup({ status, onReady }: { status: StorageStatus; onReady: () => void }) {
  const [picked, setPicked] = useState<LocationInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const missing = status.state === 'missing' || status.state === 'error';

  const initialize = async (path: string, createNew: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await storageService.initialize(path, createNew);
      onReady();
    } catch (failure) {
      setError(errorMessage(failure, '저장 위치를 준비하지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    setError(null);
    const folder = await openDialog({ directory: true, multiple: false, title: '메모를 저장할 폴더 선택' });
    if (!folder || Array.isArray(folder)) return;
    const inspection = await storageService.inspect(folder);
    if (inspection.problem) setError(inspection.problem);
    setPicked(inspection);
  };

  return (
    <Box sx={{ height: '100vh', bgcolor: MEMO_SURFACE, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3 }}>
      <Paper data-testid="storage-setup" sx={{ maxWidth: 560, width: '100%', p: 4, borderRadius: '18px', border: '1px solid #EEEBE5' }}>
        <Typography sx={{ fontFamily: MEMO_NOTE_SERIF, fontSize: '1.7rem', color: MEMO_NOTE_DATE, mb: 1 }}>PLAN-A Memo</Typography>
        {missing ? (
          <>
            <Typography sx={{ fontWeight: 800, fontSize: '1.05rem' }}>메모 저장 위치를 찾을 수 없습니다.</Typography>
            <Typography sx={{ fontSize: '0.88rem', color: 'text.secondary', mt: 1, wordBreak: 'break-all' }}>{status.path}</Typography>
            <Typography sx={{ fontSize: '0.84rem', color: 'text.secondary', mt: 1 }}>
              외장 드라이브·네트워크 폴더라면 연결한 뒤 다시 확인해주세요. 옮긴 폴더라면 그 위치를 선택하면 그대로 이어집니다.
              빈 메모장을 새로 만들지는 않습니다.
            </Typography>
            <Stack spacing={1} sx={{ mt: 3 }}>
              <Button variant="contained" disabled={busy} onClick={() => status.path && void initialize(status.path, false)}>다시 확인</Button>
              <Button variant="outlined" disabled={busy} onClick={() => void pick()}>다른 위치에서 열기</Button>
            </Stack>
          </>
        ) : (
          <>
            <Typography sx={{ fontWeight: 800, fontSize: '1.05rem' }}>PLAN-A Memo에 오신 것을 환영합니다.</Typography>
            <Typography sx={{ fontSize: '0.9rem', color: 'text.secondary', mt: 1 }}>메모를 저장할 위치를 선택해주세요.</Typography>
            <Box sx={{ mt: 2.5, p: 2, borderRadius: 2, bgcolor: '#F7F6F2' }}>
              <Typography sx={{ fontSize: '0.78rem', color: 'text.secondary', fontWeight: 700 }}>권장 위치</Typography>
              <Typography data-testid="default-storage-path" sx={{ fontSize: '0.92rem', fontWeight: 700, wordBreak: 'break-all', mt: 0.25 }}>
                {status.defaultPath ?? '(사용자 폴더를 찾지 못했습니다)'}
              </Typography>
            </Box>
            <Stack spacing={1} sx={{ mt: 3 }}>
              <Button
                variant="contained"
                disabled={busy || !status.defaultPath}
                data-testid="use-default-storage"
                onClick={() => status.defaultPath && void initialize(status.defaultPath, true)}
              >
                기본 위치 사용
              </Button>
              <Button variant="outlined" disabled={busy} onClick={() => void pick()}>다른 폴더 선택</Button>
            </Stack>
            <Typography sx={{ fontSize: '0.76rem', color: 'text.secondary', mt: 2 }}>
              메모는 이 PC 에 저장됩니다. 로그인 없이 모든 기능을 쓸 수 있고, PLAN-A Work 와는 직접 고른 날짜·List 만 연결됩니다.
            </Typography>
          </>
        )}
        {picked && !picked.problem && (
          <Alert severity="info" sx={{ mt: 2 }}>
            <Typography sx={{ fontSize: '0.85rem', wordBreak: 'break-all', fontWeight: 700 }}>{picked.resolvedPath}</Typography>
            <Typography sx={{ fontSize: '0.8rem' }}>
              {picked.isStorage
                ? '이 위치의 기존 PLAN-A Memo 데이터를 엽니다.'
                : picked.resolvedPath !== picked.path
                  ? "고른 폴더에 다른 파일이 있어 그 안에 'PLAN-A Memo' 폴더를 만듭니다."
                  : '이 폴더에 새 메모장을 만듭니다.'}
            </Typography>
            <Button size="small" variant="contained" sx={{ mt: 1 }} disabled={busy} onClick={() => void initialize(picked.path, true)}>
              {picked.isStorage ? '열기' : '이 위치 사용'}
            </Button>
          </Alert>
        )}
        {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
      </Paper>
    </Box>
  );
}
