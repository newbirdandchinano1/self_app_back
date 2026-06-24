import { Router } from 'express';
import { requireAuth } from '../middlewares/auth.js';
import { getTasksPageBootstrap } from '../services/pages/tasks-bootstrap.js';
import { fail, success } from '../utils/response.js';

const router = Router();

router.use(requireAuth);

router.get('/pages/tasks', async (req, res, next) => {
  try {
    const dayBoundaryHour = req.query.dayBoundaryHour
      ? parseInt(String(req.query.dayBoundaryHour), 10)
      : 0;
    const dayBoundaryMinute = req.query.dayBoundaryMinute
      ? parseInt(String(req.query.dayBoundaryMinute), 10)
      : 0;
    const habitCheckInMonths = req.query.habitCheckInMonths
      ? parseInt(String(req.query.habitCheckInMonths), 10)
      : undefined;

    const data = await getTasksPageBootstrap({
      dayBoundaryHour: Number.isFinite(dayBoundaryHour) ? dayBoundaryHour : 0,
      dayBoundaryMinute: Number.isFinite(dayBoundaryMinute) ? dayBoundaryMinute : 0,
      heatmapStart: typeof req.query.heatmapStart === 'string' ? req.query.heatmapStart : undefined,
      heatmapEnd: typeof req.query.heatmapEnd === 'string' ? req.query.heatmapEnd : undefined,
      habitCheckInStart:
        typeof req.query.habitCheckInStart === 'string' ? req.query.habitCheckInStart : undefined,
      habitCheckInEnd:
        typeof req.query.habitCheckInEnd === 'string' ? req.query.habitCheckInEnd : undefined,
      habitCheckInMonths: Number.isFinite(habitCheckInMonths) ? habitCheckInMonths : undefined,
      include: typeof req.query.include === 'string' ? req.query.include : undefined,
    });

    success(res, data);
  } catch (err) {
    next(err);
  }
});

export default router;
