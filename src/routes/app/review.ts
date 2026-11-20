import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import { syncWriteOptionsFromReq } from '../../utils/device-id-from-req.js';
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
import { getReviewDayFactsSummary } from '../../services/review-facts.js';
import {
  fillEmptyReviewJournal,
  patchReviewJournalFields,
} from '../../services/review-journal-write.js';
import { getReviewSettings, putReviewSettings } from '../../services/review-settings.js';

/**
 * 复盘 Tab / 复盘子页专用接口。
 * 挂载前缀：/api/app
 * APP 只打 /api/app/pages/review/* ，不要再为读路径降级到 /api/app/data/* List。
 * 事实写入 / 设置另有 /api/app/review/*（Agent + 语义读写）。
 */
const router = Router();

router.use(requireAuth);

const handleReviewError = createDomainErrorHandler(ReviewPageError);

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

/** GET /review/day-facts — 当日健康/任务/财务事实（一键写入素材） */
router.get('/review/day-facts', async (req, res, next) => {
  try {
    const data = await getReviewDayFactsSummary({
      ymd: parseStringQuery(req.query.ymd) ?? parseStringQuery(req.query.date),
      logicalToday: parseStringQuery(req.query.logicalToday),
    });
    success(res, data);
  } catch (err) {
    handleReviewError(err, res, next);
  }
});

/**
 * POST /review/fill-empty — 空栏写入事实（日）或 rollup（周/月）
 * body: { scope, period_ymd?, ymd?, columns?, replace? }
 */
router.post('/review/fill-empty', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await fillEmptyReviewJournal(body, syncWriteOptionsFromReq(req));
    success(
      res,
      data,
      data.skipped ? '无需写入' : '已写入空栏',
    );
  } catch (err) {
    handleReviewError(err, res, next);
  }
});

/**
 * PATCH /review/journal — 按栏目 id 合并写入正文
 * body: { scope, period_ymd, fields: { columnId: text }, only_empty? }
 */
router.patch('/review/journal', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await patchReviewJournalFields(body, syncWriteOptionsFromReq(req));
    success(res, data, data.changed_columns.length ? '复盘已更新' : '无变更');
  } catch (err) {
    handleReviewError(err, res, next);
  }
});

/** GET /review/settings — 周复盘日 / 提醒 / 积分规则 */
router.get('/review/settings', async (_req, res, next) => {
  try {
    const data = await getReviewSettings();
    success(res, data);
  } catch (err) {
    handleReviewError(err, res, next);
  }
});

/** PUT /review/settings — 部分更新复盘设置 */
router.put('/review/settings', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await putReviewSettings(body);
    success(res, data, '复盘设置已保存');
  } catch (err) {
    handleReviewError(err, res, next);
  }
});

export default router;
