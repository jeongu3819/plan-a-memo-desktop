/**
 * 새 버전 알림 · 설치 — 사용자가 [업데이트 설치]를 눌렀을 때만 설치한다(강제 설치·강제 재시작 없음).
 *
 *   [업데이트 설치] → 남은 입력 저장(flushAll) · 저장 실패/이미지 넣는 중이면 멈춤
 *   → Rust: 설치 전 Backup → 내려받기(진행률) → 서명 검증 → 설치 프로그램 실행(앱이 닫히고 설치 후 다시 열림)
 * 실패하면 원인을 보여 주고 지금 버전을 그대로 쓴다. 릴리스 노트는 배포된 업데이트 정보(latest.json)의 내용 그대로다.
 */
import { useEffect, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, Typography } from '@mui/material';
import { listen } from '@tauri-apps/api/event';
import type { UpdateInfo, UpdateProgress } from '../../domain/types';
import { errorMessage, updateService } from '../../tauri/api';
import { usePersonalMemo } from '../memo/MemoProvider';
import {
  MEMO_CARD_BORDER,
  MEMO_MUTED,
  MEMO_SECTION_TITLE,
  MEMO_WRITE_AREA,
} from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';

/** 릴리스 노트(Markdown 일부) — 글자로만 보여 준다(HTML 로 해석하지 않는다). '- ' 줄은 목록, '#' 줄은 소제목. */
function ReleaseNotes({ notes }: { notes: string }) {
  const lines = notes.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim());
  return (
    <Box component="div" data-testid="update-notes" sx={{ fontSize: '0.84rem', color: 'text.primary', lineHeight: 1.6 }}>
      {lines.map((line, index) => {
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        if (heading) {
          return (
            <Typography key={index} sx={{ fontSize: '0.8rem', fontWeight: 700, color: MEMO_SECTION_TITLE, mt: index ? 1 : 0 }}>
              {heading[1]}
            </Typography>
          );
        }
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
        return (
          <Box key={index} sx={{ display: 'flex', gap: 1, pl: bullet ? 0.25 : 0 }}>
            {bullet && <Box component="span" aria-hidden sx={{ color: MEMO_MUTED }}>•</Box>}
            <Box component="span">{bullet ? bullet[1] : line}</Box>
          </Box>
        );
      })}
    </Box>
  );
}

function VersionRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
      <Typography sx={{ fontSize: '0.84rem', color: MEMO_MUTED }}>{label}</Typography>
      <Typography sx={{ fontSize: '0.86rem', fontWeight: strong ? 700 : 500, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
    </Box>
  );
}

export default function UpdateDialog({ info, onClose }: { info: UpdateInfo | null; onClose: () => void }) {
  const { store } = usePersonalMemo();
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!info) return;
    setError(null);
    setProgress(null);
    setInstalling(false);
  }, [info]);

  useEffect(() => {
    if (!installing) return;
    const unlisten = listen<UpdateProgress>('update://progress', event => setProgress(event.payload));
    return () => void unlisten.then(fn => fn());
  }, [installing]);

  const install = async () => {
    setError(null);
    setInstalling(true);
    try {
      // 설치 전에 쓰던 메모를 모두 저장한다 — 저장되지 않은 것이 있으면 설치하지 않는다.
      await store.flushAll();
      if (store.anyUploading()) {
        throw new Error('이미지를 넣는 중입니다. 끝난 뒤 다시 설치해주세요.');
      }
      if (store.failedCount() > 0) {
        throw new Error('저장하지 못한 메모가 있어 설치를 멈췄습니다. 메모의 [다시 시도]로 저장을 먼저 확인해주세요.');
      }
      await updateService.install();
      // 성공하면 앱이 곧 닫힌다(설치 프로그램이 설치 후 다시 실행한다).
    } catch (failure) {
      setInstalling(false);
      setProgress(null);
      setError(errorMessage(failure, '업데이트를 설치하지 못했습니다. 지금 버전을 그대로 사용합니다.'));
    }
  };

  const percent = progress?.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;
  const phaseText =
    progress?.phase === 'verifying'
      ? '서명 확인 중…'
      : progress?.phase === 'installing'
        ? '설치 프로그램을 여는 중… 앱이 잠시 닫혔다가 다시 열립니다.'
        : progress
          ? `내려받는 중… ${percent !== null ? `${percent}%` : `${(progress.downloaded / 1024 / 1024).toFixed(1)}MB`}`
          : '설치 준비 중(메모 저장 · Backup)…';

  return (
    <Dialog
      open={!!info}
      onClose={installing ? undefined : onClose}
      maxWidth="xs"
      fullWidth
      data-personal-memo-overlay="true"
      data-testid="update-dialog"
    >
      <DialogTitle>새로운 업데이트가 있습니다</DialogTitle>
      {info && (
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, p: 1.5, borderRadius: '10px', bgcolor: MEMO_WRITE_AREA }}>
            <VersionRow label="현재 버전" value={info.currentVersion} />
            <VersionRow label="새 버전" value={info.version} strong />
          </Box>
          {info.notes && (
            <Box sx={{ mt: 2 }}>
              <Typography sx={{ fontSize: '0.78rem', fontWeight: 700, color: MEMO_SECTION_TITLE, mb: 0.75 }}>이번 업데이트</Typography>
              <Box sx={{ maxHeight: 220, overflowY: 'auto', border: '1px solid', borderColor: MEMO_CARD_BORDER, borderRadius: '10px', px: 1.5, py: 1.25 }}>
                <ReleaseNotes notes={info.notes} />
              </Box>
            </Box>
          )}
          <Typography sx={{ fontSize: '0.76rem', color: MEMO_MUTED, mt: 1.5, lineHeight: 1.55 }}>
            설치하면 앱이 잠시 닫혔다가 다시 열립니다. 설치 전에 쓰던 메모를 저장하고 Backup 을 만듭니다. 메모·이미지·설정은 그대로입니다.
          </Typography>
          {installing && (
            <Box sx={{ mt: 1.5 }} data-testid="update-progress">
              <LinearProgress variant={percent !== null ? 'determinate' : 'indeterminate'} value={percent ?? undefined} sx={{ borderRadius: 1 }} />
              <Typography sx={{ fontSize: '0.76rem', color: MEMO_MUTED, mt: 0.75 }}>{phaseText}</Typography>
            </Box>
          )}
          {error && (
            <Alert severity="error" sx={{ mt: 1.5 }} data-testid="update-error">
              {error}
            </Alert>
          )}
        </DialogContent>
      )}
      <DialogActions>
        <Button variant="outlined" onClick={onClose} disabled={installing}>나중에</Button>
        <Button variant="contained" onClick={() => void install()} disabled={installing} data-testid="update-install">
          {error ? '다시 시도' : '업데이트 설치'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
