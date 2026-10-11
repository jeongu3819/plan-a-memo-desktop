import { describe, expect, it } from 'vitest';
import {
  dateWithYear,
  formatFireAt,
  koreanLongDate,
  koreanTime,
  relativeWeekdayLabel,
  reminderFireAt,
  reminderPreview,
  upcomingSameWeekdays,
  weekdayName,
} from '../domain/dayTools';

describe('다가오는 같은 요일 — 보고 있는 날짜 기준', () => {
  it('7일·14일 뒤 같은 요일', () => {
    expect(upcomingSameWeekdays('2026-10-10')).toEqual(['2026-10-17', '2026-10-24']);
    expect(weekdayName('2026-10-17')).toBe('토요일');
  });

  it('월말·연말·윤년 경계', () => {
    expect(upcomingSameWeekdays('2026-10-28')).toEqual(['2026-11-04', '2026-11-11']);
    expect(upcomingSameWeekdays('2026-12-26')).toEqual(['2027-01-02', '2027-01-09']);
    expect(upcomingSameWeekdays('2028-02-22')).toEqual(['2028-02-29', '2028-03-07']);
    expect(upcomingSameWeekdays('2027-02-22')).toEqual(['2027-03-01', '2027-03-08']);
  });

  it('상대 이름은 보고 있는 날짜에서 센다(실제 오늘이 아니다)', () => {
    expect(relativeWeekdayLabel('2026-09-26', '2026-10-03')).toBe('다음 주 토요일');
    expect(relativeWeekdayLabel('2026-09-26', '2026-10-10')).toBe('다다음 주 토요일');
    expect(relativeWeekdayLabel('2026-10-05', '2026-10-26')).toBe('3주 뒤 월요일');
  });

  it('연도가 다르면 연도까지', () => {
    expect(dateWithYear('2026-10-17', '2026-10-10')).toBe('10/17');
    expect(dateWithYear('2027-01-02', '2026-12-26')).toBe('2027. 1/2');
  });
});

describe('알림 시각', () => {
  it('1주 전·2일 전 · 로컬 시각', () => {
    expect(reminderFireAt('2026-10-24', 7, '09:00')).toBe('2026-10-17T09:00');
    expect(reminderFireAt('2026-10-24', 2, '09:00')).toBe('2026-10-22T09:00');
    expect(reminderFireAt('2027-01-01', 2, '18:30')).toBe('2026-12-30T18:30');
  });

  it('미리 보기 — 이미 지난 시각 표시, 순서는 1주 전 → 2일 전', () => {
    const preview = reminderPreview('2026-10-24', [2, 7], '09:00', '2026-10-18T10:00');
    expect(preview).toEqual([
      { offset: 7, fireAt: '2026-10-17T09:00', past: true },
      { offset: 2, fireAt: '2026-10-22T09:00', past: false },
    ]);
    expect(reminderPreview('2026-10-24', [], '09:00', '2026-10-18T10:00')).toEqual([]);
  });

  it('문구', () => {
    expect(koreanTime('09:00')).toBe('오전 9:00');
    expect(koreanTime('00:05')).toBe('오전 12:05');
    expect(koreanTime('12:00')).toBe('오후 12:00');
    expect(koreanTime('18:30')).toBe('오후 6:30');
    expect(formatFireAt('2026-10-17T09:00')).toBe('10/17(토) 오전 9:00');
    expect(koreanLongDate('2026-10-24')).toBe('10월 24일 토요일');
  });
});
