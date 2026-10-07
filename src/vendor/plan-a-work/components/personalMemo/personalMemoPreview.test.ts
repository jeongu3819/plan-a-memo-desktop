import { describe, expect, it } from 'vitest';
import { pickSectionPreview, previewCounts } from './personalMemoPreview';

const sizes = (main: number, am: number, pm: number) => ({ main, am, pm });
const total = (c: { main: number; am: number; pm: number }) => c.main + c.am + c.pm;

describe('주간 칸 미리보기 — 5개 안에서 내용 있는 그룹을 모두 보인다', () => {
  it('메인 6 · 오전 2 · 오후 2 → 메인 2 · 오전 2 · 오후 1 (오전·오후가 사라지지 않는다)', () => {
    const counts = previewCounts(sizes(6, 2, 2), 5);
    expect(counts).toEqual({ main: 2, am: 2, pm: 1 });
    expect(total(counts)).toBe(5);
  });

  it('한 그룹에만 내용이 있으면 최대 5개를 그대로 보인다', () => {
    expect(previewCounts(sizes(8, 0, 0), 5)).toEqual({ main: 5, am: 0, pm: 0 });
    expect(previewCounts(sizes(0, 7, 0), 5)).toEqual({ main: 0, am: 5, pm: 0 });
    expect(previewCounts(sizes(0, 0, 3), 5)).toEqual({ main: 0, am: 0, pm: 3 });
  });

  it('남는 자리는 메인 → 오전 → 오후 순으로 한 개씩, 남은 항목이 없는 그룹은 건너뛴다', () => {
    expect(previewCounts(sizes(1, 6, 6), 5)).toEqual({ main: 1, am: 2, pm: 2 });
    expect(previewCounts(sizes(4, 1, 4), 5)).toEqual({ main: 2, am: 1, pm: 2 });
    expect(previewCounts(sizes(3, 0, 9), 5)).toEqual({ main: 3, am: 0, pm: 2 });
  });

  it('전체가 5개 이하면 전부 보인다', () => {
    expect(previewCounts(sizes(2, 1, 2), 5)).toEqual({ main: 2, am: 1, pm: 2 });
    expect(previewCounts(sizes(0, 0, 0), 5)).toEqual({ main: 0, am: 0, pm: 0 });
  });

  it('각 그룹 안의 원래 순서를 유지해 앞에서부터 고른다', () => {
    const picked = pickSectionPreview(
      { main: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'], am: ['a1', 'a2'], pm: ['p1', 'p2'] },
      5,
    );
    expect(picked).toEqual({ main: ['m1', 'm2'], am: ['a1', 'a2'], pm: ['p1'] });
  });
});
