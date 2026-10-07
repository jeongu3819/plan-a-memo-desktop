/**
 * PLAN-A design tokens.
 *
 * Single source of truth for color / shadow / radius across the app.
 * Goal: replace scattered hard-coded hex values with semantic tokens so the
 * whole platform shares one design language ("있어 보이는" 업무 플랫폼).
 *
 * NOTE: The user-selectable background palette (BG_PALETTE) and the adaptive
 * sidebar derivation in `utils/colorUtils.ts` are intentionally kept — these
 * tokens sit *on top* of that system (surface / card / dialog / text / border).
 */

// ── Semantic color tokens ──────────────────────────────────────────────
export const planAiColors = {
  background: {
    /** main app canvas — used as a fallback; live value comes from bgColor */
    app: '#EFF3EC',
    appSoft: '#F7FAF7',
    /** elevated white surfaces (cards, dialogs, drawers) */
    surface: '#FFFFFF',
    /** subtle alternate surface (kanban columns, table headers, insets) */
    surfaceAlt: '#F8FAFC',
    /** hover wash on light surfaces */
    surfaceHover: '#EEF5EF',
    elevated: '#FFFFFF',
  },

  brand: {
    primary: '#2563EB',
    primaryHover: '#1D4ED8',
    primarySoft: '#EEF2FF',
    primaryBorder: '#C7D2FE',
  },

  status: {
    success: '#16A34A',
    successSoft: '#DCFCE7',
    warning: '#F59E0B',
    warningSoft: '#FEF3C7',
    danger: '#EF4444',
    dangerSoft: '#FEE2E2',
    info: '#06B6D4',
    infoSoft: '#CFFAFE',
    purple: '#8B5CF6',
    purpleSoft: '#F3E8FF',
  },

  text: {
    primary: '#0F172A',
    secondary: '#334155',
    tertiary: '#64748B',
    muted: '#94A3B8',
    disabled: '#CBD5E1',
    inverse: '#FFFFFF',
  },

  border: {
    soft: '#E5E7EB',
    normal: '#D1D5DB',
    strong: '#CBD5E1',
    focus: '#2563EB',
  },

  /** sidebar fallbacks — actual sidebar colors are derived from bgColor */
  sidebar: {
    bg: '#2F5B3F',
    hover: 'rgba(255,255,255,0.10)',
    active: 'rgba(255,255,255,0.14)',
    text: '#FFFFFF',
    muted: 'rgba(255,255,255,0.65)',
    border: 'rgba(255,255,255,0.14)',
  },
} as const;

// ── Elevation / shadow scale ───────────────────────────────────────────
// Soft, neutral-blue-tinted shadows. Never harsh/black.
export const planAiShadows = {
  none: 'none',
  sm: '0 1px 2px rgba(15, 23, 42, 0.06)',
  md: '0 4px 14px rgba(15, 23, 42, 0.08)',
  lg: '0 12px 32px rgba(15, 23, 42, 0.10)',
  xl: '0 20px 48px rgba(15, 23, 42, 0.12)',
  focus: '0 0 0 4px rgba(37, 99, 235, 0.14)',
} as const;

// ── Surface treatments ─────────────────────────────────────────────────
/**
 * 패널 상단 바 — 단순 "회색 헤더"가 아니라 정돈된 실버 톤 바.
 *
 * 설계 기준:
 *  - 위→아래 명도 차이 약 4%(#FCFCFD → #F1F2F4)뿐 — 그라데이션임을 의식하지 못할 정도.
 *  - 쿨그레이지만 푸른기는 억제한다. 기존 surfaceAlt(#F8FAFC)는 B−R=4 의 slate 계열이고,
 *    여기서는 상단을 거의 중성(B−R=1)으로, 하단을 B−R=3 으로 낮춰 실버 쪽으로 당긴다.
 *  - 유광/크롬/메탈릭 흉내, 반짝임, 강한 입체감은 쓰지 않는다.
 *  - 깊이감은 상단 모서리에 걸리는 아주 약한 하이라이트 하나로만 준다.
 *
 * 같은 시스템처럼 보여야 하는 헤더들(Task Details / Comments)은 반드시 이 토큰을 함께 쓴다.
 */
export const planAiSilverBar = {
  background: 'linear-gradient(180deg, #FCFCFD 0%, #F1F2F4 100%)',
  /** 기존 border.soft(#E5E7EB)보다 한 단계 정돈된 얇은 라인. 세로 seam 도 같은 값을 쓴다. */
  borderColor: '#E2E4E7',
  /** 상단 모서리 catch-light — 거의 보이지 않지만 가장자리를 또렷하게 만든다. */
  innerHighlight: 'inset 0 1px 0 rgba(255, 255, 255, 0.9)',
} as const;

/**
 * 카드 accent — 목록에서 카드끼리 구분하고 "어디 소속인가"를 색으로 거들기 위한 톤.
 *
 * 상태색(planAiColors.status)과 **섞어 쓰지 않는다.** 저쪽은 의미가 고정돼 있어서
 * (초록=성공, 빨강=위험) 소속을 나타내는 데 쓰면 없는 뜻이 생긴다. 여기 색은
 * 의미가 없고 구분만 한다.
 *
 * 각 항목은 두 값으로 끝난다:
 *   · `bar`  — 채도가 있는 쪽. 상단 얇은 선에 쓰고, pill 의 배경/테두리는 이 색을
 *              alpha 로 깔아 만든다(고정 tint 를 두면 어두운 테마에서 혼자 튄다).
 *   · `text` — 밝은 테마에서 그 tint 위에 올라가는 글자색(700 계열 → 대비 4.5:1 이상).
 *              어두운 테마에서는 `bar` 를 글자색으로 쓴다.
 *
 * ⚠️ **배열 순서에 뜻이 있다.** 이웃한 항목끼리 색상환에서 최소 75° 떨어지도록 섞어
 *    놓았다. 슬롯은 대체로 연달아 배정되므로, 배열을 색상환 순서(빨강→주황→노랑…)로
 *    두면 나란히 놓인 두 프로젝트가 비슷한 색을 받아 구분이 안 된다.
 *
 * 색은 **보조**다. 색이 안 보여도 제목/경로 텍스트만으로 정보가 전달되어야 한다.
 * 그래서 `rose` 는 오류의 빨강이 아니라 부드러운 산호색이고, `green` 도 완료를
 * 뜻하지 않는다 — 상태색(planAiColors.status)과 섞어 쓰지 않는 이유와 같다.
 */
export const planAiCardAccents = [
  { key: 'sky',     bar: '#38BDF8', text: '#0369A1' },  // 199°
  { key: 'rose',    bar: '#FB7185', text: '#BE123C' },  // 353°
  { key: 'lime',    bar: '#A3C64C', text: '#4D7C0F' },  //  80°
  { key: 'violet',  bar: '#A78BFA', text: '#6D28D9' },  // 265°
  { key: 'teal',    bar: '#2DD4BF', text: '#0F766E' },  // 174°
  { key: 'amber',   bar: '#FBBF24', text: '#B45309' },  //  45°
  { key: 'fuchsia', bar: '#E879F9', text: '#A21CAF' },  // 292°
  { key: 'green',   bar: '#4ADE80', text: '#15803D' },  // 142°
  { key: 'blue',    bar: '#60A5FA', text: '#1D4ED8' },  // 217°
  { key: 'orange',  bar: '#FB923C', text: '#C2410C' },  //  25°
  { key: 'indigo',  bar: '#818CF8', text: '#4338CA' },  // 245°
  { key: 'pink',    bar: '#F472B6', text: '#BE185D' },  // 330°
] as const;

export type PlanAiCardAccent = (typeof planAiCardAccents)[number];

// ── Border radius scale ────────────────────────────────────────────────
export const planAiRadius = {
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

// ── Motion ─────────────────────────────────────────────────────────────
export const planAiMotion = {
  fast: '120ms cubic-bezier(0.4, 0, 0.2, 1)',
  base: '180ms cubic-bezier(0.4, 0, 0.2, 1)',
  slow: '240ms cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

export type PlanAiColors = typeof planAiColors;
export type PlanAiStatus = keyof typeof planAiColors.status;
