/**
 * 창 제목 표시줄 — Windows 기본 제목 표시줄(decorations) 대신 앱 바탕과 이어지는 얇은 머리 줄.
 *
 *   [아이콘] PLAN-A Memo ·························· ─  ☐  ✕
 *
 * · 빈 곳·제목을 끌면 창 이동(Windows 이동 루프 그대로 — 화면 가장자리 스냅·위로 끌어 Snap 바 포함),
 *   두 번 누르면 최대화 ↔ 복원(`data-tauri-drag-region="deep"` — Tauri drag 스크립트).
 * · 우클릭은 Windows 시스템 메뉴(이전 크기로·이동·크기 조정·최소화·최대화·닫기) — WebView 메뉴 대신.
 * · 크기 조절·최대화 시 작업 표시줄 피하기·창 그림자는 tao 가 맡는다(decorations: false + shadow).
 * · 버튼 모양·색은 Windows 11 캡션 버튼과 같다(46×32, 시스템 아이콘 글꼴, 닫기 hover 빨강).
 * · 창이 비활성일 때는 제목·아이콘을 옅게(Windows 기본 제목 표시줄과 같다).
 */
import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import appIcon from '../../assets/app-icon.svg';
import { MEMO_SURFACE } from '../vendor/plan-a-work/components/personalMemo/personalMemoTheme';

export const TITLE_BAR_HEIGHT = 32;

/** Windows 캡션 버튼 글리프(Segoe Fluent Icons · Windows 10 은 Segoe MDL2 Assets — 같은 코드). */
const GLYPH = { minimize: '', maximize: '', restore: '', close: '' } as const;
const GLYPH_FONT = "'Segoe Fluent Icons', 'Segoe MDL2 Assets'";
const TITLE_FONT = "'Segoe UI Variable Text', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif";

const INK = '#1F1F1F';
const INK_INACTIVE = 'rgba(31, 31, 31, 0.42)';

function CaptionButton({ glyph, label, close, active, onClick }: { glyph: string; label: string; close?: boolean; active: boolean; onClick: () => void }) {
  return (
    <Box
      component="button"
      type="button"
      tabIndex={-1}
      title={label}
      aria-label={label}
      onClick={onClick}
      sx={{
        width: 46,
        height: TITLE_BAR_HEIGHT,
        p: 0,
        border: 0,
        outline: 0,
        borderRadius: 0,
        bgcolor: 'transparent',
        color: active ? INK : INK_INACTIVE,
        fontFamily: GLYPH_FONT,
        fontSize: 10,
        lineHeight: 1,
        cursor: 'default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'background-color 83ms linear, color 83ms linear',
        '&:hover': close ? { bgcolor: '#C42B1C', color: '#FFFFFF' } : { bgcolor: 'rgba(0, 0, 0, 0.06)', color: INK },
        '&:active': close ? { bgcolor: 'rgba(196, 43, 28, 0.9)', color: 'rgba(255, 255, 255, 0.7)' } : { bgcolor: 'rgba(0, 0, 0, 0.04)', color: 'rgba(31, 31, 31, 0.6)' },
      }}
    >
      {glyph}
    </Box>
  );
}

export default function TitleBar() {
  const [title, setTitle] = useState('PLAN-A Memo');
  const [maximized, setMaximized] = useState(false);
  const [active, setActive] = useState(() => document.hasFocus());

  useEffect(() => {
    const win = getCurrentWindow();
    let alive = true;
    const syncMaximized = () => void win.isMaximized().then(value => alive && setMaximized(value));
    void win.title().then(value => alive && value && setTitle(value));
    syncMaximized();
    const unlisten = win.onResized(syncMaximized);
    // 창 활성 여부는 WebView 포커스로 본다 — Windows 에서 win.isFocused() 는 포커스가 WebView(자식 창)에 있으면 false 다.
    const onFocus = () => setActive(true);
    const onBlur = () => setActive(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      alive = false;
      void unlisten.then(fn => fn());
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const win = getCurrentWindow();
  return (
    <Box
      component="header"
      data-testid="window-title-bar"
      data-tauri-drag-region="deep"
      onContextMenu={event => {
        event.preventDefault();
        void invoke('window_system_menu');
      }}
      sx={{
        height: TITLE_BAR_HEIGHT,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        bgcolor: MEMO_SURFACE,
        userSelect: 'none',
        WebkitUserSelect: 'none',
        cursor: 'default',
        position: 'relative',
        zIndex: theme => theme.zIndex.appBar,
      }}
    >
      <Box
        component="img"
        src={appIcon}
        alt=""
        draggable={false}
        sx={{ width: 16, height: 16, ml: 1.5, mr: 1.25, flexShrink: 0, opacity: active ? 1 : 0.55, transition: 'opacity 83ms linear' }}
      />
      <Box
        component="span"
        sx={{
          flex: 1,
          minWidth: 0,
          fontFamily: TITLE_FONT,
          fontSize: 12,
          lineHeight: `${TITLE_BAR_HEIGHT}px`,
          color: active ? INK : INK_INACTIVE,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          transition: 'color 83ms linear',
        }}
      >
        {title}
      </Box>
      <Box sx={{ display: 'flex', alignSelf: 'stretch', flexShrink: 0 }}>
        <CaptionButton glyph={GLYPH.minimize} label="최소화" active={active} onClick={() => void win.minimize()} />
        <CaptionButton
          glyph={maximized ? GLYPH.restore : GLYPH.maximize}
          label={maximized ? '이전 크기로 복원' : '최대화'}
          active={active}
          onClick={() => void win.toggleMaximize()}
        />
        <CaptionButton glyph={GLYPH.close} label="닫기" close active={active} onClick={() => void win.close()} />
      </Box>
    </Box>
  );
}
