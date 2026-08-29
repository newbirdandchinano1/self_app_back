import { Router, type Request } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { fail, success } from '../../utils/response.js';
import { parseBoolQuery, parseIntQuery, parseStringQuery } from './pages/query.js';
import {
  FinancePageError,
  getFinanceAccountDetail,
  getFinanceCashFlow,
  getFinanceCatalog,
  getFinanceDailySummaries,
  getFinanceHome,
  getFinanceInsights,
  getFinanceRecentDays,
  getFinanceStats,
  getFinanceTransactions,
} from '../../services/pages/finance.js';

/**
 * 财务 Tab / 财务子页专用接口。
 * 挂载前缀：/api 与 /api/app
 * APP 只打 /api/pages/finance/* ，不要再为读路径降级到 /api/data/* List。
 */
const router = Router();

router.use(requireAuth);

function handleFinanceError(
  err: unknown,
  res: Parameters<typeof fail>[0],
  next: (err: unknown) => void,
) {
  if (err instanceof FinancePageError) {
    return fail(res, err.message, -1, err.status);
  }
  next(err);
}

function parseDayBoundary(req: Request) {
  return {
    dayBoundaryHour: parseIntQuery(req.query.dayBoundaryHour) ?? 0,
    dayBoundaryMinute: parseIntQuery(req.query.dayBoundaryMinute) ?? 0,
  };
}

/** GET /pages/finance/home — 财务 Tab 首屏 */
router.get('/pages/finance/home', async (req, res, next) => {
  try {
    const data = await getFinanceHome({
      ...parseDayBoundary(req),
      logicalToday: parseStringQuery(req.query.logicalToday),
      historyDays: parseIntQuery(req.query.historyDays),
      daysBack: parseIntQuery(req.query.daysBack),
      budgetRefreshDay: parseIntQuery(req.query.budgetRefreshDay),
    });
    success(res, data);
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** GET /pages/finance/catalog — 资产页 / 分类 / 账户类型 */
router.get('/pages/finance/catalog', async (_req, res, next) => {
  try {
    const data = await getFinanceCatalog();
    success(res, data);
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** GET /pages/finance/recent-days — 首页触底更早流水 */
router.get('/pages/finance/recent-days', async (req, res, next) => {
  try {
    const before = parseStringQuery(req.query.before)?.trim() ?? '';
    const data = await getFinanceRecentDays({
      ...parseDayBoundary(req),
      before,
      days: parseIntQuery(req.query.days),
    });
    success(res, data);
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** GET /pages/finance/transactions — 统计 / 日历单日 / 按账户 */
router.get('/pages/finance/transactions', async (req, res, next) => {
  try {
    const start = parseStringQuery(req.query.start)?.trim() ?? '';
    const end = parseStringQuery(req.query.end)?.trim() ?? '';
    const data = await getFinanceTransactions({
      ...parseDayBoundary(req),
      start,
      end,
      accountId: parseStringQuery(req.query.accountId),
      page: parseIntQuery(req.query.page),
      limit: parseIntQuery(req.query.limit),
      excludeCorrections: parseBoolQuery(req.query.excludeCorrections),
    });
    success(res, data);
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** GET /pages/finance/daily-summaries — 财务日历月网格 */
router.get('/pages/finance/daily-summaries', async (req, res, next) => {
  try {
    const start = parseStringQuery(req.query.start)?.trim() ?? '';
    const end = parseStringQuery(req.query.end)?.trim() ?? '';
    const data = await getFinanceDailySummaries({
      ...parseDayBoundary(req),
      start,
      end,
    });
    success(res, data);
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** GET /pages/finance/account-detail — 账户详情（含该账户全历史流水） */
router.get('/pages/finance/account-detail', async (req, res, next) => {
  try {
    const data = await getFinanceAccountDetail({
      accountId: parseStringQuery(req.query.accountId),
      accountName: parseStringQuery(req.query.accountName),
    });
    success(res, data);
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** GET /pages/finance/cash-flow — 现金流台账 */
router.get('/pages/finance/cash-flow', async (_req, res, next) => {
  try {
    const data = await getFinanceCashFlow();
    success(res, data);
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** GET /pages/finance/insights — 现金流洞察聚合（不回传全量流水） */
router.get('/pages/finance/insights', async (req, res, next) => {
  try {
    const data = await getFinanceInsights({
      ...parseDayBoundary(req),
      months: parseIntQuery(req.query.months),
      logicalToday: parseStringQuery(req.query.logicalToday),
    });
    success(res, data);
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** GET /pages/finance/stats — 财务统计页聚合（不回传全量流水） */
router.get('/pages/finance/stats', async (req, res, next) => {
  try {
    const start = parseStringQuery(req.query.start)?.trim() ?? '';
    const end = parseStringQuery(req.query.end)?.trim() ?? '';
    const granularityRaw = parseStringQuery(req.query.granularity)?.trim();
    const categoryModeRaw = parseStringQuery(req.query.categoryMode)?.trim();
    const rankModeRaw = parseStringQuery(req.query.rankMode)?.trim();
    const data = await getFinanceStats({
      ...parseDayBoundary(req),
      start,
      end,
      granularity:
        granularityRaw === 'day' || granularityRaw === 'month' || granularityRaw === 'auto'
          ? granularityRaw
          : undefined,
      categoryMode:
        categoryModeRaw === 'expense' || categoryModeRaw === 'income' || categoryModeRaw === 'both'
          ? categoryModeRaw
          : undefined,
      rankMode:
        rankModeRaw === 'expense' || rankModeRaw === 'income' || rankModeRaw === 'both'
          ? rankModeRaw
          : undefined,
      rankLimit: parseIntQuery(req.query.rankLimit),
      recentDaysLimit: parseIntQuery(req.query.recentDaysLimit),
      excludeCorrections: parseBoolQuery(req.query.excludeCorrections),
    });
    success(res, data);
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

export default router;
