import { describe, expect, it } from 'vitest';
import { isNextKey, koreanWeekday, locationKey, locationLabel, parseLocationKey } from '../domain/location';
import { DEFAULT_LIST_ID } from '../domain/types';

describe('koreanWeekday', () => {
  it('요일 전체 이름 — 날짜를 붙이지 않는다', () => {
    expect(koreanWeekday('2026-11-02')).toBe('월요일');
    expect(koreanWeekday('2026-11-03')).toBe('화요일');
    expect(koreanWeekday('2026-11-05')).toBe('목요일');
    expect(koreanWeekday('2026-11-07')).toBe('토요일');
    expect(koreanWeekday('2026-11-08')).toBe('일요일');
    expect(koreanWeekday('2027-01-01')).toBe('금요일');
  });
});

describe('location keys (Web memoLocation 과 같은 모양)', () => {
  it('round-trips day and next keys', () => {
    expect(locationKey({ kind: 'day', date: '2026-10-07' })).toBe('2026-10-07');
    expect(locationKey({ kind: 'next', listId: null })).toBe('next');
    expect(locationKey({ kind: 'next', listId: DEFAULT_LIST_ID })).toBe('next');
    expect(locationKey({ kind: 'next', listId: 'abc' })).toBe('next:abc');
    expect(parseLocationKey('next:abc')).toEqual({ kind: 'next', listId: 'abc' });
    expect(parseLocationKey('next')).toEqual({ kind: 'next', listId: null });
    expect(parseLocationKey('2026-10-07')).toEqual({ kind: 'day', date: '2026-10-07' });
    expect(isNextKey('next:abc')).toBe(true);
    expect(isNextKey('2026-10-07')).toBe(false);
  });

  it('labels', () => {
    expect(locationLabel({ kind: 'day', date: '2026-10-07' })).toBe('수 10/7');
    expect(locationLabel({ kind: 'next', listId: 'x' }, '앱 개발')).toBe('Next > 앱 개발');
  });
});
