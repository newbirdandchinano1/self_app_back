import { Router } from 'express';
import { CatalogIntegrityError, getTasksCatalog } from '../../../services/pages/tasks-catalog.js';
import {
  getCompletionHeatmap,
  getTasksOverview,
} from '../../../services/pages/tasks-overview.js';
import {
  getHabitsGrid,
  getTasksPageBootstrap,
  getTasksPageSummary,
} from '../../../services/pages/tasks-bootstrap.js';
import { getTaskList } from '../../../services/pages/tasks-list.js';
import {
  assignOrUnassignFrog,
  deleteFrogSchedulePlacement,
  FrogAssignError,
  FrogScheduleError,
  getFrogCandidates,
  getFrogScheduleWeek,
  saveFrogScheduleAxis,
  upsertFrogSchedulePlacement,
  type FrogSubjectKind,
} from '../../../services/pages/frog.js';
import { parsePlacementMinuteFields } from '../../../services/pages/frog-placement-minutes.js';
import {
  DayBoundaryError,
  getDayBoundarySettings,
  updateDayBoundarySettings,
} from '../../../services/pages/day-boundary-settings.js';
import {
  PromoteTodoError,
  promoteStandaloneTodoToProject,
} from '../../../services/pages/promote-todo.js';
import { isSyncOccConflictError } from '../../../services/sync-revision.js';
import { fail, success } from '../../../utils/response.js';
import { syncWriteOptionsFromReq } from '../../../utils/device-id-from-req.js';
import { createDomainErrorHandler } from '../../../utils/domain-error-handler.js';
import {
  parseBoolQuery,
  parseIntQuery,
  parseListFilterParams,
  parseStringQuery,
  parseTasksBootstrapParams,
} from './query.js';

const handlePromoteError = createDomainErrorHandler(PromoteTodoError);
const handleDayBoundaryError = createDomainErrorHandler(DayBoundaryError);

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
      return fail(res, err.message, -1, err.status);
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
    const write = syncWriteOptionsFromReq(req);
    const data = await assignOrUnassignFrog({
      kind,
      id,
      assignYmd,
      action,
      deviceId: write.deviceId,
      mutationId: write.mutationId,
      expectedRev: write.expectedRev,
    });
    success(res, data);
  } catch (err) {
    if (isSyncOccConflictError(err)) {
      return fail(res, err.message, -1, 409, err.payload);
    }
    if (err instanceof FrogAssignError) {
      return fail(res, err.message, -1, err.status);
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
      return fail(res, err.message, -1, err.status);
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
      breaks: Array.isArray(body.breaks) ? (body.breaks as Array<{ startMinutes: number; endMinutes: number; label: string }>) : [],
      updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : undefined,
    });
    success(res, data);
  } catch (err) {
    if (err instanceof FrogScheduleError) {
      return fail(res, err.message, -1, err.status);
    }
    next(err);
  }
});

/** 周课程表：写入 / 删除占用 */
router.post('/pages/tasks/frog-schedule/placement', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = body.action === 'delete' ? 'delete' : 'upsert';
    const write = syncWriteOptionsFromReq(req);
    if (action === 'delete') {
      const id = String(body.id ?? '');
      const data = await deleteFrogSchedulePlacement(id, write);
      success(res, data);
      return;
    }
    const p = (body.placement ?? body) as Record<string, unknown>;
    const minuteFields = parsePlacementMinuteFields(p);
    const alsoAssignFrog =
      body.alsoAssignFrog === true ||
      body.also_assign_frog === true ||
      p.alsoAssignFrog === true ||
      p.also_assign_frog === true;
    const assignYmdRaw = body.assignYmd ?? body.assign_ymd ?? p.assignYmd ?? p.assign_ymd;
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
      startMinutes: minuteFields.startMinutes,
      endMinutes: minuteFields.endMinutes,
      allDay: minuteFields.allDay,
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : typeof p.created_at === 'string' ? p.created_at : undefined,
      updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : typeof p.updated_at === 'string' ? p.updated_at : undefined,
      deviceId: write.deviceId,
      mutationId: write.mutationId,
      expectedRev: write.expectedRev,
      alsoAssignFrog,
      assignYmd: typeof assignYmdRaw === 'string' ? assignYmdRaw : null,
    });
    success(res, data);
  } catch (err) {
    if (isSyncOccConflictError(err)) {
      return fail(res, err.message, -1, 409, err.payload);
    }
    if (err instanceof FrogScheduleError) {
      return fail(res, err.message, -1, err.status);
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

/**
 * POST /pages/tasks/promote-to-project — 独立待办升为项目（原子）
 * Agent：升为项目（确认卡 → App commit 或桌面直调）
 */
router.post('/pages/tasks/promote-to-project', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const taskId = String(body.taskId ?? body.task_id ?? body.id ?? '');
    const data = await promoteStandaloneTodoToProject(
      {
        taskId,
        projectId:
          typeof body.projectId === 'string'
            ? body.projectId
            : typeof body.project_id === 'string'
              ? body.project_id
              : null,
        categoryId:
          typeof body.categoryId === 'string'
            ? body.categoryId
            : typeof body.category_id === 'string'
              ? body.category_id
              : null,
        projectName:
          typeof body.projectName === 'string'
            ? body.projectName
            : typeof body.project_name === 'string'
              ? body.project_name
              : typeof body.name === 'string'
                ? body.name
                : null,
      },
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '已升为项目');
  } catch (err) {
    if (isSyncOccConflictError(err)) {
      return fail(res, err.message, -1, 409, err.payload);
    }
    handlePromoteError(err, res, next);
  }
});

/** GET /pages/tasks/day-boundary — 逻辑日界（配置时刻 + 生效页 + 任务域有效值） */
router.get('/pages/tasks/day-boundary', async (_req, res, next) => {
  try {
    const data = await getDayBoundarySettings();
    success(res, data);
  } catch (err) {
    handleDayBoundaryError(err, res, next);
  }
});

/**
 * PUT /pages/tasks/day-boundary — 设置逻辑日界
 * Agent：日界改成凌晨 N 点（确认后写入；影响全模块日界）
 */
router.put('/pages/tasks/day-boundary', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data = await updateDayBoundarySettings(
      {
        hour: body.hour,
        minute: body.minute,
        pages: body.pages,
        boundaryOnly: body.boundaryOnly === true || body.boundary_only === true,
      },
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '日界已更新');
  } catch (err) {
    if (isSyncOccConflictError(err)) {
      return fail(res, err.message, -1, 409, err.payload);
    }
    handleDayBoundaryError(err, res, next);
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
