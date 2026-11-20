import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import { syncWriteOptionsFromReq } from '../../utils/device-id-from-req.js';
import {
  HealthError,
  createIntake,
  deleteIntake,
  getDayHealthMetrics,
  getDayTargets,
  listIntakesByDay,
  listRecentIntakes,
  updateIntake,
  upsertIntakeTargets,
} from '../../services/health.js';
import {
  WeightLogError,
  listWeightLogs,
  upsertWeightLog,
} from '../../services/weight-logs.js';

const router = Router();

router.use(requireAuth);

const handleHealthError = createDomainErrorHandler([HealthError, WeightLogError]);

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
    const data = await createIntake(
      {
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
      },
      syncWriteOptionsFromReq(req),
    );
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
    const data = await updateIntake(
      String(req.params.id ?? ''),
      {
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
      },
      syncWriteOptionsFromReq(req),
    );
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
    const data = await updateIntake(String(req.params.id ?? ''), body, {
      ...syncWriteOptionsFromReq(req),
    });
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
    const data = await deleteIntake(String(req.params.id ?? ''), {
      ...syncWriteOptionsFromReq(req),
    });
    success(res, data, '删除成功');
  } catch (err) {
    handleHealthError(err, res, next);
  }
});

/**
 * GET /health/targets?date=YYYY-MM-DD
 * 查询摄入目标（日表 → 全局设置 → 默认）
 */
router.get('/health/targets', async (req, res, next) => {
  try {
    const data = await getDayTargets({
      date: req.query.date ?? undefined,
    });
    success(res, data);
  } catch (err) {
    handleHealthError(err, res, next);
  }
});

/**
 * PUT /health/targets
 * 写入全局四项目标 + upsert 指定日（默认今日）health_daily_targets
 */
router.put('/health/targets', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await upsertIntakeTargets(
      {
        date: body.date ?? body.day_ymd ?? body.dayYmd,
        hydration: body.hydration,
        hydration_ml: body.hydration_ml ?? body.hydrationMl,
        hydrationMl: body.hydrationMl,
        protein: body.protein,
        protein_g: body.protein_g ?? body.proteinG,
        proteinG: body.proteinG,
        carbohydrate: body.carbohydrate,
        carbohydrate_g: body.carbohydrate_g ?? body.carbohydrateG,
        carbohydrateG: body.carbohydrateG,
        calories: body.calories,
        calories_kcal: body.calories_kcal ?? body.caloriesKcal,
        caloriesKcal: body.caloriesKcal,
        rationale_zh: body.rationale_zh,
        source: body.source,
      },
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '已更新摄入目标');
  } catch (err) {
    handleHealthError(err, res, next);
  }
});

/**
 * GET /health/weight-logs?days=30 | start_ymd=&end_ymd=
 * 近 N 天体重点（含趋势 delta）
 */
router.get('/health/weight-logs', async (req, res, next) => {
  try {
    const data = await listWeightLogs({
      days: req.query.days,
      start_ymd: req.query.start_ymd ?? req.query.startYmd,
      end_ymd: req.query.end_ymd ?? req.query.endYmd,
    });
    success(res, data);
  } catch (err) {
    handleHealthError(err, res, next);
  }
});

/**
 * POST /health/weight-logs
 * 同日覆盖；若为最新日则同步 users.weight
 */
router.post('/health/weight-logs', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await upsertWeightLog(
      {
        id: body.id,
        recorded_ymd: body.recorded_ymd ?? body.ymd ?? body.record_date,
        weight_kg: body.weight_kg ?? body.weight,
      },
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '已记录体重');
  } catch (err) {
    handleHealthError(err, res, next);
  }
});

export default router;
