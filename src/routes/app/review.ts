import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { fail, success } from '../../utils/response.js';
import { parseStringQuery } from './pages/query.js';
import {
  ReviewPageError,
  getReviewCatalog,
  getReviewDaily,
  getReviewHome,
  getReviewMonthly,
  getReviewWeekMetrics,
  getReviewWeekly,
} from '../../services/pages/review.js';

/**
 * 复盘 Tab / 复盘子页专用接口。
 * 挂载前缀：/api 与 /api/app
 * APP 只打 /api/pages/review/* ，不要再为读路径降级到 /api/data/* List。
 */
const router = Router();

router.use(requireAuth);

function handleReviewError(
  err: unknown,
  res: Parameters<typeof fail>[0],
  next: (err: unknown) => void,
) {
  if (err instanceof ReviewPageError) {
    return fail(res, err.message, -1, err.status);
  }
  next(err);
}

/** GET /pages/review/home — 复盘 Tab 冷启动 / 下拉刷新 */
router.get('/pages/review/home', async (req, res, next) => {
  try {
    const data = await getReviewHome({
      logicalToday: parseStringQuery(req.query.logicalToday),
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

/** GET /pages/review/catalog — 模板（dimensions + columns） */
router.get('/pages/review/catalog', async (req, res, next) => {
  try {
    const data = await getReviewCatalog({
      scope: parseStringQuery(req.query.scope),
    });
    success(res, data);
  } catch (err) {
    handleReviewError(err, res, next);
  }
});

/** GET /pages/review/daily — 日刊按日期区间 */
router.get('/pages/review/daily', async (req, res, next) => {
  try {
    const data = await getReviewDaily({
      start: parseStringQuery(req.query.start)?.trim() ?? '',
      end: parseStringQuery(req.query.end)?.trim() ?? '',
    });
    success(res, data);
  } catch (err) {
    handleReviewError(err, res, next);
  }
});

/** GET /pages/review/weekly — 周刊按 weekStart 或区间 */
router.get('/pages/review/weekly', async (req, res, next) => {
  try {
    const data = await getReviewWeekly({
      weekStart: parseStringQuery(req.query.weekStart),
      start: parseStringQuery(req.query.start),
      end: parseStringQuery(req.query.end),
    });
    success(res, data);
  } catch (err) {
    handleReviewError(err, res, next);
  }
});

/** GET /pages/review/monthly — 月刊按 monthStart 或区间 */
router.get('/pages/review/monthly', async (req, res, next) => {
  try {
    const data = await getReviewMonthly({
      monthStart: parseStringQuery(req.query.monthStart),
      start: parseStringQuery(req.query.start),
      end: parseStringQuery(req.query.end),
    });
    success(res, data);
  } catch (err) {
    handleReviewError(err, res, next);
  }
});

/** GET /pages/review/week-metrics — 旧周复盘表单聚合指标 */
router.get('/pages/review/week-metrics', async (req, res, next) => {
  try {
    const data = await getReviewWeekMetrics({
      start: parseStringQuery(req.query.start)?.trim() ?? '',
      end: parseStringQuery(req.query.end)?.trim() ?? '',
      rangeKind: parseStringQuery(req.query.rangeKind),
    });
    success(res, data);
  } catch (err) {
    handleReviewError(err, res, next);
  }
});

export default router;
