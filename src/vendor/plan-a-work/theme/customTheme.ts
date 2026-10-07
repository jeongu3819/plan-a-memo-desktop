/**
 * Custom Theme Builder 옵션 정의.
 *
 * 테마 프리셋(배경 한 번에 적용)에 더해, 사용자가 배경색 / 포인트색 / 둥글기 /
 * 그림자 강도를 개별 조정할 수 있게 하는 "고급 설정"의 선택지와 해석 헬퍼.
 * 업무 플랫폼 톤을 유지하기 위해 값들은 과하지 않게 둔다.
 */

export type ThemeRadius = 'compact' | 'default' | 'soft' | 'round';
export type ThemeShadow = 'flat' | 'subtle' | 'default' | 'depth';

export interface CustomThemeSettings {
  /** main content 배경색 (기존 bgColor 와 동기화) */
  background: string;
  /** 포인트색 — primary 버튼 / active / focus / 선택 표시 */
  accent: string;
  radius: ThemeRadius;
  shadow: ThemeShadow;
}

export const BACKGROUND_OPTIONS: { id: string; label: string; value: string }[] = [
  { id: 'sage', label: '세이지', value: '#EFF3EC' },
  { id: 'gray', label: '밝은 회색', value: '#F3F4F6' },
  { id: 'blue', label: '연한 파랑', value: '#EEF2FF' },
  { id: 'mint', label: '민트', value: '#ECFDF5' },
  { id: 'warm', label: '크림 노랑', value: '#FEF9C3' },
  { id: 'purple', label: '연보라', value: '#F3E8FF' },
];

export const ACCENT_OPTIONS: { id: string; label: string; value: string }[] = [
  { id: 'blue', label: '파랑', value: '#2563EB' },
  { id: 'green', label: '초록', value: '#16A34A' },
  { id: 'orange', label: '주황', value: '#F59E0B' },
  { id: 'red', label: '빨강', value: '#EF4444' },
  { id: 'cyan', label: '청록', value: '#06B6D4' },
  { id: 'purple', label: '보라', value: '#8B5CF6' },
];

/**
 * 색상 HEX → 사용자용 한국어 색상명.
 *
 * 테마 프리셋/색상 스와치 tooltip에 개발자용 HEX 대신 직관적인 색상명을
 * 보여주기 위한 표(키는 대문자 HEX). 테마 적용은 HEX value 를 그대로 쓰고,
 * 이 표는 "표시명"으로만 쓴다 — 색상을 추가/변경하는 표가 아니다.
 */
const COLOR_NAMES: Record<string, string> = {
  // 밝은 톤 (BG_PALETTE - Light + BACKGROUND_OPTIONS)
  '#EFF3EC': '세이지',
  '#F3F4F6': '밝은 회색',
  '#E5E5E5': '회색',
  '#EEF2FF': '연한 파랑',
  '#E0F2FE': '하늘색',
  '#ECFDF5': '민트',
  '#FEF9C3': '크림 노랑',
  '#FFF1F2': '연분홍',
  '#F3E8FF': '연보라',
  // 중간 톤 (BG_PALETTE - Muted)
  '#D8CFDC': '라일락 그레이',
  '#E7C9D1': '더스티 핑크',
  '#E8C097': '모래 베이지',
  '#E6D395': '머스터드 베이지',
  '#B7C9BB': '세이지 그린',
  '#9EBFD6': '청회색',
  '#B4C6D9': '연한 청회색',
  '#C7B8D4': '모브',
  // 어두운 톤 (BG_PALETTE - Dark)
  '#5C6F8E': '스틸 블루',
  '#6F647F': '회보라',
  '#6A4A3F': '고동색',
  '#195B4E': '짙은 청록',
  '#3B5998': '남색',
  '#4A4A4A': '진회색',
  // 포인트색 (ACCENT_OPTIONS)
  '#2563EB': '파랑',
  '#16A34A': '초록',
  '#F59E0B': '주황',
  '#EF4444': '빨강',
  '#06B6D4': '청록',
  '#8B5CF6': '보라',
};

/**
 * HEX 색상의 사용자용 한국어 색상명을 돌려준다.
 * 표에 없으면 깨지지 않도록 입력 HEX 를 그대로 돌려준다(최후 폴백).
 */
export const colorNameOf = (hex: string): string =>
  COLOR_NAMES[(hex || '').toUpperCase()] ?? hex;

export const RADIUS_OPTIONS: { id: ThemeRadius; label: string; value: number }[] = [
  { id: 'compact', label: '작게', value: 8 },
  { id: 'default', label: '기본', value: 12 },
  { id: 'soft', label: '크게', value: 16 },
  { id: 'round', label: '매우 둥글게', value: 22 },
];

export const SHADOW_OPTIONS: { id: ThemeShadow; label: string; card: string; elevated: string }[] = [
  { id: 'flat', label: '없음', card: 'none', elevated: '0 1px 2px rgba(15,23,42,0.04)' },
  { id: 'subtle', label: '약하게', card: '0 2px 8px rgba(15,23,42,0.06)', elevated: '0 8px 22px rgba(15,23,42,0.08)' },
  { id: 'default', label: '기본', card: '0 4px 14px rgba(15,23,42,0.08)', elevated: '0 12px 32px rgba(15,23,42,0.10)' },
  { id: 'depth', label: '입체감', card: '0 8px 22px rgba(15,23,42,0.10)', elevated: '0 18px 44px rgba(15,23,42,0.13)' },
];

export const DEFAULT_CUSTOM_THEME: CustomThemeSettings = {
  background: '#F3F4F6',
  accent: '#2563EB',
  radius: 'default',
  shadow: 'default',
};

/** 둥글기 옵션 → 기준 borderRadius(px). */
export function resolveRadius(r: ThemeRadius): number {
  return RADIUS_OPTIONS.find(o => o.id === r)?.value ?? 12;
}

/** 그림자 옵션 → {card, elevated} 문자열. */
export function resolveShadow(s: ThemeShadow): { card: string; elevated: string } {
  const found = SHADOW_OPTIONS.find(o => o.id === s) ?? SHADOW_OPTIONS[2];
  return { card: found.card, elevated: found.elevated };
}
