/**
 * PLAN-A Work 전역 MUI 테마(theme/planAiTheme.ts)를 그대로 쓴다 — 버튼·메뉴·Dialog·Tooltip 이 Web 과 같다.
 * 글꼴만 오프라인 번들(Inter Variable)을 앞에 둔다(Web 은 Google Fonts 를 읽는다 — Desktop 은 인터넷 없이 같은 글꼴).
 */
import { createTheme } from '@mui/material/styles';
import { planAiTheme } from '../vendor/plan-a-work/theme/planAiTheme';

export const appTheme = createTheme(planAiTheme, {
  typography: {
    fontFamily: "'Inter Variable', 'Inter', 'Pretendard', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Malgun Gothic', sans-serif",
  },
});
