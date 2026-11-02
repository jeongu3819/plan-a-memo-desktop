/**
 * 찾아보기·검색의 날짜 표현 — 'YYYY-MM-DD' 문자열 위에서만 계산한다. '올해·이번 주' 는 언제나 넘겨받은 today(이 PC 의 오늘)가 기준이다.
 *   · 주간 머리: 이번 주 · 지난주 · 다음 주 · 그 밖에는 실제 기간
 *   · 월 카드: 올해는 '11월', 다른 해는 '2025년 12월'
 *   · 날짜 검색어: 11.2 · 11/2 · 11-2 · 11월 2일 · 26.11.2 · 2026-11-02 · 2026년 11월 2일 …
 */
import { addDays, shortDate, weekStart } from '../vendor/plan-a-work/utils/personalMemoDates';
import { dateWithYear } from './dayTools';

/** '11/2 – 11/8' · 해가 다르면 '2026. 12/28 – 2027. 1/3'. */
export function weekRangeText(monday: string, today: string): string {
  const sunday = addDays(monday, 6);
  return `${dateWithYear(monday, today)} – ${monday.slice(0, 4) === sunday.slice(0, 4) ? shortDate(sunday) : dateWithYear(sunday, today)}`;
}

/** 보고 있는 주의 이름 — 이번 주·지난주·다음 주만 말로, 더 먼 주는 실제 기간으로(어느 주든 '이번 주' 라고 하지 않는다). */
export function weekLabel(monday: string, today: string): string {
  const current = weekStart(today);
  if (monday === current) return '이번 주';
  if (monday === addDays(current, -7)) return '지난주';
  if (monday === addDays(current, 7)) return '다음 주';
  return weekRangeText(monday, today);
}

/** 'YYYY-MM' → 올해면 '11월', 다른 해면 '2025년 12월'. */
export function monthLabel(month: string, today: string): string {
  const [year, value] = month.split('-');
  return year === today.slice(0, 4) ? `${Number(value)}월` : `${year}년 ${Number(value)}월`;
}

export interface DateQuery {
  /** 검색어에 연도가 없으면 null — 올해를 먼저, 다른 해의 같은 날짜는 그 뒤에 */
  year: number | null;
  month: number;
  day: number;
  preferYear: number;
  /** 날짜를 뺀 나머지 검색어 */
  rest: string;
}

const KOREAN_DATE = /(?:(\d{4}|\d{2})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/;
const NUMERIC_WITH_YEAR = /(?<![\d./-])(\d{4}|\d{2})([./-])(\d{1,2})\2(\d{1,2})\.?(?![\d./-])/;
const NUMERIC_MONTH_DAY = /(?<![\d./-])(\d{1,2})([./-])(\d{1,2})\.?(?![\d./-])/;

function isValidDate(year: number | null, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  // 연도가 없으면 2월 29일도 날짜다(윤년 2000 으로 본다).
  return day <= new Date(Date.UTC(year ?? 2000, month, 0)).getUTCDate();
}

const fullYear = (text: string) => (text.length === 2 ? 2000 + Number(text) : Number(text));

/** 검색어에서 날짜를 읽는다. 날짜가 아니거나 없는 날짜(13/40)면 null — 엉뚱한 날짜를 찾지 않는다. */
export function parseDateQuery(query: string, today: string): DateQuery | null {
  const text = query.trim();
  if (!text) return null;
  const preferYear = Number(today.slice(0, 4));
  const build = (match: RegExpMatchArray, year: number | null, month: number, day: number): DateQuery | null => {
    if (!isValidDate(year, month, day)) return null;
    const rest = `${text.slice(0, match.index)} ${text.slice(match.index! + match[0].length)}`.replace(/\s+/g, ' ').trim();
    return { year, month, day, preferYear, rest };
  };
  const korean = text.match(KOREAN_DATE);
  if (korean) return build(korean, korean[1] ? fullYear(korean[1]) : null, Number(korean[2]), Number(korean[3]));
  const withYear = text.match(NUMERIC_WITH_YEAR);
  if (withYear) return build(withYear, fullYear(withYear[1]), Number(withYear[3]), Number(withYear[4]));
  const monthDay = text.match(NUMERIC_MONTH_DAY);
  if (monthDay) return build(monthDay, null, Number(monthDay[1]), Number(monthDay[3]));
  return null;
}
