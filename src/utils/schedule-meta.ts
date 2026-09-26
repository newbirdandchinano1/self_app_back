/**
 * 统一 ScheduleMeta 解析（与 App lib/schedule/meta.ts 对齐）。
 * 日历聚合、bootstrap 等共用，避免多处 parseProjectSchedule。
 */

import { addDaysToYmd, formatLocalYmd, isValidYmd } from './ymd.js';

export type ScheduleDateBounds = {
  mode?: 'date' | 'time';
  date?: string;
  range?: { start: string; end: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseExtraObject(extraData: string | null | undefined): Record<string, unknown> {
  if (!extraData) return {};
  try {
    const parsed = JSON.parse(extraData) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    /* ignore */
  }
  return {};
}

export function parseScheduleMetaFromExtra(extraData: string | null | undefined): ScheduleDateBounds | null {
  const schedule = parseExtraObject(extraData).schedule;
  if (!isRecord(schedule)) return null;
  return schedule as ScheduleDateBounds;
}

/** @deprecated 使用 parseScheduleMetaFromExtra */
export const parseProjectSchedule = parseScheduleMetaFromExtra;

export function scheduleDateToYmd(value: string): string {
  const t = value.trim();
  if (isValidYmd(t)) return t;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t.slice(0, 10);
  return formatLocalYmd(d);
}

/** @deprecated 使用 scheduleDateToYmd */
export const formatScheduleDateToYMD = scheduleDateToYmd;

/**
 * 逻辑日是否落在日程区间内（与 App isLogicalDayInYmdRange 一致）。
 */
export function isLogicalDayInYmdRange(todayYmd: string, startYmd: string, endYmd: string): boolean {
  if (!startYmd || !endYmd) return true;
  if (todayYmd < startYmd) return false;
  if (startYmd === endYmd) return todayYmd === startYmd;
  if (endYmd === addDaysToYmd(startYmd, 1)) return todayYmd < endYmd;
  return todayYmd <= endYmd;
}
