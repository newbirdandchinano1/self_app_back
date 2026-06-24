import {
  addDaysToLogicalYmd,
  getLogicalLocalYmd,
  normalizeTasksDayBoundary,
  startOfWeekMonday,
  formatLocalYmdFromDate,
} from '../calendar/logical-day.js';
import type { TasksDayBoundary } from '../calendar/types.js';
import { isValidYmd } from '../../utils/ymd.js';

export const COMPLETION_HEATMAP_WEEKS = 15;

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

export function resolveHabitCheckInStartYmd(logicalToday: string, months = 24): string {
  const [y, mo] = logicalToday.split('-').map((x) => parseInt(x, 10));
  const d = new Date(y, mo - 1, 1);
  d.setMonth(d.getMonth() - months);
  return formatLocalYmdFromDate(d);
}
