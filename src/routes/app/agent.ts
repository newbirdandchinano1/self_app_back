import { Router, type Request } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import {
  FinancePageError,
  getAgentFinanceSnapshot,
} from '../../services/agent/snapshot-finance.js';
import {
  getAgentTasksSnapshot,
  TasksSnapshotError,
} from '../../services/agent/snapshot-tasks.js';
import {
  getAgentHealthSnapshot,
  HealthError,
} from '../../services/agent/snapshot-health.js';
import {
  getAgentMemoSnapshot,
  MemoSnapshotError,
} from '../../services/agent/snapshot-memo.js';
import {
  getAgentReviewSnapshot,
  ReviewSnapshotError,
} from '../../services/agent/snapshot-review.js';
import {
  getAgentRecipeSnapshot,
  RecipeSnapshotError,
} from '../../services/agent/snapshot-recipe.js';
import {
  getAgentWardrobeSnapshot,
  WardrobeSnapshotError,
} from '../../services/agent/snapshot-wardrobe.js';
import {
  getAgentWishSnapshot,
  WishSnapshotError,
} from '../../services/agent/snapshot-wish.js';
import {
  getAgentProfileSnapshot,
  ProfileSnapshotError,
} from '../../services/agent/snapshot-profile.js';
import {
  getAgentLifeRoadSnapshot,
  LifeRoadSnapshotError,
} from '../../services/agent/snapshot-life-road.js';
import { FrogAssignError } from '../../services/pages/frog.js';

/**
 * Agent 专用只读聚合。
 * 挂载前缀：/api/app
 * 路径：/agent/snapshot/:domain
 */
const router = Router();

router.use(requireAuth);

const handleFinanceError = createDomainErrorHandler([FinancePageError]);
const handleTasksError = createDomainErrorHandler([TasksSnapshotError, FrogAssignError]);
const handleHealthError = createDomainErrorHandler([HealthError]);
const handleMemoError = createDomainErrorHandler([MemoSnapshotError]);
const handleReviewError = createDomainErrorHandler([ReviewSnapshotError]);
const handleRecipeError = createDomainErrorHandler([RecipeSnapshotError]);
const handleWardrobeError = createDomainErrorHandler([WardrobeSnapshotError]);
const handleWishError = createDomainErrorHandler([WishSnapshotError]);
const handleProfileError = createDomainErrorHandler([ProfileSnapshotError]);
const handleLifeRoadError = createDomainErrorHandler([LifeRoadSnapshotError]);

function parseIntQuery(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw !== 'string') return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseStringQuery(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function parseSnapshotQuery(req: Request) {
  return {
    dayBoundaryHour: parseIntQuery(req.query.dayBoundaryHour) ?? 0,
    dayBoundaryMinute: parseIntQuery(req.query.dayBoundaryMinute) ?? 0,
    logicalToday: parseStringQuery(req.query.logicalToday),
    budgetRefreshDay: parseIntQuery(req.query.budgetRefreshDay),
  };
}

/** GET /agent/snapshot/finance — 财务只读摘要（字段白名单） */
router.get('/agent/snapshot/finance', async (req, res, next) => {
  try {
    const data = await getAgentFinanceSnapshot(parseSnapshotQuery(req));
    success(res, data);
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** GET /agent/snapshot/tasks — 任务/习惯只读摘要 */
router.get('/agent/snapshot/tasks', async (req, res, next) => {
  try {
    const q = parseSnapshotQuery(req);
    const data = await getAgentTasksSnapshot({
      dayBoundaryHour: q.dayBoundaryHour,
      dayBoundaryMinute: q.dayBoundaryMinute,
      logicalToday: q.logicalToday,
    });
    success(res, data);
  } catch (err) {
    handleTasksError(err, res, next);
  }
});

/** GET /agent/snapshot/health — 健康/饮食只读摘要 */
router.get('/agent/snapshot/health', async (req, res, next) => {
  try {
    const q = parseSnapshotQuery(req);
    const date = parseStringQuery(req.query.date) ?? q.logicalToday;
    const data = await getAgentHealthSnapshot({ date, logicalToday: q.logicalToday });
    success(res, data);
  } catch (err) {
    handleHealthError(err, res, next);
  }
});

/** GET /agent/snapshot/memo — 最近备忘标题/id */
router.get('/agent/snapshot/memo', async (req, res, next) => {
  try {
    const limit = parseIntQuery(req.query.limit);
    const data = await getAgentMemoSnapshot({ limit });
    success(res, data);
  } catch (err) {
    handleMemoError(err, res, next);
  }
});

/** GET /agent/snapshot/review — 复盘是否已写 / 空栏提示 */
router.get('/agent/snapshot/review', async (req, res, next) => {
  try {
    const q = parseSnapshotQuery(req);
    const data = await getAgentReviewSnapshot({
      logicalToday: q.logicalToday,
      dailyStart: parseStringQuery(req.query.dailyStart),
      dailyEnd: parseStringQuery(req.query.dailyEnd),
      weekStart: parseStringQuery(req.query.weekStart),
      monthStart: parseStringQuery(req.query.monthStart),
    });
    success(res, data);
  } catch (err) {
    handleReviewError(err, res, next);
  }
});

/** GET /agent/snapshot/recipe — 菜谱库摘要 */
router.get('/agent/snapshot/recipe', async (req, res, next) => {
  try {
    const limit = parseIntQuery(req.query.limit);
    const data = await getAgentRecipeSnapshot({ limit });
    success(res, data);
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** GET /agent/snapshot/wardrobe — 衣橱只读摘要 */
router.get('/agent/snapshot/wardrobe', async (req, res, next) => {
  try {
    const limit = parseIntQuery(req.query.limit);
    const data = await getAgentWardrobeSnapshot({ limit });
    success(res, data);
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** GET /agent/snapshot/wish — 心愿板只读摘要（不含兑奖写） */
router.get('/agent/snapshot/wish', async (req, res, next) => {
  try {
    const limit = parseIntQuery(req.query.limit);
    const data = await getAgentWishSnapshot({ limit });
    success(res, data);
  } catch (err) {
    handleWishError(err, res, next);
  }
});

/** GET /agent/snapshot/profile — 资料完整度 / 档案摘要 */
router.get('/agent/snapshot/profile', async (req, res, next) => {
  try {
    const q = parseSnapshotQuery(req);
    const data = await getAgentProfileSnapshot({ logicalToday: q.logicalToday });
    success(res, data);
  } catch (err) {
    handleProfileError(err, res, next);
  }
});

/** GET /agent/snapshot/life_road — 人生道路方向/焦点/节点摘要 */
router.get('/agent/snapshot/life_road', async (req, res, next) => {
  try {
    const limit = parseIntQuery(req.query.limit);
    const calendarYear = parseIntQuery(req.query.calendarYear);
    const data = await getAgentLifeRoadSnapshot({ limit, calendarYear });
    success(res, data);
  } catch (err) {
    handleLifeRoadError(err, res, next);
  }
});

/** 其它域占位：明确 404，避免误用万能路径 */
router.get('/agent/snapshot/:domain', (req, res) => {
  const domain = String(req.params.domain || '').trim();
  res.status(404).json({
    code: -1,
    message: `agent snapshot domain 未实现: ${domain}`,
    data: null,
  });
});

export default router;
