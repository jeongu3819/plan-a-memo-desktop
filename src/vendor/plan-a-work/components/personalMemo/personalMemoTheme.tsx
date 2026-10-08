import { Box } from '@mui/material';
import { weekdayOf } from '../../utils/personalMemoDates';

/**
 * 개인 메모 화면의 색 — '관리 보드' 보다 '계속 쓰는 주간 노트' 에 가까운 톤.
 *
 * 창 바탕은 아주 밝은 웜 뉴트럴, 칸은 흰 바탕 + 거의 보이지 않는 경계. 색은 요일명·날짜
 * 글자와 작은 원형 배경에만 쓴다(칸 상단 라인·칸 전체 칠하기 없음). 오늘과 주말·다음에만
 * 구분하고, 요일마다 서로 다른 색을 쓰지 않는다.
 *
 * 이 값들은 메모 화면 전용이다 — 전역 테마(Card/Dialog/Typography)는 바꾸지 않는다.
 */
export const MEMO_SURFACE = '#F7F6F3';        // 창 바탕(아주 밝은 웜 뉴트럴) — 흰 칸이 진한 선 없이도 구분될 만큼만 낮춘다
export const MEMO_CARD = '#FFFFFF';
// [Desktop] 진한 선 대신 '얇은 반투명 선 + 아주 약한 그림자' 로 칸을 구분한다(바탕 위에 칸이 살짝 떠 보이게).
export const MEMO_CARD_BORDER = 'rgba(28, 25, 23, 0.07)';     // 구획은 보이되 글보다 먼저 보이지 않는 경계
export const MEMO_CARD_BORDER_HOVER = 'rgba(28, 25, 23, 0.13)';
export const MEMO_CARD_SHADOW = '0 1px 2px rgba(28, 25, 23, 0.04), 0 1px 3px rgba(28, 25, 23, 0.03)';
export const MEMO_CARD_SHADOW_HOVER = '0 2px 4px rgba(28, 25, 23, 0.04), 0 8px 20px rgba(28, 25, 23, 0.06)';
export const MEMO_WRITE_AREA = '#F6F5F2';      // 비어 있어도 '쓸 자리' 로 보이는 입력 바탕
export const MEMO_TEXT = '#273142';            // 본문
export const MEMO_MUTED = '#6B7280';           // 날짜·완료 개수·보조 문구(읽을 수 있는 대비)
export const MEMO_SECTION_TITLE = '#4B5563';   // 칸 안 구역 제목(메인/오전/오후) — 본문보다 작되 옅지 않게
export const MEMO_GROUP_DIVIDER = '#F1EFEA';   // 구역 사이 아주 약한 구분선
export const MEMO_RADIUS = '14px';             // [Desktop] 18px → 14px — 데스크톱 창에서 덜 둥글게(모바일 카드 느낌을 줄인다)
// 창 머리의 '노트 표지' — 날짜 제목은 가느다란 serif(시스템 글꼴만, 외부 폰트 없음)와 옅은 warm gray,
// 인사말은 같은 계열의 조금 더 진한 gray(작은 글자라 읽히는 대비를 지킨다).
export const MEMO_NOTE_SERIF = "Georgia, 'Times New Roman', Times, serif";
export const MEMO_NOTE_DATE = '#8E8A86';
export const MEMO_NOTE_GREETING = '#7D7872';

export type DayToneKind = 'weekday' | 'sat' | 'sun' | 'next';

export interface DayTone {
  kind: DayToneKind;
  /** 요일명·날짜 글자색 */
  text: string;
  /** 요일명 뒤 작은 원형 배경 / 끌어 놓기 중 칸 바탕 */
  soft: string;
}

const TONES: Record<DayToneKind, DayTone> = {
  weekday: { kind: 'weekday', text: MEMO_TEXT, soft: '#F3F1EC' },
  sat: { kind: 'sat', text: '#2563EB', soft: '#EEF4FF' },
  sun: { kind: 'sun', text: '#DC2626', soft: '#FDF0F0' },
  next: { kind: 'next', text: '#6D28D9', soft: '#F4F0FE' },
};

/** 'YYYY-MM-DD' 또는 'next' */
export function dayTone(key: string): DayTone {
  if (key === 'next') return TONES.next;
  const weekday = weekdayOf(key);
  if (weekday === 5) return TONES.sat;
  if (weekday === 6) return TONES.sun;
  return TONES.weekday;
}

/** 날짜 미정 목록의 화면 이름 — 데이터 키('next')·저장 구조는 그대로다(표시 문자열만). */
export const NEXT_LABEL = 'Next';

/** 오늘 날짜 표시 — 한눈에 들어오는 작은 pill. */
export function TodayBadge() {
  return (
    <Box
      component="span"
      data-testid="memo-today-badge"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        px: 0.9,
        height: 18,
        borderRadius: 999,
        bgcolor: 'primary.main',
        color: '#fff',
        fontSize: '0.64rem',
        fontWeight: 700,
        letterSpacing: '0.02em',
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      Today
    </Box>
  );
}
