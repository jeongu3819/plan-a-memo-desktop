import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayLabel,
  beyondRecurrenceHorizon,
  dayLabelWithYear,
  localDayString,
  longEnglishDate,
  sameWeekdayAround,
  movedMessage,
  quickMoveDate,
  weekDays,
  weekRangeLabel,
  weekStart,
  weekdayOf,
} from './personalMemoDates';

describe('personal memo dates', () => {
  it('uses Monday-first weekday numbers like the server', () => {
    expect(weekdayOf('2026-09-21')).toBe(0); // 월
    expect(weekdayOf('2026-09-27')).toBe(6); // 일
    expect(weekStart('2026-09-27')).toBe('2026-09-21');
    expect(weekDays('2026-09-21')).toHaveLength(7);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('quick move goes to the upcoming weekday counted from today', () => {
    expect(quickMoveDate('2026-09-21', 2)).toBe('2026-09-23'); // 월 → 이번 주 수
    expect(quickMoveDate('2026-09-25', 2)).toBe('2026-09-30'); // 금 → 다음 주 수
    expect(quickMoveDate('2026-09-22', 1)).toBe('2026-09-29'); // 같은 요일 → 다음 주
    expect(quickMoveDate('2026-09-27', 0)).toBe('2026-09-28'); // 일 → 다음 날 월
  });

  it('labels days and move results with the actual date', () => {
    expect(dayLabel('2026-09-24')).toBe('목 9/24');
    expect(movedMessage('2026-09-23')).toBe('수요일(9/23)로 이동했습니다');
    expect(movedMessage(null)).toBe('Next(날짜 미정)로 이동했습니다');
    expect(weekRangeLabel('2026-09-21', '2026-09-23')).toBe('이번 주');
    expect(weekRangeLabel('2026-09-28', '2026-09-23')).toBe('다음 주');
    expect(weekRangeLabel('2026-10-05', '2026-09-23')).toBe('10/5 – 10/11');
  });

  it('same weekday ±2 weeks around the viewed day, across month and year ends', () => {
    expect(sameWeekdayAround('2026-09-23')).toEqual(['2026-09-09', '2026-09-16', '2026-09-23', '2026-09-30', '2026-10-07']);
    expect(sameWeekdayAround('2026-09-16')).toEqual(['2026-09-02', '2026-09-09', '2026-09-16', '2026-09-23', '2026-09-30']);
    expect(sameWeekdayAround('2026-12-30')).toEqual(['2026-12-16', '2026-12-23', '2026-12-30', '2027-01-06', '2027-01-13']);
    expect(sameWeekdayAround('2028-03-01')).toEqual(['2028-02-16', '2028-02-23', '2028-03-01', '2028-03-08', '2028-03-15']); // 윤년 2월
    expect(sameWeekdayAround('2026-12-30').every(d => weekdayOf(d) === 2)).toBe(true);
    expect(dayLabelWithYear('2027-01-06', '2026-12-30')).toBe('2027-01-06 (수)');
    expect(dayLabelWithYear('2026-12-16', '2026-12-30')).toBe('수 12/16');
  });

  it('formats the note header date as MMMM d, yyyy', () => {
    expect(longEnglishDate('2026-09-24')).toBe('September 24, 2026');
    expect(longEnglishDate('2026-10-03')).toBe('October 3, 2026');
    expect(longEnglishDate('2027-01-07')).toBe('January 7, 2027');
    expect(longEnglishDate('2028-02-29')).toBe('February 29, 2028');
    expect(localDayString(new Date(2026, 8, 24, 23, 59))).toBe('2026-09-24');
    expect(localDayString(new Date(2027, 0, 7, 0, 0))).toBe('2027-01-07');
  });

  it('flags only far days that fall on an active recurrence weekday', () => {
    const horizon = { until: '2026-10-05', weekdays: [1] }; // 화요일 반복
    expect(beyondRecurrenceHorizon(weekDays('2026-09-28'), horizon)).toBe(false); // 9/29 는 창 안
    expect(beyondRecurrenceHorizon(weekDays('2026-10-05'), horizon)).toBe(true);  // 10/6 은 창 밖
    expect(beyondRecurrenceHorizon(weekDays('2026-10-05'), { until: '2026-10-05', weekdays: [] })).toBe(false);
    expect(beyondRecurrenceHorizon(['2026-10-10'], horizon)).toBe(false);          // 토요일
  });
});
