import { Router } from 'express';
import { requireAuth } from '../middlewares/auth.js';
import { getTasksCalendarSummaries } from '../services/calendar/service.js';
import { fail, success } from '../utils/response.js';
import { isValidYmd } from '../utils/ymd.js';

const router = Router();

router.use(requireAuth);

router.get('/calendar/tasks', async (req, res, next) => {
  try {
    const start = typeof req.query.start === 'string' ? req.query.start.trim() : '';
    const end = typeof req.query.end === 'string' ? req.query.end.trim() : '';

    if (!isValidYmd(start) || !isValidYmd(end)) {
      return fail(res, 'start 与 end 必填，格式为 YYYY-MM-DD', -1, 400);
    }
    if (start > end) {
      return fail(res, 'start 不能晚于 end', -1, 400);
    }

    const dayBoundaryHour = req.query.dayBoundaryHour
      ? parseInt(String(req.query.dayBoundaryHour), 10)
      : 0;
    const dayBoundaryMinute = req.query.dayBoundaryMinute
      ? parseInt(String(req.query.dayBoundaryMinute), 10)
      : 0;

    const data = await getTasksCalendarSummaries({
      start,
      end,
      dayBoundaryHour: Number.isFinite(dayBoundaryHour) ? dayBoundaryHour : 0,
      dayBoundaryMinute: Number.isFinite(dayBoundaryMinute) ? dayBoundaryMinute : 0,
    });

    success(res, data);
  } catch (err) {
    next(err);
  }
});

export default router;
