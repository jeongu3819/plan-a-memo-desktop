/**
 * 날짜 상세 도구의 날짜·문구 계산 — 'YYYY-MM-DD' 문자열 위에서만(UTC 산술, 브라우저 타임존 무관).
 *   · 다가오는 같은 요일: **지금 보고 있는 날짜** 기준 +7·+14(실제 오늘이 아니다)
 *   · 알림 시각: 이 PC 의 로컬 시각 'YYYY-MM-DDTHH:MM'
 */
import { addDays, shortDate, weekdayOf, WEEKDAY_LABELS } from '../vendor/plan-a-work/utils/personalMemoDates';
import type { ReminderOffset } from './types';

/** 기본으로 보여 주는 다가오는 같은 요일(보고 있는 날짜 + 7일, + 14일). */
export function upcomingSameWeekdays(date: string): string[] {
  return [addDays(date, 7), addDays(date, 14)];
}

/** '토요일' */
export function weekdayName(date: string): string {
  return `${WEEKDAY_LABELS[weekdayOf(date)]}요일`;
}

/**
 * 다가오는 같은 요일 카드 제목 — 몇 주 뒤든 '다음 월요일 · 10/19' 로 같다(연도가 다르면 '2027. 1/4').
 * 날짜가 붙어 있으므로 '다음 주·2주 후' 같은 상대 표현은 쓰지 않는다.
 */
export function upcomingCardTitle(date: string, today: string): string {
  return `다음 ${weekdayName(date)} · ${dateWithYear(date, today)}`;
}

/** '다른 날로 이동' 에 바로 보이는 날짜 수 — 오늘 + 앞으로 7일(그 밖은 '날짜 선택…'). */
export const MOVE_MENU_DAYS_AHEAD = 7;
const MOVE_MENU_RELATIVE = ['오늘', '내일', '모레'] as const;

export interface MoveMenuDay {
  date: string;
  /** 0 = 오늘 */
  offset: number;
  /** '오늘' · '내일' · '모레' · '월요일' … */
  label: string;
  /** '금 · 11/20'(오늘·내일·모레) · '11/23'(요일 이름) — 연도가 다르면 '2027. 1/1' */
  detail: string;
}

/**
 * '다른 날로 이동' 의 날짜 목록 — **오늘부터 날짜순**(오늘·내일·모레·그다음 요일들, 토·일 포함 8개).
 * 'YYYY-MM-DD' UTC 산술이라 월말·연말·윤년을 그대로 넘고, 브라우저 타임존 때문에 하루가 어긋나지 않는다.
 */
export function moveMenuDays(today: string): MoveMenuDay[] {
  return Array.from({ length: MOVE_MENU_DAYS_AHEAD + 1 }, (_, offset) => {
    const date = addDays(today, offset);
    const when = dateWithYear(date, today);
    const relative = MOVE_MENU_RELATIVE[offset];
    return relative
      ? { date, offset, label: relative, detail: `${WEEKDAY_LABELS[weekdayOf(date)]} · ${when}` }
      : { date, offset, label: weekdayName(date), detail: when };
  });
}

export function daysBetween(from: string, to: string): number {
  const toUtc = (d: string) => {
    const [y, m, dd] = d.split('-').map(Number);
    return Date.UTC(y, m - 1, dd);
  };
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

/** 'YYYY-MM-DD' 의 연도가 기준과 다르면 연도까지 — '10/17' · '2027. 1/2' */
export function dateWithYear(date: string, reference: string): string {
  return date.slice(0, 4) === reference.slice(0, 4) ? shortDate(date) : `${date.slice(0, 4)}. ${shortDate(date)}`;
}

export const REMINDER_OFFSETS: ReminderOffset[] = [7, 2];
export const REMINDER_OFFSET_LABELS: Record<ReminderOffset, string> = { 7: '1주 전', 2: '2일 전' };
export const DEFAULT_REMINDER_TIME = '09:00';

/** 알림 시각(로컬) — Rust reminders::fire_at 과 같은 계산. */
export function reminderFireAt(date: string, offset: ReminderOffset, time: string): string {
  return `${addDays(date, -offset)}T${time}`;
}

/** 지금(로컬) 'YYYY-MM-DDTHH:MM' */
export function localMinuteString(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export interface ReminderPreview {
  offset: ReminderOffset;
  fireAt: string;
  /** 이미 지난 시각 — 저장해도 소급해서 알리지 않는다 */
  past: boolean;
}

export function reminderPreview(date: string, offsets: ReminderOffset[], time: string, now: string): ReminderPreview[] {
  return REMINDER_OFFSETS.filter(o => offsets.includes(o)).map(offset => {
    const fireAt = reminderFireAt(date, offset, time);
    return { offset, fireAt, past: fireAt <= now };
  });
}

/** '09:00' → '오전 9:00', '18:30' → '오후 6:30', '00:05' → '오전 12:05' */
export function koreanTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const half = h < 12 ? '오전' : '오후';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${half} ${hour}:${String(m).padStart(2, '0')}`;
}

/** '2026-10-17T09:00' → '10/17(토) 오전 9:00' */
export function formatFireAt(fireAt: string): string {
  const [date, time] = fireAt.split('T');
  return `${shortDate(date)}(${WEEKDAY_LABELS[weekdayOf(date)]}) ${koreanTime(time)}`;
}

/** 알림 설정 한 줄 — '1주 전 · 2일 전 · 오전 9:00' / '알림 없음'(공통 알림 설정 충돌 비교에 쓴다). */
export function describeRule(offsets: ReminderOffset[], time: string | null): string {
  if (!offsets.length) return '알림 없음';
  const ordered = REMINDER_OFFSETS.filter(o => offsets.includes(o));
  return `${ordered.map(o => REMINDER_OFFSET_LABELS[o]).join(' · ')} · ${koreanTime(time ?? DEFAULT_REMINDER_TIME)}`;
}

/** '10월 24일 토요일' */
export function koreanLongDate(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${m}월 ${d}일 ${weekdayName(date)}`;
}
