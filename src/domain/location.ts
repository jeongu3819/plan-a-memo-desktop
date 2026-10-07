import type { Location } from './types';
import { DEFAULT_LIST_ID } from './types';
import { dayLabel } from '../vendor/plan-a-work/utils/personalMemoDates';

/**
 * 화면 전환용 key — Web memoLocation 과 같은 모양.
 *   'YYYY-MM-DD' = 날짜 상세 · 'next' = 기본 Next · 'next:<listId>' = 주제별 List
 */
export const NEXT_KEY = 'next';

export function locationKey(location: Location): string {
  if (location.kind === 'day') return location.date;
  return location.listId && location.listId !== DEFAULT_LIST_ID ? `${NEXT_KEY}:${location.listId}` : NEXT_KEY;
}

export function parseLocationKey(key: string): Location {
  if (key === NEXT_KEY) return { kind: 'next', listId: null };
  if (key.startsWith(`${NEXT_KEY}:`)) return { kind: 'next', listId: key.slice(NEXT_KEY.length + 1) || null };
  return { kind: 'day', date: key };
}

export function isNextKey(key: string | null | undefined): boolean {
  return !!key && (key === NEXT_KEY || key.startsWith(`${NEXT_KEY}:`));
}

export function sameLocation(a: Location, b: Location): boolean {
  return locationKey(a) === locationKey(b);
}

/** '수 10/7' · 'Next' · 'Next > 앱 개발' */
export function locationLabel(location: Location, listName?: string | null): string {
  if (location.kind === 'day') return dayLabel(location.date);
  return listName && location.listId && location.listId !== DEFAULT_LIST_ID ? `Next > ${listName}` : 'Next';
}

/** '10월 8일' */
export function koreanMonthDay(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${m}월 ${d}일`;
}
