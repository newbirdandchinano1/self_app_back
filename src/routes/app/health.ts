import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import {
  HealthError,
  createIntake,
  deleteIntake,
  getDayHealthMetrics,
  listIntakesByDay,
  listRecentIntakes,
  updateIntake,
} from '../../services/health.js';

const router = Router();

router.use(requireAuth);

const handleHealthError = createDomainErrorHandler(HealthError);

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
 * GET /health/intakes?date=YYYY-MM-DD — 某日摄入列表
 * GET /health/intakes?days=7|30 — 近 N 天摄入（含今天）
 * 无 date/days 时默认近 30 天，避免页面同步漏参时报「请传 date」
 */
router.get('/health/intakes', async (req, res, next) => {
  try {
    const daysRaw = req.query.days;
    if (daysRaw != null && daysRaw !== '') {
      const days = typeof daysRaw === 'string' ? Number(daysRaw) : Number(daysRaw);
      const data = await listRecentIntakes({ days });
      return success(res, data);
    }
    const dateRaw = req.query.date;
    if (dateRaw == null || dateRaw === '') {
      const data = await listRecentIntakes({ days: 30 });
      return success(res, data);
    }
    const data = await listIntakesByDay({
      date: dateRaw,
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

/**
 * PUT /health/intakes/:id
 * 更新摄入记录
 */
router.put('/health/intakes/:id', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await updateIntake(String(req.params.id ?? ''), {
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
    success(res, data, '更新成功');
  } catch (err) {
    handleHealthError(err, res, next);
  }
});

/**
 * PATCH /health/intakes/:id — 同 PUT（字段级更新）
 */
router.patch('/health/intakes/:id', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await updateIntake(String(req.params.id ?? ''), body);
    success(res, data, '更新成功');
  } catch (err) {
    handleHealthError(err, res, next);
  }
});

/**
 * DELETE /health/intakes/:id
 */
router.delete('/health/intakes/:id', async (req, res, next) => {
  try {
    const data = await deleteIntake(String(req.params.id ?? ''));
    success(res, data, '删除成功');
  } catch (err) {
    handleHealthError(err, res, next);
  }
});

export default router;
