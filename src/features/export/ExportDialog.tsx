/**
 * 내보내기 — PLAN-A Work 개인 메모 내보내기와 같은 형식(ZIP 백업 · TXT · CSV).
 * 이 PC 에서만 만든다(서버로 아무것도 올리지 않는다).
 */
import { useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { save } from '@tauri-apps/plugin-dialog';
import type { ExportOptions, ExportResult } from '../../domain/types';
import { errorMessage, exportService, storageService } from '../../tauri/api';

const FORMATS: Array<{ value: ExportOptions['format']; label: string; hint: string }> = [
  { value: 'zip', label: 'ZIP 백업', hint: '서식 그대로(HTML) + 이미지 파일 + txt/csv + manifest' },
  { value: 'txt', label: 'TXT', hint: '날짜·구역별 읽기용 글' },
  { value: 'csv', label: 'CSV', hint: 'Excel 에서 열기' },
];

export default function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [format, setFormat] = useState<ExportOptions['format']>('zip');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [includeNext, setIncludeNext] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const suggested = await exportService.defaultPath(format);
      const path = await save({ defaultPath: suggested, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
      if (!path) return;
      const done = await exportService.run({ format, from: from || null, to: to || null, includeNext }, path);
      setResult(done);
    } catch (failure) {
      setError(errorMessage(failure, '내보내지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth data-personal-memo-overlay="true" data-testid="export-dialog">
      <DialogTitle>내 메모 내보내기</DialogTitle>
      <DialogContent>
        <RadioGroup value={format} onChange={event => setFormat(event.target.value as ExportOptions['format'])}>
          {FORMATS.map(f => (
            <FormControlLabel
              key={f.value}
              value={f.value}
              control={<Radio size="small" />}
              label={
                <span>
                  <Typography component="span" sx={{ fontWeight: 700, fontSize: '0.9rem' }}>{f.label}</Typography>
                  <Typography component="span" sx={{ fontSize: '0.76rem', color: 'text.secondary', ml: 1 }}>{f.hint}</Typography>
                </span>
              }
            />
          ))}
        </RadioGroup>
        <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
          <TextField type="date" size="small" label="시작" value={from} onChange={e => setFrom(e.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField type="date" size="small" label="끝" value={to} onChange={e => setTo(e.target.value)} InputLabelProps={{ shrink: true }} />
        </Stack>
        <Typography sx={{ fontSize: '0.74rem', color: 'text.secondary', mt: 0.5 }}>비워 두면 처음부터 / 현재까지</Typography>
        <FormControlLabel
          sx={{ mt: 1 }}
          control={<Checkbox size="small" checked={includeNext} onChange={e => setIncludeNext(e.target.checked)} />}
          label={<Typography sx={{ fontSize: '0.88rem' }}>Next(날짜 미정) 포함</Typography>}
        />
        {result && (
          <Alert
            severity={result.imagesMissing ? 'warning' : 'success'}
            sx={{ mt: 1.5 }}
            action={<Button size="small" color="inherit" onClick={() => void storageService.openFolder('exports')}>폴더 열기</Button>}
          >
            메모 {result.memoCount}개{format === 'zip' ? ` · 이미지 ${result.imagesSaved}개` : ''}를 저장했습니다.
            {result.imagesMissing ? ` 이미지 ${result.imagesMissing}개는 파일이 없어 빠졌습니다.` : ''}
            <Typography sx={{ fontSize: '0.72rem', wordBreak: 'break-all', mt: 0.5 }}>{result.path}</Typography>
          </Alert>
        )}
        {error && <Alert severity="error" sx={{ mt: 1.5 }}>{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>닫기</Button>
        <Button variant="contained" onClick={() => void run()} disabled={busy}>
          {busy ? '만드는 중…' : '내보내기'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
