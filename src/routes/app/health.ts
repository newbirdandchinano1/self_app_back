import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success, fail } from '../../utils/response.js';
import {
  HealthError,
  createIntake,
  getDayHealthMetrics,
  listIntakesByDay,
  listRecentIntakes,
} from '../../services/health.js';

const router = Router();

router.use(requireAuth);

function handleHealthError(
  err: unknown,
  res: Parameters<typeof fail>[0],
  next: (err: unknown) => void,
) {
  if (err instanceof HealthError) {
    return fail(res, err.message, -1, err.status);
  }
  next(err);
}

/**
 * GET /health/metrics?date=YYYY-MM-DD
 * 查询某日健康指标（水分 / 蛋白质 / 热量 / 碳水合计 + 日目标）
 * 兼容旧客户端：忽略 query.user_id
 */
router.get('/health/metrics', async (req, res, next) => {
  try {
    const data = await getDayHealthMetrics({
      date: req.query.date,
    });
    success(res, data);
  } catch (err) {
    handleHealthError(err, res, next);
  }
});

/**
 * GET /health/intakes/last-7-days
 * 近 7 天摄入记录（须写在 /health/intakes 带 date 之前无冲突，独立路径）
 */
router.get('/health/intakes/last-7-days', async (req, res, next) => {
  try {
    const data = await listRecentIntakes({ days: 7 });
    success(res, data);
  } catch (err) {
    handleHealthError(err, res, next);
  }
});

/**
 * GET /health/intakes/last-30-days
 * 近 30 天摄入记录
 */
router.get('/health/intakes/last-30-days', async (req, res, next) => {
  try {
    const data = await listRecentIntakes({ days: 30 });
    success(res, data);
  } catch (err) {
    handleHealthError(err, res, next);
  }
});

/**
 * GET /health/intakes?date=YYYY-MM-DD
 * 查询某日摄入记录列表
 */
router.get('/health/intakes', async (req, res, next) => {
  try {
    const data = await listIntakesByDay({
      date: req.query.date,
    });
    success(res, data);
  } catch (err) {
    handleHealthError(err, res, next);
  }
});

/**
 * POST /health/intakes
 * 新增摄入记录（兼容旧客户端：忽略 body.user_id）
 */
router.post('/health/intakes', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await createIntake({
      id: body.id,
      hydration: body.hydration,
      protein: body.protein,
      sodium: body.sodium,
      carbohydrate: body.carbohydrate,
      calories: body.calories,
      record_date: body.record_date,
      quick_add_key: body.quick_add_key,
      source_image_uri: body.source_image_uri,
      intake_display_title: body.intake_display_title,
      intake_ai_comment: body.intake_ai_comment,
    });
    success(res, data, '创建成功');
  } catch (err) {
    handleHealthError(err, res, next);
  }
});

export default router;
