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
import {
  assignOrUnassignFrog,
  FrogAssignError,
  type FrogSubjectKind,
} from '../../../services/pages/frog-assign.js';
import { getFrogCandidates } from '../../../services/pages/frog-candidates.js';
import {
  deleteFrogSchedulePlacement,
  FrogScheduleError,
  getFrogScheduleWeek,
  saveFrogScheduleAxis,
  upsertFrogSchedulePlacement,
} from '../../../services/pages/frog-schedule.js';
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

/** 青蛙候选（轻量挑选列表，含无项目待办） */
router.get('/pages/tasks/frog-candidates', async (req, res, next) => {
  try {
    const data = await getFrogCandidates({
      ...parseTasksBootstrapParams(req),
      assignYmd: parseStringQuery(req.query.assignYmd),
    });
    success(res, data);
  } catch (err) {
    if (err instanceof FrogAssignError) {
      res.status(err.status).json({ success: false, message: err.message });
      return;
    }
    next(err);
  }
});

/** 指派 / 取消青蛙（任意日） */
router.post('/pages/tasks/frog-assign', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = String(body.kind ?? '') as FrogSubjectKind;
    const id = String(body.id ?? '');
    const assignYmd = String(body.assignYmd ?? '');
    const action = body.action === 'unassign' ? 'unassign' : 'assign';
    const data = await assignOrUnassignFrog({ kind, id, assignYmd, action });
    success(res, data);
  } catch (err) {
    if (err instanceof FrogAssignError) {
      res.status(err.status).json({ success: false, message: err.message });
      return;
    }
    next(err);
  }
});

/** 周课程表：读一周占用 + 轴 */
router.get('/pages/tasks/frog-schedule', async (req, res, next) => {
  try {
    const data = await getFrogScheduleWeek({
      weekStartYmd: parseStringQuery(req.query.weekStartYmd) ?? '',
      logicalTodayYmd: parseStringQuery(req.query.logicalTodayYmd),
    });
    success(res, data);
  } catch (err) {
    if (err instanceof FrogScheduleError) {
      res.status(err.status).json({ success: false, message: err.message });
      return;
    }
    next(err);
  }
});

/** 周课程表：保存全局时间轴 */
router.post('/pages/tasks/frog-schedule/axis', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data = await saveFrogScheduleAxis({
      startMinutes: Number(body.startMinutes),
      endMinutes: Number(body.endMinutes),
      slotHours: Number(body.slotHours),
      updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : undefined,
    });
    success(res, data);
  } catch (err) {
    if (err instanceof FrogScheduleError) {
      res.status(err.status).json({ success: false, message: err.message });
      return;
    }
    next(err);
  }
});

/** 周课程表：写入 / 删除占用 */
router.post('/pages/tasks/frog-schedule/placement', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = body.action === 'delete' ? 'delete' : 'upsert';
    if (action === 'delete') {
      const id = String(body.id ?? '');
      const data = await deleteFrogSchedulePlacement(id);
      success(res, data);
      return;
    }
    const p = (body.placement ?? body) as Record<string, unknown>;
    const data = await upsertFrogSchedulePlacement({
      id: String(p.id ?? ''),
      weekStartYmd: String(p.weekStartYmd ?? p.week_start_ymd ?? ''),
      weekday: Number(p.weekday),
      startSlotIndex:
        p.startSlotIndex == null && p.start_slot_index == null
          ? null
          : Number(p.startSlotIndex ?? p.start_slot_index),
      spanSlots: Number(p.spanSlots ?? p.span_slots ?? 1),
      subjectKind: p.subjectKind === 'project' || p.subject_kind === 'project' ? 'project' : 'task',
      subjectId: String(p.subjectId ?? p.subject_id ?? ''),
      orphaned: Number(p.orphaned ?? 0),
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : typeof p.created_at === 'string' ? p.created_at : undefined,
      updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : typeof p.updated_at === 'string' ? p.updated_at : undefined,
    });
    success(res, data);
  } catch (err) {
    if (err instanceof FrogScheduleError) {
      res.status(err.status).json({ success: false, message: err.message });
      return;
    }
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
