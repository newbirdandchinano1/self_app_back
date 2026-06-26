import {
  addDaysToLogicalYmd,
  getLogicalLocalYmd,
  normalizeTasksDayBoundary,
  startOfWeekMonday,
  formatLocalYmdFromDate,
  formatYmd,
  shanghaiWallClockToUtcDate,
  formatMySQLWallClockDateTime,
  formatMySQLWallClockDateTimeFromParts,
} from '../calendar/logical-day.js';
import type { TasksDayBoundary } from '../calendar/types.js';
import { isValidYmd } from '../../utils/ymd.js';

/** 逻辑日区间对应的 task_execution_events.created_at 查询边界（东八区墙钟 DATETIME） */
export function resolveHeatmapEventCreatedAtBounds(
  startYmd: string,
  endYmd: string,
  boundary: TasksDayBoundary,
): { createdAtGte: string; createdAtLte: string } {
  const { hour: bh, minute: bm } = boundary;
  const rangeStart = shanghaiWallClockToUtcDate(startYmd, bh, bm, 0);
  const rangeEndExclusive = shanghaiWallClockToUtcDate(addDaysToLogicalYmd(endYmd, 1), bh, bm, 0);
  if (!rangeStart || !rangeEndExclusive) {
    return {
      createdAtGte: formatMySQLWallClockDateTimeFromParts(startYmd, 0, 0, 0),
      createdAtLte: formatMySQLWallClockDateTimeFromParts(endYmd, 23, 59, 59),
    };
  }
  const rangeEndInclusive = new Date(rangeEndExclusive.getTime() - 1000);
  return {
    createdAtGte: formatMySQLWallClockDateTimeFromParts(startYmd, bh, bm, 0),
    createdAtLte: formatMySQLWallClockDateTime(rangeEndInclusive),
  };
}

export const COMPLETION_HEATMAP_WEEKS = 15;
export const TASKS_OVERVIEW_HEATMAP_WEEKS = 14;

export function resolveHeatmapRange(params: {
  heatmapStart?: string;
  heatmapEnd?: string;
  dayBoundary?: TasksDayBoundary;
  now?: Date;
}): { startYmd: string; endYmd: string; logicalToday: string } {
  const boundary = normalizeTasksDayBoundary(params.dayBoundary ?? {});
  const now = params.now ?? new Date();
  const logicalToday = getLogicalLocalYmd(now, boundary);

  let endYmd = params.heatmapEnd?.trim() ?? logicalToday;
  if (!isValidYmd(endYmd)) endYmd = logicalToday;
  if (endYmd > logicalToday) endYmd = logicalToday;

  let startYmd = params.heatmapStart?.trim() ?? '';
  if (!isValidYmd(startYmd)) {
    const thisMonday = startOfWeekMonday(now);
    const gridStartMonday = new Date(thisMonday);
    gridStartMonday.setDate(gridStartMonday.getDate() - (COMPLETION_HEATMAP_WEEKS - 1) * 7);
    startYmd = formatLocalYmdFromDate(gridStartMonday);
  }

  if (startYmd > endYmd) {
    startYmd = addDaysToLogicalYmd(endYmd, -(COMPLETION_HEATMAP_WEEKS - 1) * 7);
  }

  return { startYmd, endYmd, logicalToday };
}

export function resolveOverviewHeatmapRange(params: {
  heatmapStart?: string;
  heatmapEnd?: string;
  dayBoundary?: TasksDayBoundary;
  now?: Date;
}): { startYmd: string; endYmd: string; logicalToday: string } {
  const boundary = normalizeTasksDayBoundary(params.dayBoundary ?? {});
  const now = params.now ?? new Date();
  const logicalToday = getLogicalLocalYmd(now, boundary);

  let endYmd = params.heatmapEnd?.trim() ?? logicalToday;
  if (!isValidYmd(endYmd)) endYmd = logicalToday;
  if (endYmd > logicalToday) endYmd = logicalToday;

  let startYmd = params.heatmapStart?.trim() ?? '';
  if (!isValidYmd(startYmd)) {
    const thisMonday = startOfWeekMonday(now);
    const gridStartMonday = new Date(thisMonday);
    gridStartMonday.setDate(
      gridStartMonday.getDate() - (TASKS_OVERVIEW_HEATMAP_WEEKS - 1) * 7,
    );
    startYmd = formatLocalYmdFromDate(gridStartMonday);
  }

  if (startYmd > endYmd) {
    startYmd = addDaysToLogicalYmd(endYmd, -(TASKS_OVERVIEW_HEATMAP_WEEKS - 1) * 7);
  }

  return { startYmd, endYmd, logicalToday };
}

export function resolveHabitCheckInStartYmd(logicalToday: string, months = 24): string {
  const parsed = logicalToday.split('-').map((x) => parseInt(x, 10));
  const y = parsed[0];
  const mo = parsed[1];
  if (!Number.isFinite(y) || !Number.isFinite(mo)) return logicalToday;
  let year = y;
  let month = mo - months;
  while (month <= 0) {
    month += 12;
    year -= 1;
  }
  return formatYmd(year, month, 1);
}
