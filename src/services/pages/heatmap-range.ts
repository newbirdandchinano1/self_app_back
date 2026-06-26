import {
  addDaysToLogicalYmd,
  getLogicalLocalYmd,
  normalizeTasksDayBoundary,
  startOfWeekMonday,
  formatLocalYmdFromDate,
  logicalYmdToLocalDate,
} from '../calendar/logical-day.js';
import type { TasksDayBoundary } from '../calendar/types.js';
import { isValidYmd } from '../../utils/ymd.js';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 逻辑日区间对应的 task_execution_events.created_at 查询边界（含日界线偏移） */
export function resolveHeatmapEventCreatedAtBounds(
  startYmd: string,
  endYmd: string,
  boundary: TasksDayBoundary,
): { createdAtGte: string; createdAtLte: string } {
  const { hour: bh, minute: bm } = boundary;
  const rangeStart = logicalYmdToLocalDate(startYmd);
  rangeStart.setHours(bh, bm, 0, 0);

  const rangeEndExclusive = logicalYmdToLocalDate(addDaysToLogicalYmd(endYmd, 1));
  rangeEndExclusive.setHours(bh, bm, 0, 0);
  const rangeEndInclusive = new Date(rangeEndExclusive.getTime() - 1000);

  const formatLocalDateTime = (date: Date): string =>
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;

  return {
    createdAtGte: formatLocalDateTime(rangeStart),
    createdAtLte: formatLocalDateTime(rangeEndInclusive),
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
  const [y, mo] = logicalToday.split('-').map((x) => parseInt(x, 10));
  const d = new Date(y, mo - 1, 1);
  d.setMonth(d.getMonth() - months);
  return formatLocalYmdFromDate(d);
}
