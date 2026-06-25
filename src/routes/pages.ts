import { Router, type Request } from 'express';
import { requireAuth } from '../middlewares/auth.js';
import {
  getTasksPageBootstrap,
  getTasksPageSummary,
  type TasksBootstrapParams,
} from '../services/pages/tasks-bootstrap.js';
import { success } from '../utils/response.js';

const router = Router();

router.use(requireAuth);

function parseTasksBootstrapParams(req: Request): TasksBootstrapParams {
  const dayBoundaryHour = req.query.dayBoundaryHour
    ? parseInt(String(req.query.dayBoundaryHour), 10)
    : 0;
  const dayBoundaryMinute = req.query.dayBoundaryMinute
    ? parseInt(String(req.query.dayBoundaryMinute), 10)
    : 0;
  const habitCheckInMonths = req.query.habitCheckInMonths
    ? parseInt(String(req.query.habitCheckInMonths), 10)
    : undefined;

  return {
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
  };
}

router.get('/pages/tasks/summary', async (req, res, next) => {
  try {
    const data = await getTasksPageSummary(parseTasksBootstrapParams(req));
    success(res, data);
  } catch (err) {
    next(err);
  }
});

router.get('/pages/tasks', async (req, res, next) => {
  try {
    const data = await getTasksPageBootstrap(parseTasksBootstrapParams(req));
    success(res, data);
  } catch (err) {
    next(err);
  }
});

export default router;
