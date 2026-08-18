import { Router, type Request } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import {
  getTasksCalendarDay,
  getTasksCalendarGrid,
  getTasksCalendarSummaries,
} from '../../services/calendar/service.js';
import { fail, success } from '../../utils/response.js';
import { countInclusiveYmdDays, isValidYmd } from '../../utils/ymd.js';

const router = Router();

router.use(requireAuth);

const CALENDAR_RANGE_MAX_DAYS = 126;

function parseDayBoundary(req: Request) {
  const dayBoundaryHour = req.query.dayBoundaryHour
    ? parseInt(String(req.query.dayBoundaryHour), 10)
    : 0;
  const dayBoundaryMinute = req.query.dayBoundaryMinute
    ? parseInt(String(req.query.dayBoundaryMinute), 10)
    : 0;
  return {
    dayBoundaryHour: Number.isFinite(dayBoundaryHour) ? dayBoundaryHour : 0,
    dayBoundaryMinute: Number.isFinite(dayBoundaryMinute) ? dayBoundaryMinute : 0,
  };
}

function parseRangeQuery(req: Request, maxDays: number): { start: string; end: string } | { error: string } {
  const start = typeof req.query.start === 'string' ? req.query.start.trim() : '';
  const end = typeof req.query.end === 'string' ? req.query.end.trim() : '';
  if (!isValidYmd(start) || !isValidYmd(end)) {
    return { error: 'start 与 end 必填，格式为 YYYY-MM-DD' };
  }
  if (start > end) {
    return { error: 'start 不能晚于 end' };
  }
  const days = countInclusiveYmdDays(start, end);
  if (days > maxDays) {
    return { error: `区间不能超过 ${maxDays} 天` };
  }
  return { start, end };
}

router.get('/calendar/tasks/grid', async (req, res, next) => {
  try {
    const range = parseRangeQuery(req, CALENDAR_RANGE_MAX_DAYS);
    if ('error' in range) {
      return fail(res, range.error, -1, 400);
    }
    const data = await getTasksCalendarGrid({
      ...range,
      ...parseDayBoundary(req),
    });
    success(res, data);
  } catch (err) {
    next(err);
  }
});

router.get('/calendar/tasks/day', async (req, res, next) => {
  try {
    const ymd = typeof req.query.ymd === 'string' ? req.query.ymd.trim() : '';
    if (!isValidYmd(ymd)) {
      return fail(res, 'ymd 必填，格式为 YYYY-MM-DD', -1, 400);
    }
    const data = await getTasksCalendarDay({
      ymd,
      ...parseDayBoundary(req),
    });
    success(res, data);
  } catch (err) {
    next(err);
  }
});

router.get('/calendar/tasks', async (req, res, next) => {
  try {
    const range = parseRangeQuery(req, CALENDAR_RANGE_MAX_DAYS);
    if ('error' in range) {
      return fail(res, range.error, -1, 400);
    }
    const data = await getTasksCalendarSummaries({
      ...range,
      ...parseDayBoundary(req),
    });
    success(res, data);
  } catch (err) {
    next(err);
  }
});

export default router;
