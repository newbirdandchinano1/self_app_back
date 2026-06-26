import { Router, type Request } from 'express';
import { requireAuth } from '../middlewares/auth.js';
import { getProjectList, type ProjectListParams } from '../services/pages/project-list.js';
import { getTaskList, type TaskListParams } from '../services/pages/task-list.js';
import {
  getTasksPageBootstrap,
  getTasksPageSummary,
  type TasksBootstrapParams,
} from '../services/pages/tasks-bootstrap.js';
import { CatalogIntegrityError, getTasksCatalog } from '../services/pages/tasks-catalog.js';
import { getTodayFrogTasks } from '../services/pages/today-frogs.js';
import { getHabitsGrid } from '../services/pages/habits-grid.js';
import { getCompletionHeatmap } from '../services/pages/completion-heatmap.js';
import { getTasksOverview } from '../services/pages/tasks-overview.js';
import { success } from '../utils/response.js';

const router = Router();

router.use(requireAuth);

function parseBoolQuery(value: unknown): boolean | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

function parseIntQuery(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseStringQuery(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseTasksBootstrapParams(req: Request): TasksBootstrapParams {
  const dayBoundaryHour = parseIntQuery(req.query.dayBoundaryHour) ?? 0;
  const dayBoundaryMinute = parseIntQuery(req.query.dayBoundaryMinute) ?? 0;

  return {
    dayBoundaryHour,
    dayBoundaryMinute,
    heatmapStart: parseStringQuery(req.query.heatmapStart),
    heatmapEnd: parseStringQuery(req.query.heatmapEnd),
    habitCheckInStart: parseStringQuery(req.query.habitCheckInStart),
    habitCheckInEnd: parseStringQuery(req.query.habitCheckInEnd),
    habitCheckInMonths: parseIntQuery(req.query.habitCheckInMonths),
    include: parseStringQuery(req.query.include),
    taskView: parseStringQuery(req.query.taskView),
    taskViews: parseStringQuery(req.query.taskViews),
    logicalToday: parseStringQuery(req.query.logicalToday),
    weekStart: parseStringQuery(req.query.weekStart),
    weekEnd: parseStringQuery(req.query.weekEnd),
    projectIds: parseStringQuery(req.query.projectIds),
    includeCompleted: parseBoolQuery(req.query.includeCompleted),
    includeCancelled: parseBoolQuery(req.query.includeCancelled),
    includeShelved: parseBoolQuery(req.query.includeShelved),
    page: parseIntQuery(req.query.page),
    limit: parseIntQuery(req.query.limit),
  };
}

function parseListFilterParams(req: Request): ProjectListParams & TaskListParams {
  return {
    categoryId: parseStringQuery(req.query.categoryId),
    categoryIds: parseStringQuery(req.query.categoryIds),
    uncategorized: parseBoolQuery(req.query.uncategorized),
    includeCompleted: parseBoolQuery(req.query.includeCompleted),
    includeCancelled: parseBoolQuery(req.query.includeCancelled),
    includeShelved: parseBoolQuery(req.query.includeShelved),
    page: parseIntQuery(req.query.page),
    limit: parseIntQuery(req.query.limit),
    updatedSince: parseStringQuery(req.query.updatedSince),
  };
}

router.get('/pages/projects', async (req, res, next) => {
  try {
    const data = await getProjectList(parseListFilterParams(req));
    success(res, data);
  } catch (err) {
    next(err);
  }
});

router.get('/pages/tasks/summary', async (req, res, next) => {
  try {
    const data = await getTasksPageSummary(parseTasksBootstrapParams(req));
    success(res, data);
  } catch (err) {
    next(err);
  }
});

router.get('/pages/tasks/today-frogs', async (req, res, next) => {
  try {
    const data = await getTodayFrogTasks(parseTasksBootstrapParams(req));
    success(res, data);
  } catch (err) {
    next(err);
  }
});

router.get('/pages/tasks/habits-grid', async (req, res, next) => {
  try {
    const data = await getHabitsGrid(parseTasksBootstrapParams(req));
    success(res, data);
  } catch (err) {
    next(err);
  }
});

router.get('/pages/tasks/completion-heatmap', async (req, res, next) => {
  try {
    const data = await getCompletionHeatmap({
      ...parseTasksBootstrapParams(req),
      day: parseStringQuery(req.query.day),
      includeDayDetail: parseBoolQuery(req.query.includeDayDetail),
    });
    success(res, data);
  } catch (err) {
    next(err);
  }
});

router.get('/pages/tasks/tasks-overview', async (req, res, next) => {
  try {
    const data = await getTasksOverview({
      ...parseTasksBootstrapParams(req),
      eventsPage: parseIntQuery(req.query.eventsPage),
      eventsLimit: parseIntQuery(req.query.eventsLimit),
      statKey: parseStringQuery(req.query.statKey),
      statPage: parseIntQuery(req.query.statPage),
      statLimit: parseIntQuery(req.query.statLimit),
      day: parseStringQuery(req.query.day),
      includeDayDetail: parseBoolQuery(req.query.includeDayDetail),
    });
    success(res, data);
  } catch (err) {
    next(err);
  }
});

router.get('/pages/tasks/catalog', async (req, res, next) => {
  try {
    const data = await getTasksCatalog({
      updatedSince: parseStringQuery(req.query.updatedSince),
    });
    success(res, data);
  } catch (err) {
    if (err instanceof CatalogIntegrityError) {
      console.error('[catalog] integrity check failed:', err.message, {
        adminId: req.admin?.id,
      });
    }
    next(err);
  }
});

router.get('/pages/tasks/list', async (req, res, next) => {
  try {
    const data = await getTaskList(parseListFilterParams(req));
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
