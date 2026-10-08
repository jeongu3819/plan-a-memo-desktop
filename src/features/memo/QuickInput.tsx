/**
 * 새 메모 입력칸 — Web PersonalMemoQuickInput 과 같은 규칙.
 *   · Enter = 줄바꿈. 바깥을 누르거나 Esc·화면 전환 때 한 메모로 자동 저장. 연달아 쓸 때만 Ctrl+Enter.
 *   · 다른 창으로 잠깐 전환(Alt+Tab)한 것은 저장 시점이 아니다(한 글이 두 메모로 쪼개지지 않게).
 *   · 한글 조합 중 키 입력은 저장으로 처리하지 않는다. 빈 입력은 저장하지 않는다.
 *   · 저장이 실패하면 쓰던 글을 입력칸에 되돌려 둔다(조용히 버리지 않는다).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, InputBase, Typography } from '@mui/material';
import { MEMO_WRITE_AREA } from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import type { ItemSection, Location, MemoKind } from '../../domain/types';
import { usePersonalMemo } from './MemoProvider';

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const COMPOSER_HINT = 'Enter 줄바꿈 · Ctrl+Enter 저장 후 다음 · 바깥을 누르면 자동 저장';

export default function QuickInput({
  location,
  section,
  kind = 'checklist',
  placeholder = '메모를 적어보세요',
  autoFocus = false,
  minRows = 1,
  fill = false,
}: {
  location: Location;
  section: ItemSection;
  kind?: MemoKind;
  placeholder?: string;
  autoFocus?: boolean;
  minRows?: number;
  fill?: boolean;
}) {
  const { actions } = usePersonalMemo();
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const valueRef = useRef('');
  const composing = useRef(false);
  const target = useRef({ location, section, kind });
  target.current = { location, section, kind };

  const commit = useCallback(() => {
    const text = valueRef.current.replace(/^\s*\n/, '').replace(/\s+$/, '');
    valueRef.current = '';
    setValue('');
    if (!text.trim()) return;
    const { location: loc, section: sec, kind: k } = target.current;
    void actions.create(loc, sec, k, text.split('\n').map(escapeHtml).join('<br>')).then(created => {
      if (!created && !valueRef.current) {
        valueRef.current = text;
        setValue(text);
      }
    });
  }, [actions]);

  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(
    () => () => {
      if (valueRef.current.trim()) commitRef.current();
    },
    [],
  );

  return (
    <Box sx={fill ? { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 } : undefined}>
      <InputBase
        multiline
        minRows={minRows}
        value={value}
        onChange={event => {
          valueRef.current = event.target.value;
          setValue(event.target.value);
        }}
        placeholder={placeholder}
        autoFocus={autoFocus}
        inputProps={{ 'aria-label': placeholder, maxLength: 4000, 'data-testid': 'personal-memo-quick-input' }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (typeof document !== 'undefined' && !document.hasFocus()) return;
          commit();
        }}
        onKeyDown={event => {
          const isComposing = composing.current || event.nativeEvent.isComposing || event.keyCode === 229;
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            if (isComposing) return;
            event.preventDefault();
            commit();
            return;
          }
          if (event.key === 'Escape' && !isComposing) commit();
        }}
        sx={{
          width: '100%',
          ...(fill ? { flex: 1, alignItems: 'flex-start' } : {}),
          fontSize: '0.9rem',
          lineHeight: 1.6,
          px: 1.25,
          py: 1,
          borderRadius: '10px',
          bgcolor: focused ? '#FFFFFF' : MEMO_WRITE_AREA,
          border: '1px solid',
          borderColor: focused ? 'rgba(37, 99, 235, 0.45)' : 'transparent',
          boxShadow: focused ? '0 0 0 3px rgba(37, 99, 235, 0.08)' : 'none',
          transition: 'background-color 0.15s, border-color 0.15s, box-shadow 0.15s',
          '&:hover': { borderColor: focused ? 'rgba(37, 99, 235, 0.45)' : 'rgba(28, 25, 23, 0.10)' },
          '& textarea': { resize: 'none' },
          ...(fill ? { '& textarea:not([aria-hidden="true"])': { minHeight: '100%', boxSizing: 'border-box' } } : {}),
        }}
      />
      <Typography
        data-testid="personal-memo-composer-hint"
        aria-hidden={!focused}
        sx={{
          fontSize: '0.68rem', color: 'text.disabled', mt: 0.4, px: 0.5, visibility: focused ? 'visible' : 'hidden',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}
      >
        {COMPOSER_HINT}
      </Typography>
    </Box>
  );
}
