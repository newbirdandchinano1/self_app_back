import type { TasksDayBoundary } from './types.js';
import { DEFAULT_TASKS_DAY_BOUNDARY } from './types.js';

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

export function formatLocalYmdFromDate(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

export function getLogicalLocalYmd(now: Date, boundary: TasksDayBoundary): string {
  const { hour: bh, minute: bm } = boundary;
  const y = now.getFullYear();
  const mo = now.getMonth();
  const d = now.getDate();
  const mins = now.getHours() * 60 + now.getMinutes();
  const startMins = bh * 60 + bm;
  const logical = new Date(y, mo, d);
  if (mins < startMins) {
    logical.setDate(logical.getDate() - 1);
  }
  return formatLocalYmdFromDate(logical);
}

export function logicalYmdToLocalDate(ymd: string): Date {
  const [y, mo, d] = ymd.split('-').map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) {
    return new Date();
  }
  return new Date(y, mo - 1, d, 12, 0, 0, 0);
}

export function addDaysToLogicalYmd(ymd: string, deltaDays: number): string {
  const d = logicalYmdToLocalDate(ymd);
  d.setDate(d.getDate() + deltaDays);
  return formatLocalYmdFromDate(d);
}

export function startOfWeekMonday(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return x;
}
