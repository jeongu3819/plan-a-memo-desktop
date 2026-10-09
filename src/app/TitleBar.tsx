/**
 * 창 제목 표시줄 — Windows 기본 제목 표시줄(decorations) 대신 앱 바탕과 이어지는 얇은 머리 줄.
 *
 *   [P] PLAN-A Memo  Staging ······················ ─  ☐  ✕
 *
 * · 브랜드: PLAN-A Work 심볼(assets/brand/plan-a-symbol.png — 사용자 제공 'PLAN-A Work logo.png' 에서 P 심볼만
 *   잘라 투명 배경으로 만든 것, 색·형태 그대로) + 'PLAN-A'(굵게) 'Memo'(보통) — 로고의 'PLAN-A Work' 와 같은 위계.
 *   실행 환경은 staging·development 에서만 작은 보조 글자로 붙인다(production 은 없음).
 * · 빈 곳·제목을 끌면 창 이동(Windows 이동 루프 그대로 — 화면 가장자리 스냅·위로 끌어 Snap 바 포함),
 *   두 번 누르면 최대화 ↔ 복원(`data-tauri-drag-region="deep"` — Tauri drag 스크립트).
 * · 우클릭은 Windows 시스템 메뉴(이전 크기로·이동·크기 조정·최소화·최대화·닫기) — WebView 메뉴 대신.
 * · 크기 조절·최대화 시 작업 표시줄 피하기·창 그림자는 tao 가 맡는다(decorations: false + shadow).
 * · 캡션 버튼은 Windows 11 과 같은 46px 폭·시스템 아이콘 글꼴(가는 선) — 평소에는 차분한 회색, hover 에서만 진하게,
 *   닫기는 hover 때만 Windows 빨강. 창이 비활성이면 제목·버튼을 옅게(Windows 기본 제목 표시줄과 같다).
 */
import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import brandSymbol from '../assets/brand/plan-a-symbol.png';
import { appService } from '../tauri/api';
import { MEMO_MUTED, MEMO_SURFACE } from '../vendor/plan-a-work/components/personalMemo/personalMemoTheme';

export const TITLE_BAR_HEIGHT = 36;

/** Windows 캡션 버튼 글리프(Segoe Fluent Icons · Windows 10 은 Segoe MDL2 Assets — 같은 코드). */
const GLYPH = {
  minimize: String.fromCharCode(0xe921),
  maximize: String.fromCharCode(0xe922),
  restore: String.fromCharCode(0xe923),
  close: String.fromCharCode(0xe8bb),
} as const;
const GLYPH_FONT = "'Segoe Fluent Icons', 'Segoe MDL2 Assets'";
const BRAND_FONT = "'Inter Variable', 'Inter', 'Segoe UI Variable Text', 'Segoe UI', 'Malgun Gothic', sans-serif";

/** 로고 글자색(남색에 가까운 검정) — 로고처럼 위계는 굵기로('PLAN-A' 굵게 · 'Memo' 보통), 'Memo' 는 아주 조금만 옅게. */
const BRAND_INK = '#14162B';
const BRAND_INK_SOFT = '#2B2E45';
const GLYPH_INK = '#3D4152';
const GLYPH_INK_HOVER = '#14162B';
const ENV_LABEL: Record<string, string | undefined> = { staging: 'Staging', development: 'Dev' };
const FADE = '120ms ease-out';

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
        color: GLYPH_INK,
        opacity: active ? 1 : 0.45,
        fontFamily: GLYPH_FONT,
        fontSize: 10,
        lineHeight: 1,
        cursor: 'default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: `background-color ${FADE}, color ${FADE}, opacity ${FADE}`,
        '&:hover': close
          ? { bgcolor: '#C42B1C', color: '#FFFFFF', opacity: 1 }
          : { bgcolor: 'rgba(28, 25, 23, 0.06)', color: GLYPH_INK_HOVER, opacity: 1 },
        '&:active': close
          ? { bgcolor: '#B3271A', color: 'rgba(255, 255, 255, 0.75)' }
          : { bgcolor: 'rgba(28, 25, 23, 0.035)', color: 'rgba(20, 22, 43, 0.6)' },
      }}
    >
      {glyph}
    </Box>
  );
}

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const [active, setActive] = useState(() => document.hasFocus());
  // App 과 같은 조회(캐시 공유) — 실행 환경은 Rust 쪽 설정이 기준이다.
  const info = useQuery({ queryKey: ['app', 'info'], queryFn: appService.info });
  const envLabel = info.data ? ENV_LABEL[info.data.env] : undefined;

  useEffect(() => {
    const win = getCurrentWindow();
    let alive = true;
    const syncMaximized = () => void win.isMaximized().then(value => alive && setMaximized(value));
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
        data-testid="window-title-brand"
        sx={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          pl: 1.75,
          opacity: active ? 1 : 0.5,
          transition: `opacity ${FADE}`,
        }}
      >
        <Box component="img" src={brandSymbol} alt="" draggable={false} sx={{ height: 20, width: 'auto', flexShrink: 0, display: 'block' }} />
        <Box
          component="span"
          sx={{
            minWidth: 0,
            fontFamily: BRAND_FONT,
            fontSize: 13,
            lineHeight: 1,
            letterSpacing: '-0.005em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          <Box component="span" sx={{ fontWeight: 750, color: BRAND_INK, letterSpacing: '0.005em' }}>PLAN-A</Box>{' '}
          <Box component="span" sx={{ fontWeight: 450, color: BRAND_INK_SOFT }}>Memo</Box>
        </Box>
        {envLabel && (
          <Box
            component="span"
            data-testid="window-title-env"
            sx={{
              flexShrink: 0,
              fontFamily: BRAND_FONT,
              fontSize: 10.5,
              fontWeight: 500,
              lineHeight: '16px',
              letterSpacing: '0.02em',
              color: MEMO_MUTED,
              bgcolor: 'rgba(28, 25, 23, 0.05)',
              borderRadius: '4px',
              px: 0.75,
              ml: 0.25,
            }}
          >
            {envLabel}
          </Box>
        )}
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
