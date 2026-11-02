/**
 * List 탭의 줄 계산 — 탭은 자동 줄바꿈되고, 접혀 있으면 앞의 두 줄만 보인다.
 * 화면 폭에 따라 달라지므로 실제 배치(offsetTop)를 읽어 몇 개가 가려졌는지 센다.
 */
export const LIST_TAB_HEIGHT = 32;
export const LIST_TAB_GAP = 6;
export const LIST_VISIBLE_ROWS = 2;

/** 접혔을 때 탭 영역의 높이(줄 수만큼의 탭 + 줄 사이 간격). */
export const LIST_COLLAPSED_HEIGHT = LIST_VISIBLE_ROWS * LIST_TAB_HEIGHT + (LIST_VISIBLE_ROWS - 1) * LIST_TAB_GAP;

/** 탭들의 offsetTop 에서 접혔을 때 가려지는 탭의 위치(인덱스)를 구한다. */
export function hiddenTabIndexes(offsetTops: number[]): number[] {
  if (!offsetTops.length) return [];
  const rows = Array.from(new Set(offsetTops)).sort((a, b) => a - b);
  const firstHidden = rows[LIST_VISIBLE_ROWS];
  if (firstHidden === undefined) return [];
  return offsetTops.flatMap((top, index) => (top >= firstHidden ? [index] : []));
}
