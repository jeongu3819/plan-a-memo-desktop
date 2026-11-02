/**
 * 메모 끌어 놓기의 계산 — 끄는 동안 메모는 제자리에 있고(화면이 밀리지 않는다) 삽입선만 움직인다.
 * 삽입 위치 = 그 구역 메모들 사이의 틈 번호(0 = 맨 위, n = 맨 아래). 메모의 **가운데**를 넘어야 다음 틈으로 가고,
 * 가운데 주변에 머무는 작은 흔들림으로는 바뀌지 않는다.
 */
import type { ItemSection, MemoItem } from './types';

/** 가운데선에서 이만큼 더 넘어야 삽입 위치가 바뀐다(px). */
export const DROP_DEAD_ZONE = 8;

export function insertIndex(midpoints: number[], y: number, current: number | null, deadZone = DROP_DEAD_ZONE): number {
  if (current === null) return midpoints.filter(mid => mid < y).length;
  let index = Math.min(current, midpoints.length);
  while (index < midpoints.length && y > midpoints[index] + deadZone) index += 1;
  while (index > 0 && y < midpoints[index - 1] - deadZone) index -= 1;
  return index;
}

/**
 * 놓았을 때 그 구역의 새 순서. 순서가 그대로면 null(저장하지 않는다).
 * index 는 끌고 있는 메모도 포함해 센 틈 번호다.
 */
export function planDrop(sectionIds: string[], activeId: string, index: number): string[] | null {
  const from = sectionIds.indexOf(activeId);
  const others = sectionIds.filter(id => id !== activeId);
  const at = from >= 0 && index > from ? index - 1 : index;
  if (from === at) return null;
  others.splice(Math.max(0, Math.min(at, others.length)), 0, activeId);
  return others;
}

const SECTION_RANK: Record<ItemSection, number> = { main: 0, am: 1, pm: 2, next: 3 };

/** 저장 결과를 기다리지 않고 화면에 먼저 반영할 항목 목록(Rust `reorder` 와 같은 결과). */
export function applyReorder(items: MemoItem[], section: ItemSection, ids: string[]): MemoItem[] {
  const order = new Map(ids.map((id, index) => [id, index]));
  return items
    .map(item => {
      const sortOrder = order.get(item.id);
      return sortOrder === undefined ? item : { ...item, section, sortOrder };
    })
    .sort((a, b) => SECTION_RANK[a.section] - SECTION_RANK[b.section] || a.sortOrder - b.sortOrder);
}
