/**
 * PLAN-A global MUI theme.
 *
 * This is the highest-leverage layer: by defining component defaults here,
 * every Dialog / Drawer / Card / Button / Chip / Menu / Input across the app
 * inherits the shared design language without per-screen edits. Screen-level
 * `sx` / PaperProps still win, so existing custom styling is preserved.
 */
import { createTheme, alpha, darken, lighten } from '@mui/material/styles';
import { planAiColors, planAiShadows } from './tokens';
import {
  CustomThemeSettings,
  DEFAULT_CUSTOM_THEME,
  resolveRadius,
  resolveShadow,
} from './customTheme';

/**
 * 고급 설정(포인트색/둥글기/그림자)을 받아 MUI 테마를 생성하는 팩토리.
 * 이 테마가 Dialog / Drawer / Menu / Popover / Button / Input 의 기본값을 정의하므로,
 * 화면별 수정 없이 전역에 포인트색·둥글기·그림자가 반영된다. (배경색은 bgColor 가 담당)
 */
export function createPlanAiTheme(
  custom: Pick<CustomThemeSettings, 'accent' | 'radius' | 'shadow'> = DEFAULT_CUSTOM_THEME,
) {
  const accent = custom.accent || planAiColors.brand.primary;
  const base = resolveRadius(custom.radius);
  const r = {
    xs: Math.max(4, base - 6),
    sm: Math.max(4, base - 4),
    md: base,
    lg: base + 4,
    xl: base + 8,
  };
  const sh = resolveShadow(custom.shadow);
  // 메뉴/팝오버 등은 그림자가 'none' 이면 너무 평평해 보이므로 최소 그림자를 보장.
  const cardShadow = sh.card === 'none' ? planAiShadows.sm : sh.card;
  const focusRing = `0 0 0 4px ${alpha(accent, 0.16)}`;

  return createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: accent,
      light: lighten(accent, 0.3),
      dark: darken(accent, 0.15),
    },
    secondary: {
      main: planAiColors.status.purple,
    },
    background: {
      default: planAiColors.background.surfaceAlt,
      paper: planAiColors.background.surface,
    },
    text: {
      primary: planAiColors.text.primary,
      secondary: planAiColors.text.tertiary,
    },
    success: { main: planAiColors.status.success },
    warning: { main: planAiColors.status.warning },
    error: { main: planAiColors.status.danger },
    info: { main: planAiColors.status.info },
    divider: planAiColors.border.soft,
  },
  typography: {
    fontFamily:
      "'Inter', 'Pretendard', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    h4: { fontWeight: 800, letterSpacing: '-0.025em' },
    h5: { fontWeight: 700, letterSpacing: '-0.02em' },
    h6: { fontWeight: 700 },
  },
  shape: {
    borderRadius: r.md,
  },
  components: {
    // Honor reduced-motion globally + nicer scrollbars.
    MuiCssBaseline: {
      styleOverrides: {
        '@media (prefers-reduced-motion: reduce)': {
          '*, *::before, *::after': {
            animationDuration: '0.01ms !important',
            animationIterationCount: '1 !important',
            transitionDuration: '0.01ms !important',
            scrollBehavior: 'auto !important',
          },
        },
        '*::-webkit-scrollbar': { width: 10, height: 10 },
        '*::-webkit-scrollbar-thumb': {
          backgroundColor: 'rgba(15, 23, 42, 0.18)',
          borderRadius: 8,
          border: '2px solid transparent',
          backgroundClip: 'content-box',
        },
        '*::-webkit-scrollbar-thumb:hover': {
          backgroundColor: 'rgba(15, 23, 42, 0.30)',
        },
        '*::-webkit-scrollbar-track': { backgroundColor: 'transparent' },
      },
    },
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: { backgroundImage: 'none' },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 600,
          borderRadius: r.sm,
        },
        containedPrimary: {
          boxShadow: cardShadow,
          '&:hover': {
            backgroundColor: darken(accent, 0.12),
            boxShadow: cardShadow,
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 600, borderRadius: r.sm },
      },
    },
    MuiTextField: {
      defaultProps: { size: 'small' },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: r.md,
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderColor: accent,
            boxShadow: focusRing,
          },
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: r.xl,
          border: `1px solid ${planAiColors.border.soft}`,
          boxShadow: sh.elevated,
        },
      },
    },
    MuiBackdrop: {
      styleOverrides: {
        // softer, less heavy backdrop (not pure black)
        root: { backgroundColor: 'rgba(15, 23, 42, 0.36)' },
        invisible: { backgroundColor: 'transparent' },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paperAnchorRight: { boxShadow: sh.elevated },
        paperAnchorLeft: { boxShadow: sh.elevated },
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: {
          borderRadius: r.md,
          border: `1px solid ${planAiColors.border.soft}`,
          boxShadow: cardShadow,
        },
      },
    },
    MuiPopover: {
      styleOverrides: {
        paper: {
          borderRadius: r.md,
          boxShadow: cardShadow,
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.92)',
          fontSize: '0.72rem',
          fontWeight: 500,
          borderRadius: r.xs,
          padding: '6px 10px',
        },
        arrow: { color: 'rgba(15, 23, 42, 0.92)' },
      },
    },
  },
  });
}

/** 기본 테마(고급 설정 미적용). 정적으로 import 하던 기존 코드 호환용. */
export const planAiTheme = createPlanAiTheme(DEFAULT_CUSTOM_THEME);

export default planAiTheme;
