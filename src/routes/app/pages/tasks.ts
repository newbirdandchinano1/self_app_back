import { Router } from 'express';
import { CatalogIntegrityError, getTasksCatalog } from '../../../services/pages/tasks-catalog.js';
import { getCompletionHeatmap } from '../../../services/pages/completion-heatmap.js';
import { getHabitsGrid } from '../../../services/pages/habits-grid.js';
import { getTaskList } from '../../../services/pages/task-list.js';
import { getTasksOverview } from '../../../services/pages/tasks-overview.js';
import {
  getTasksPageBootstrap,
  getTasksPageSummary,
} from '../../../services/pages/tasks-bootstrap.js';
import { getTodayFrogTasks } from '../../../services/pages/today-frogs.js';
import { success } from '../../../utils/response.js';
import {
  parseBoolQuery,
  parseIntQuery,
  parseListFilterParams,
  parseStringQuery,
  parseTasksBootstrapParams,
} from './query.js';

const router = Router();

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
