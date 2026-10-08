/**
 * PLAN-A Work 전역 MUI 테마(theme/planAiTheme.ts)를 바탕으로 쓴다 — 버튼·메뉴·Dialog·Tooltip 의 구조는 Web 과 같다.
 * 글꼴만 오프라인 번들(Inter Variable)을 앞에 둔다(Web 은 Google Fonts 를 읽는다 — Desktop 은 인터넷 없이 같은 글꼴).
 *
 * 그 위에 Desktop 창에 맞는 표면만 조금 다듬는다(새 디자인 시스템이 아니라 기본값 보정):
 *   · 테두리는 얇은 반투명 선, 모서리는 덜 둥글게, 그림자는 아주 약하게(메모 칸과 같은 톤)
 *   · 보조 버튼(outlined)은 파란 테두리 대신 흰 바탕 + 중성 선 — Windows 기본 버튼처럼. 강조는 contained 하나만 파랑
 *   · 아이콘 버튼·메뉴 항목은 둥근 사각형 hover(원형 대신) — Windows 11 앱과 같은 느낌
 */
import { createTheme } from '@mui/material/styles';
import { planAiTheme } from '../vendor/plan-a-work/theme/planAiTheme';

const LINE = 'rgba(28, 25, 23, 0.08)';
const LINE_STRONG = 'rgba(28, 25, 23, 0.15)';
const HOVER_WASH = '#F5F4F1';
const FLOAT_SHADOW = '0 10px 28px -6px rgba(15, 23, 42, 0.14), 0 2px 6px rgba(15, 23, 42, 0.05)';

export const appTheme = createTheme(planAiTheme, {
  typography: {
    fontFamily: "'Inter Variable', 'Inter', 'Pretendard', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Malgun Gothic', sans-serif",
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: { borderRadius: 8, fontWeight: 600, letterSpacing: 0 },
        sizeSmall: { fontSize: '0.8rem', padding: '4px 12px' },
        outlinedPrimary: {
          color: '#1F2937',
          backgroundColor: '#FFFFFF',
          borderColor: LINE_STRONG,
          boxShadow: '0 1px 1px rgba(28, 25, 23, 0.03)',
          '&:hover': { backgroundColor: HOVER_WASH, borderColor: 'rgba(28, 25, 23, 0.22)' },
        },
        outlinedSizeSmall: { padding: '3px 11px' },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: { borderRadius: 8 },
      },
    },
    MuiDialog: {
      styleOverrides: {
        root: { '& .MuiBackdrop-root:not(.MuiBackdrop-invisible)': { backdropFilter: 'blur(2px)' } },
        paper: {
          borderRadius: 14,
          border: `1px solid ${LINE}`,
          boxShadow: '0 24px 64px -16px rgba(15, 23, 42, 0.24), 0 4px 12px rgba(15, 23, 42, 0.06)',
        },
      },
    },
    MuiDialogTitle: {
      styleOverrides: {
        root: { padding: '20px 24px 12px', fontSize: '1.05rem', fontWeight: 700, letterSpacing: '-0.01em' },
      },
    },
    MuiDialogActions: {
      styleOverrides: {
        root: { padding: '12px 20px 16px', gap: 4 },
      },
    },
    MuiBackdrop: {
      styleOverrides: {
        root: { backgroundColor: 'rgba(15, 23, 42, 0.26)' },
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: { borderRadius: 10, border: `1px solid ${LINE}`, boxShadow: FLOAT_SHADOW },
        list: { padding: 4 },
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: { borderRadius: 6, fontSize: '0.875rem' },
      },
    },
    MuiPopover: {
      styleOverrides: {
        paper: { borderRadius: 10, boxShadow: FLOAT_SHADOW },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: { borderRadius: 8 },
        notchedOutline: { borderColor: LINE_STRONG },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: 10, alignItems: 'center', fontSize: '0.84rem' },
      },
    },
    MuiDivider: {
      styleOverrides: {
        root: { borderColor: LINE },
      },
    },
  },
});
