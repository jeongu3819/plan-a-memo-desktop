import { describe, expect, it } from 'vitest';
import { monthLabel, parseDateQuery, weekLabel, weekRangeText } from '../domain/memoBrowse';

const TODAY = '2026-11-02'; // 월요일

describe('weekLabel', () => {
  it('보고 있는 주를 오늘 기준으로 이름 붙인다', () => {
    expect(weekLabel('2026-11-02', TODAY)).toBe('이번 주');
    expect(weekLabel('2026-11-02', '2026-11-08')).toBe('이번 주');
    expect(weekLabel('2026-10-26', TODAY)).toBe('지난주');
    expect(weekLabel('2026-11-09', TODAY)).toBe('다음 주');
  });
  it('더 먼 주는 실제 기간 — 어느 주든 이번 주라고 하지 않는다', () => {
    expect(weekLabel('2026-11-16', TODAY)).toBe('11/16 – 11/22');
    expect(weekLabel('2026-10-19', TODAY)).toBe('10/19 – 10/25');
  });
  it('오늘이 넘어가면 같은 주의 이름도 바뀐다', () => {
    expect(weekLabel('2026-11-02', '2026-11-09')).toBe('지난주');
  });
  it('해가 다른 주는 연도까지', () => {
    expect(weekRangeText('2026-12-28', TODAY)).toBe('12/28 – 2027. 1/3');
    expect(weekRangeText('2027-02-01', TODAY)).toBe('2027. 2/1 – 2/7');
  });
});

describe('monthLabel', () => {
  it('올해는 월만, 다른 해는 연도와 함께', () => {
    expect(monthLabel('2026-11', TODAY)).toBe('11월');
    expect(monthLabel('2026-09', TODAY)).toBe('9월');
    expect(monthLabel('2025-12', TODAY)).toBe('2025년 12월');
    expect(monthLabel('2027-01', TODAY)).toBe('2027년 1월');
  });
  it('연도가 바뀌면 기준도 바뀐다(하드코딩 없음)', () => {
    expect(monthLabel('2027-01', '2027-03-01')).toBe('1월');
    expect(monthLabel('2026-11', '2027-03-01')).toBe('2026년 11월');
  });
});

describe('parseDateQuery', () => {
  const date = (year: number | null, month = 11, day = 2) => ({ year, month, day, preferYear: 2026, rest: '' });

  it.each(['11.2', '11/2', '11-2', '11월 2일', '11월2일', '11.02', '11/02', ' 11/2 ', '11.2.'])('연도 없는 %s', query => {
    expect(parseDateQuery(query, TODAY)).toEqual(date(null));
  });
  it.each(['26.11.2', '26/11/2', '26-11-2', '2026.11.02', '2026-11-02', '2026/11/02', '2026.11.2', '2026년 11월 2일', '26년 11월 2일'])('연도 있는 %s', query => {
    expect(parseDateQuery(query, TODAY)).toEqual(date(2026));
  });
  it('연도는 하드코딩하지 않는다', () => {
    expect(parseDateQuery('11/2', '2027-01-01')).toEqual({ year: null, month: 11, day: 2, preferYear: 2027, rest: '' });
    expect(parseDateQuery('2025-11-02', TODAY)?.year).toBe(2025);
  });
  it.each(['13/2', '11/31', '2/30', '0/5', '5/0', '2026-13-01', '2026-02-29', '13월 40일', '26.13.1'])('없는 날짜 %s 는 날짜로 보지 않는다', query => {
    expect(parseDateQuery(query, TODAY)).toBeNull();
  });
  it('윤년 2월 29일', () => {
    expect(parseDateQuery('2/29', TODAY)).toEqual(date(null, 2, 29));
    expect(parseDateQuery('2028-02-29', TODAY)).toEqual(date(2028, 2, 29));
  });
  it.each(['프로젝트', 'AWS', '메모장 개선', '123', '1.2.3.4', '192.168.0.1', '11', '11/', '2026'])('날짜가 아닌 %s', query => {
    expect(parseDateQuery(query, TODAY)).toBeNull();
  });
  it('구분자가 섞이면 날짜가 아니다', () => {
    expect(parseDateQuery('2026-11/02', TODAY)).toBeNull();
  });
  it('날짜와 단어가 함께 있으면 나머지를 돌려준다', () => {
    expect(parseDateQuery('11/2 AWS', TODAY)?.rest).toBe('AWS');
    expect(parseDateQuery('AWS 11월 2일 설정', TODAY)?.rest).toBe('AWS 설정');
  });
});
