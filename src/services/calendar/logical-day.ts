import type { TasksDayBoundary } from './types.js';
import { DEFAULT_TASKS_DAY_BOUNDARY } from './types.js';

/** APP 逻辑日按东八区墙钟计算（与客户端/数据库存储习惯一致） */
export const APP_TIME_ZONE = 'Asia/Shanghai';

export type WallClockParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatYmd(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function parseYmd(ymd: string): { year: number; month: number; day: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [year, month, day] = ymd.split('-').map((x) => parseInt(x, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return { year, month, day };
}

export function addDaysToYmd(ymd: string, deltaDays: number): string {
  const parsed = parseYmd(ymd);
  if (!parsed) return ymd;
  const utc = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  utc.setUTCDate(utc.getUTCDate() + deltaDays);
  return formatYmd(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
}

export function normalizeTasksDayBoundary(raw: unknown): TasksDayBoundary {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_TASKS_DAY_BOUNDARY };
  }
  const o = raw as Record<string, unknown>;
  const hour =
    typeof o.hour === 'number' && Number.isFinite(o.hour)
      ? Math.round(o.hour)
      : DEFAULT_TASKS_DAY_BOUNDARY.hour;
  const minute =
    typeof o.minute === 'number' && Number.isFinite(o.minute)
      ? Math.round(o.minute)
      : DEFAULT_TASKS_DAY_BOUNDARY.minute;
  return {
    hour: Math.min(23, Math.max(0, hour)),
    minute: Math.min(59, Math.max(0, minute)),
  };
}

export function getWallClockInAppTimeZone(date: Date): WallClockParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  let hour = pick('hour');
  if (hour === 24) hour = 0;
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour,
    minute: pick('minute'),
  };
}

export function getLogicalYmdFromWallClock(
  wallClock: Pick<WallClockParts, 'year' | 'month' | 'day' | 'hour' | 'minute'>,
  boundary: TasksDayBoundary,
): string {
  const { hour: bh, minute: bm } = boundary;
  const mins = wallClock.hour * 60 + wallClock.minute;
  const startMins = bh * 60 + bm;
  const calendarYmd = formatYmd(wallClock.year, wallClock.month, wallClock.day);
  if (mins < startMins) {
    return addDaysToYmd(calendarYmd, -1);
  }
  return calendarYmd;
}

export function getLogicalYmdFromInstant(date: Date, boundary: TasksDayBoundary): string {
  return getLogicalYmdFromWallClock(getWallClockInAppTimeZone(date), boundary);
}

export function getLogicalLocalYmd(now: Date, boundary: TasksDayBoundary): string {
  return getLogicalYmdFromInstant(now, boundary);
}

export function formatLocalYmdFromDate(date: Date): string {
  const wc = getWallClockInAppTimeZone(date);
  return formatYmd(wc.year, wc.month, wc.day);
}

/**
 * 将 DB / mysql2 的 created_at 解析为 UTC 时刻。
 * MySQL DATETIME 无时区，按 UTC 墙钟存储（Docker 默认）；再换算为东八区逻辑日。
 */
export function parseDbDateTimeToInstant(raw: unknown): Date | null {
  if (raw instanceof Date) {
    const ms = raw.getTime();
    return Number.isNaN(ms) ? null : raw;
  }
  const text = String(raw ?? '').trim();
  if (!text) return null;

  if (/[Zz]$/.test(text) || /[+-]\d{2}:?\d{2}$/.test(text)) {
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : new Date(ms);
  }

  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const ms = Date.parse(`${normalized}Z`);
  return Number.isNaN(ms) ? null : new Date(ms);
}

export function getLogicalYmdFromCreatedAt(
  raw: unknown,
  boundary: TasksDayBoundary,
): string | null {
  const instant = parseDbDateTimeToInstant(raw);
  if (!instant) return null;
  return getLogicalYmdFromInstant(instant, boundary);
}

export function formatUtcMySQLDateTime(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

export function shanghaiWallClockToUtcDate(
  ymd: string,
  hour: number,
  minute: number,
  second = 0,
): Date | null {
  const parsed = parseYmd(ymd);
  if (!parsed) return null;
  const ms = Date.parse(
    `${formatYmd(parsed.year, parsed.month, parsed.day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}+08:00`,
  );
  return Number.isNaN(ms) ? null : new Date(ms);
}

export function logicalYmdToLocalDate(ymd: string): Date {
  return shanghaiWallClockToUtcDate(ymd, 12, 0, 0) ?? new Date();
}

export function addDaysToLogicalYmd(ymd: string, deltaDays: number): string {
  return addDaysToYmd(ymd, deltaDays);
}

function startOfWeekMondayYmd(d: Date): string {
  const wc = getWallClockInAppTimeZone(d);
  const ymd = formatYmd(wc.year, wc.month, wc.day);
  const weekday = new Date(Date.UTC(wc.year, wc.month - 1, wc.day)).getUTCDay();
  const diff = weekday === 0 ? -6 : 1 - weekday;
  return addDaysToYmd(ymd, diff);
}

export function startOfWeekMonday(d: Date): Date {
  const mondayYmd = startOfWeekMondayYmd(d);
  return shanghaiWallClockToUtcDate(mondayYmd, 12, 0, 0) ?? new Date();
}
