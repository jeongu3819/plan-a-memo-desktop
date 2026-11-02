import { describe, expect, it } from 'vitest';
import { hiddenTabIndexes } from '../features/next/listTabRows';

describe('hiddenTabIndexes', () => {
  it('두 줄까지는 가리지 않는다', () => {
    expect(hiddenTabIndexes([])).toEqual([]);
    expect(hiddenTabIndexes([0, 0, 0])).toEqual([]);
    expect(hiddenTabIndexes([0, 0, 38, 38])).toEqual([]);
  });
  it('세 번째 줄부터 가린다', () => {
    expect(hiddenTabIndexes([0, 0, 38, 38, 76, 76, 114])).toEqual([4, 5, 6]);
  });
});
