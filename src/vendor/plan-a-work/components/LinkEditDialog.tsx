import React from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField } from '@mui/material';
import { normalizeLinkUrl } from '../utils/richLink';
import type { LinkDraft } from '../utils/richLinkDom';

/**
 * 링크 삽입 / 편집 Dialog — Description 과 작업노트가 공유한다.
 *
 * 표시 텍스트와 주소를 따로 받는 이유는 "네이버"처럼 보이는 링크를 만들 수 있어야
 * 하기 때문이다. 주소 유효성은 `normalizeLinkUrl` 하나로 판단하므로, 여기서 적용
 * 버튼이 살아 있으면 저장 후에도 링크가 살아 있다(프론트 검증과 저장 정책이 같다).
 */
interface Props {
    draft: LinkDraft | null;
    onChange: (next: LinkDraft | null) => void;
    /** 적용 — 호출부가 실제 DOM 삽입/갱신을 한다. */
    onApply: () => void;
    /** 편집 중일 때만 '링크 제거' 버튼을 보여 준다. */
    onRemove?: (anchor: HTMLAnchorElement) => void;
}

const LinkEditDialog: React.FC<Props> = ({ draft, onChange, onApply, onRemove }) => (
    <Dialog open={!!draft} onClose={() => onChange(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700, fontSize: '0.95rem' }}>
            {draft?.editing ? '링크 편집' : '링크 삽입'}
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: 1 }}>
            <TextField
                label="표시 텍스트"
                size="small"
                fullWidth
                value={draft?.text || ''}
                onChange={(e) => onChange(draft ? { ...draft, text: e.target.value } : draft)}
                placeholder="비워두면 주소가 그대로 보입니다"
                sx={{ mt: 0.5 }}
            />
            <TextField
                label="링크 주소"
                size="small"
                fullWidth
                autoFocus
                value={draft?.url || ''}
                onChange={(e) => onChange(draft ? { ...draft, url: e.target.value } : draft)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        onApply();
                    }
                }}
                placeholder="example.com · https://… · hong@example.com"
                helperText="http(s) 주소와 이메일만 저장됩니다."
            />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
            {draft?.editing && onRemove && (
                <Button
                    onClick={() => {
                        const anchor = draft.editing!;
                        onChange(null);
                        onRemove(anchor);
                    }}
                    sx={{ textTransform: 'none', color: '#DC2626', mr: 'auto' }}
                >
                    링크 제거
                </Button>
            )}
            <Button onClick={() => onChange(null)} sx={{ textTransform: 'none', color: '#6B7280' }}>
                취소
            </Button>
            <Button
                variant="contained"
                onClick={onApply}
                disabled={!normalizeLinkUrl(draft?.url)}
                sx={{ textTransform: 'none', fontWeight: 600, bgcolor: '#2955FF' }}
            >
                적용
            </Button>
        </DialogActions>
    </Dialog>
);

export default LinkEditDialog;
