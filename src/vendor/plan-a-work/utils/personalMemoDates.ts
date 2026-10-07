/**
 * 개인 요일 메모의 날짜 계산 — 전부 'YYYY-MM-DD' 문자열 위에서 한다.
 *
 * 브라우저 타임존을 거치지 않는다(UTC 산술만 쓴다). '오늘' 은 언제나 서버(KST)가
 * 알려 준 값에서 시작한다 — 앱과 웹이 같은 계정에서 같은 기준을 쓰게 하기 위해서다.
 * 요일 번호는 서버와 같다: 0 = 월 … 6 = 일.
 */

export const WEEKDAY_LABELS = ['월', '화', '수', '목', '금', '토', '일'] as const;

function toUtc(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function isDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function addDays(day: string, days: number): string {
  const value = toUtc(day);
  value.setUTCDate(value.getUTCDate() + days);
  return fromUtc(value);
}

/** 0 = 월 … 6 = 일 */
export function weekdayOf(day: string): number {
  return (toUtc(day).getUTCDay() + 6) % 7;
}

export function weekStart(day: string): string {
  return addDays(day, -weekdayOf(day));
}

export function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

/**
 * 빠른 요일 이동의 도착 날짜 — **오늘 기준으로 다가오는** 그 요일.
 * 같은 요일을 고르면 다음 주 그 요일이다(오늘로 보내려면 '오늘'). 서버
 * `quick_move_date` 와 같은 규칙이며, 화면은 이 값을 미리보기로만 쓰고
 * 실제 날짜는 서버가 계산한다.
 */
export function quickMoveDate(today: string, weekday: number): string {
  const delta = (weekday - weekdayOf(today) + 7) % 7;
  return addDays(today, delta === 0 ? 7 : delta);
}

export function shortDate(day: string): string {
  const [, m, d] = day.split('-').map(Number);
  return `${m}/${d}`;
}

/** '수 9/24' */
export function dayLabel(day: string): string {
  return `${WEEKDAY_LABELS[weekdayOf(day)]} ${shortDate(day)}`;
}

/** 이동 결과 안내 — '수요일(9/24)로 이동했습니다' */
export function movedMessage(target: string | null): string {
  if (!target) return 'Next(날짜 미정)로 이동했습니다';
  return `${WEEKDAY_LABELS[weekdayOf(target)]}요일(${shortDate(target)})로 이동했습니다`;
}

/**
 * 날짜 상세의 날짜 메뉴 — **지금 보고 있는 날짜 D** 기준 같은 요일의 앞뒤 2주.
 * [D-14, D-7, D, D+7, D+14] 를 날짜순으로. 월말·연말은 UTC 날짜 산술이라 그대로 넘어간다.
 * 메모 내용이나 건수는 알지 못한다(날짜만 계산 — 본문을 미리 조회하지 않는다).
 */
export const SAME_WEEKDAY_OFFSETS = [-14, -7, 0, 7, 14] as const;
export const SAME_WEEKDAY_RELATIVE = ['2주 전', '1주 전', '보는 날짜', '1주 후', '2주 후'] as const;

export function sameWeekdayAround(day: string): string[] {
  return SAME_WEEKDAY_OFFSETS.map(offset => addDays(day, offset));
}

/** '수 9/23' — 기준 날짜와 연도가 다르면 '2027-01-06 (수)' 처럼 연도까지 보인다. */
export function dayLabelWithYear(day: string, reference: string): string {
  if (day.slice(0, 4) === reference.slice(0, 4)) return dayLabel(day);
  return `${day} (${WEEKDAY_LABELS[weekdayOf(day)]})`;
}

const MONTH_NAMES_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/**
 * 메모장 머리의 날짜 — 'September 24, 2026' (MMMM d, yyyy).
 * 브라우저 언어·타임존과 무관하게 같은 표기가 나오도록 문자열에서 바로 만든다.
 */
export function longEnglishDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${MONTH_NAMES_EN[m - 1]} ${d}, ${y}`;
}

/** 브라우저 로컬 날짜('YYYY-MM-DD') — 서버의 오늘을 아직 모를 때만 쓰는 대체값. */
export function localDayString(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function weekRangeLabel(monday: string, today: string): string {
  const current = weekStart(today);
  if (monday === current) return '이번 주';
  if (monday === addDays(current, 7)) return '다음 주';
  if (monday === addDays(current, -7)) return '지난주';
  return `${shortDate(monday)} – ${shortDate(addDays(monday, 6))}`;
}

/**
 * 보이는 날짜 중에 '반복 요일인데 아직 회차를 만들지 않은 날' 이 있는가.
 * 반복 회차는 가까운 2주만 미리 만든다 — 그 너머에서 빈 칸을 '반복 없음' 으로 오해하지
 * 않게 할 때만 안내를 띄우기 위한 판정이다(반복이 없으면 띄우지 않는다).
 */
export function beyondRecurrenceHorizon(
  days: string[],
  horizon?: { until: string; weekdays: number[] } | null,
): boolean {
  if (!horizon || horizon.weekdays.length === 0) return false;
  return days.some(day => day > horizon.until && horizon.weekdays.includes(weekdayOf(day)));
}

export const RECURRENCE_HORIZON_NOTICE =
  '반복 항목은 가까운 2주까지 미리 표시됩니다. 이후 일정은 날짜가 다가오면 자동으로 추가됩니다.';
