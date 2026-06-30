import type { TasksDayBoundary } from './types.js';
import { DEFAULT_TASKS_DAY_BOUNDARY } from './types.js';
import { APP_MYSQL_TIMEZONE, APP_TIME_ZONE } from '../../config/timezone.js';

export { APP_TIME_ZONE };

export type WallClockParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
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
    second: 'numeric',
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
    second: pick('second'),
  };
}

export function formatMySQLWallClockDateTime(date: Date): string {
  const wc = getWallClockInAppTimeZone(date);
  return `${formatYmd(wc.year, wc.month, wc.day)} ${pad2(wc.hour)}:${pad2(wc.minute)}:${pad2(wc.second ?? 0)}`;
}

export function formatMySQLWallClockDateTimeFromParts(
  ymd: string,
  hour: number,
  minute: number,
  second = 0,
): string {
  return `${ymd} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
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

/** 无时区 DATETIME 字符串的墙钟语义 */
export type DbNaiveDateTimeMode = 'utc' | 'shanghai';

/**
 * 解析 DB / API 的 datetime 为 UTC 时刻。
 * - `utc`：无时区字符串按 UTC 墙钟（task_execution_events 等 sync 惯例）
 * - `shanghai`：无时区字符串按东八区墙钟（health_records 等本地记录惯例）
 */
export function parseDbDateTimeToInstantInMode(
  raw: unknown,
  mode: DbNaiveDateTimeMode,
): Date | null {
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
  const suffix = mode === 'shanghai' ? APP_MYSQL_TIMEZONE : 'Z';
  const ms = Date.parse(`${normalized}${suffix}`);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** @see parseDbDateTimeToInstantInMode — 默认 UTC 墙钟（任务事件 sync） */
export function parseDbDateTimeToInstant(raw: unknown): Date | null {
  return parseDbDateTimeToInstantInMode(raw, 'utc');
}

export function getDbNaiveDateTimeModeForTable(table: string): DbNaiveDateTimeMode {
  if (table === 'health_records') return 'shanghai';
  return 'utc';
}

/** 将任意 datetime 输入规范化为 MySQL 存库字符串（与表墙钟语义一致） */
export function normalizeDbDateTimeForStorage(
  raw: unknown,
  mode: DbNaiveDateTimeMode = 'utc',
): string | null {
  const instant = parseDbDateTimeToInstantInMode(raw, mode);
  if (!instant) return null;
  return mode === 'shanghai'
    ? formatMySQLWallClockDateTime(instant)
    : formatUtcMySQLDateTime(instant);
}

export function normalizeDbDateTimeForTableStorage(
  table: string,
  raw: unknown,
): string | null {
  return normalizeDbDateTimeForStorage(raw, getDbNaiveDateTimeModeForTable(table));
}

const API_DATETIME_FIELD_RE = /_at$/;

/** 值是否含时刻（非纯 YYYY-MM-DD 日期） */
export function looksLikeDateTimeValue(raw: unknown): boolean {
  if (raw == null || raw === '') return false;
  const text = String(raw).trim();
  if (!text) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  if (/[Zz]$/.test(text) || /[+-]\d{2}:?\d{2}$/.test(text)) return true;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}/.test(text)) return true;
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return true;
  return false;
}

/** 是否为 API 响应中的 datetime 字段 */
export function isApiDateTimeField(field: string, value?: unknown): boolean {
  if (API_DATETIME_FIELD_RE.test(field)) return true;
  // health_records.record_date 可存具体摄入时刻
  if (field === 'record_date' && looksLikeDateTimeValue(value)) return true;
  return false;
}

/**
 * 将 DB DATETIME 转为 ISO 8601（Z），供前端正确解析。
 * 已是 ISO / 带时区偏移的值会先归一化再输出。
 */
export function formatDbDateTimeForApi(
  raw: unknown,
  mode: DbNaiveDateTimeMode = 'utc',
): string | null {
  if (raw == null || raw === '') return null;
  const instant = parseDbDateTimeToInstantInMode(raw, mode);
  if (!instant) return String(raw).trim() || null;
  return instant.toISOString();
}

/** 格式化单条记录中所有 datetime 字段，用于 API 响应 */
export function formatRecordDateTimesForApi<T extends Record<string, unknown>>(
  row: T,
  table?: string,
): T {
  const mode = table ? getDbNaiveDateTimeModeForTable(table) : 'utc';
  const result: Record<string, unknown> = { ...row };
  for (const key of Object.keys(result)) {
    const value = result[key];
    if (!isApiDateTimeField(key, value)) continue;
    if (value == null || value === '') continue;
    const formatted = formatDbDateTimeForApi(value, mode);
    if (formatted) result[key] = formatted;
  }
  return result as T;
}

export function formatRowsDateTimesForApi<T extends Record<string, unknown>>(
  rows: T[],
  table?: string,
): T[] {
  return rows.map((row) => formatRecordDateTimesForApi(row, table));
}

export function getLogicalYmdFromCreatedAt(
  raw: unknown,
  boundary: TasksDayBoundary,
): string | null {
  const instant = parseDbDateTimeToInstant(raw);
  if (!instant) return null;
  return getLogicalYmdFromInstant(instant, boundary);
}

/** MySQL DATETIME 字符串：UTC 墙钟分量（与客户端 sync 存库格式一致） */
export function formatUtcMySQLDateTime(date: Date): string {
  return `${formatYmd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
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
    `${formatYmd(parsed.year, parsed.month, parsed.day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}${APP_MYSQL_TIMEZONE}`,
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
