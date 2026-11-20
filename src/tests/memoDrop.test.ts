import { describe, expect, it } from 'vitest';
import { applyReorder, insertIndex, isFirstInSection, isLastInSection, planDrop, planEdge } from '../domain/memoDrop';
import type { MemoItem } from '../domain/types';

const MIDS = [100, 200, 300];

describe('맨 위로 보내기', () => {
  const row = (id: string, section: MemoItem['section']) => ({ id, section }) as MemoItem;
  it('구역마다 맨 위를 따로 본다', () => {
    const items = [row('a', 'main'), row('b', 'main'), row('c', 'am'), row('d', 'pm')];
    expect(items.filter(item => isFirstInSection(items, item)).map(item => item.id)).toEqual(['a', 'c', 'd']);
  });
  it('끌어 놓기와 같은 계산 — 여러 번 보내도 항목이 빠지거나 겹치지 않고, 이미 맨 위면 저장하지 않는다', () => {
    let ids = ['a', 'b', 'c', 'd'];
    for (const id of ['d', 'b', 'c', 'a', 'a', 'd']) {
      ids = planDrop(ids, id, 0) ?? ids;
      expect(ids[0]).toBe(id);
      expect([...ids].sort()).toEqual(['a', 'b', 'c', 'd']);
    }
    expect(ids).toEqual(['d', 'a', 'c', 'b']);
    expect(planDrop(ids, 'd', 0)).toBeNull();
  });
});

describe('맨 아래로 보내기', () => {
  const row = (id: string, section: MemoItem['section']) => ({ id, section }) as MemoItem;
  it('구역마다 맨 아래를 따로 본다 — 한 개뿐이면 맨 위이자 맨 아래', () => {
    const items = [row('a', 'main'), row('b', 'main'), row('c', 'am'), row('d', 'pm'), row('e', 'pm')];
    expect(items.filter(item => isLastInSection(items, item)).map(item => item.id)).toEqual(['b', 'c', 'e']);
    expect(isFirstInSection(items, items[2]) && isLastInSection(items, items[2])).toBe(true);
  });
  it('A·B·C·D 에서 B 를 보내면 A·C·D·B', () => {
    expect(planEdge(['a', 'b', 'c', 'd'], 'b', 'bottom')).toEqual(['a', 'c', 'd', 'b']);
  });
  it('이미 맨 아래·한 개뿐·그 구역에 없는 항목은 저장하지 않는다', () => {
    expect(planEdge(['a', 'b'], 'b', 'bottom')).toBeNull();
    expect(planEdge(['a'], 'a', 'bottom')).toBeNull();
    expect(planEdge(['a'], 'a', 'top')).toBeNull();
    expect(planEdge(['a', 'b'], 'x', 'bottom')).toBeNull();
    expect(planEdge(['a', 'b'], 'x', 'top')).toBeNull();
  });
  it('맨 위 ↔ 맨 아래를 반복해도 항목이 빠지거나 겹치지 않는다', () => {
    let ids = ['a', 'b', 'c', 'd'];
    const steps: [string, 'top' | 'bottom'][] = [['a', 'bottom'], ['d', 'top'], ['c', 'bottom'], ['c', 'top'], ['b', 'bottom'], ['b', 'bottom']];
    for (let round = 0; round < 20; round += 1) {
      for (const [id, edge] of steps) {
        ids = planEdge(ids, id, edge) ?? ids;
        expect(ids[edge === 'top' ? 0 : ids.length - 1]).toBe(id);
        expect([...ids].sort()).toEqual(['a', 'b', 'c', 'd']);
      }
    }
  });
  it('맨 위로 보내기는 예전 계산(끌어 놓기 틈 0)과 같다', () => {
    for (const id of ['a', 'b', 'c', 'd']) expect(planEdge(['a', 'b', 'c', 'd'], id, 'top')).toEqual(planDrop(['a', 'b', 'c', 'd'], id, 0));
  });
});

describe('insertIndex', () => {
  it('처음에는 가운데선 기준', () => {
    expect(insertIndex(MIDS, 50, null)).toBe(0);
    expect(insertIndex(MIDS, 150, null)).toBe(1);
    expect(insertIndex(MIDS, 250, null)).toBe(2);
    expect(insertIndex(MIDS, 350, null)).toBe(3);
  });
  it('가운데선 근처의 작은 흔들림으로는 바뀌지 않는다', () => {
    let current = insertIndex(MIDS, 150, null);
    for (const y of [195, 203, 197, 207, 193, 200, 205]) {
      current = insertIndex(MIDS, y, current);
      expect(current).toBe(1);
    }
    expect(insertIndex(MIDS, 209, 1)).toBe(2);
    // 넘어간 뒤에도 같은 폭만큼 버틴다(왔다 갔다 하지 않는다).
    expect(insertIndex(MIDS, 195, 2)).toBe(2);
    expect(insertIndex(MIDS, 191, 2)).toBe(1);
  });
  it('빠르게 움직이면 여러 칸을 한 번에 간다', () => {
    expect(insertIndex(MIDS, 400, 0)).toBe(3);
    expect(insertIndex(MIDS, 10, 3)).toBe(0);
  });
  it('메모가 없는 구역', () => {
    expect(insertIndex([], 100, null)).toBe(0);
    expect(insertIndex([], 100, 3)).toBe(0);
  });
});

describe('planDrop', () => {
  const IDS = ['a', 'b', 'c', 'd'];
  it('같은 구역 — 두 메모 사이·맨 위·맨 아래', () => {
    expect(planDrop(IDS, 'a', 2)).toEqual(['b', 'a', 'c', 'd']);
    expect(planDrop(IDS, 'd', 2)).toEqual(['a', 'b', 'd', 'c']);
    expect(planDrop(IDS, 'c', 0)).toEqual(['c', 'a', 'b', 'd']);
    expect(planDrop(IDS, 'b', 4)).toEqual(['a', 'c', 'd', 'b']);
  });
  it('제자리에 놓으면 저장하지 않는다', () => {
    expect(planDrop(IDS, 'b', 1)).toBeNull();
    expect(planDrop(IDS, 'b', 2)).toBeNull();
    expect(planDrop(IDS, 'a', 0)).toBeNull();
    expect(planDrop(IDS, 'd', 4)).toBeNull();
  });
  it('다른 구역에서 끌어온 메모', () => {
    expect(planDrop(IDS, 'x', 1)).toEqual(['a', 'x', 'b', 'c', 'd']);
    expect(planDrop(IDS, 'x', 4)).toEqual(['a', 'b', 'c', 'd', 'x']);
    expect(planDrop([], 'x', 0)).toEqual(['x']);
  });
});

describe('applyReorder', () => {
  const item = (id: string, section: MemoItem['section'], sortOrder: number) => ({ id, section, sortOrder }) as MemoItem;
  it('화면 순서가 저장 결과와 같다', () => {
    const items = [item('m', 'main', 0), item('a', 'am', 0), item('b', 'am', 1), item('p', 'pm', 0)];
    expect(applyReorder(items, 'am', ['b', 'a']).map(i => i.id)).toEqual(['m', 'b', 'a', 'p']);
  });
  it('구역을 옮긴 메모는 새 구역으로', () => {
    const items = [item('m', 'main', 0), item('a', 'am', 0), item('p', 'pm', 0)];
    const next = applyReorder(items, 'pm', ['a', 'p']);
    expect(next.map(i => i.id)).toEqual(['m', 'a', 'p']);
    expect(next[1].section).toBe('pm');
  });
});
