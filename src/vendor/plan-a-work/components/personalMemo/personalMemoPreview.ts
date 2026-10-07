import type { MemoSection } from '../../api/personalMemos';

/** 칸 안 그룹 순서 — 날짜 상세의 메인/오전/오후와 같다. */
export const SECTION_ORDER: MemoSection[] = ['main', 'am', 'pm'];

/**
 * 주간 칸 미리보기에 **그룹별로 몇 개씩** 보일지 고른다(데이터·정렬은 건드리지 않는다).
 *
 * 전체 목록을 앞에서 자르면 메인에 메모가 몰린 날에 오전·오후가 통째로 사라진다.
 * 그래서 전체 개수(limit)는 그대로 두되:
 *   1) 내용이 있는 그룹마다 먼저 1개씩,
 *   2) 남는 자리는 메인 → 오전 → 오후 순으로 한 개씩 돌려 가며 더 준다(남은 항목이 없는
 *      그룹은 건너뛴다).
 * 각 그룹 안에서는 원래 순서의 앞에서부터 그 개수만큼 보인다.
 */
export function previewCounts(
  sizes: Record<MemoSection, number>,
  limit: number,
): Record<MemoSection, number> {
  const counts: Record<MemoSection, number> = { main: 0, am: 0, pm: 0 };
  let left = Math.max(0, limit);
  for (const section of SECTION_ORDER) {
    if (left > 0 && sizes[section] > 0) {
      counts[section] = 1;
      left -= 1;
    }
  }
  let added = true;
  while (left > 0 && added) {
    added = false;
    for (const section of SECTION_ORDER) {
      if (left > 0 && counts[section] < sizes[section]) {
        counts[section] += 1;
        left -= 1;
        added = true;
      }
    }
  }
  return counts;
}

/** 그룹별 목록에서 미리보기로 보일 부분만(각 그룹의 원래 순서 유지). */
export function pickSectionPreview<T>(
  groups: Record<MemoSection, T[]>,
  limit: number,
): Record<MemoSection, T[]> {
  const counts = previewCounts(
    { main: groups.main.length, am: groups.am.length, pm: groups.pm.length },
    limit,
  );
  return {
    main: groups.main.slice(0, counts.main),
    am: groups.am.slice(0, counts.am),
    pm: groups.pm.slice(0, counts.pm),
  };
}
