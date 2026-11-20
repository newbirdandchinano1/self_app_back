import { Router, type Request } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import { syncWriteOptionsFromReq } from '../../utils/device-id-from-req.js';
import { parseBoolQuery, parseIntQuery, parseStringQuery } from './pages/query.js';
import {
  FinancePageError,
  getFinanceAccountDetail,
  getFinanceCashFlow,
  getFinanceCatalog,
  getFinanceDailySummaries,
  getFinanceHome,
  getFinanceInsights,
  getFinancePredictedSavings,
  getFinanceRecentDays,
  getFinanceStats,
  getFinanceTransactions,
} from '../../services/pages/finance.js';
import {
  FinanceTxnError,
  createFinanceTransaction,
  deleteFinanceTransaction,
  updateFinanceTransaction,
} from '../../services/finance-transactions.js';
import {
  clearFinanceSavingsGoal,
  clearMonthBudgetSetting,
  getFinanceBudgetSummary,
  getFinanceSavingsGoalSummary,
  setBudgetRefreshDay,
  upsertFinanceSavingsGoal,
  upsertMonthBudgetSetting,
} from '../../services/finance-budget.js';

/**
 * 财务 Tab / 财务子页专用接口。
 * 挂载前缀：/api/app
 * APP 只打 /api/app/pages/finance/* ，不要再为读路径降级到 /api/app/data/* List。
 * 预算 / 储蓄目标另有 /api/app/finance/budget|savings-goal（Agent + 设置读写）。
 */
const router = Router();

router.use(requireAuth);

const handleFinanceError = createDomainErrorHandler([FinancePageError, FinanceTxnError]);

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

/** POST /pages/finance/transactions — 新增流水 */
router.post('/pages/finance/transactions', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await createFinanceTransaction(body, syncWriteOptionsFromReq(req));
    success(res, data, '创建成功');
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** PUT /pages/finance/transactions/:id — 更新流水 */
router.put('/pages/finance/transactions/:id', async (req, res, next) => {
  try {
    const data = await updateFinanceTransaction(String(req.params.id ?? ''), req.body ?? {}, {
      ...syncWriteOptionsFromReq(req),
    });
    success(res, data, '更新成功');
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** PATCH /pages/finance/transactions/:id */
router.patch('/pages/finance/transactions/:id', async (req, res, next) => {
  try {
    const data = await updateFinanceTransaction(String(req.params.id ?? ''), req.body ?? {}, {
      ...syncWriteOptionsFromReq(req),
    });
    success(res, data, '更新成功');
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** DELETE /pages/finance/transactions/:id */
router.delete('/pages/finance/transactions/:id', async (req, res, next) => {
  try {
    const data = await deleteFinanceTransaction(String(req.params.id ?? ''), {
      ...syncWriteOptionsFromReq(req),
    });
    success(res, data, '删除成功');
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

/** GET /pages/finance/predicted-savings — 预测存款（近1月纯利润日均 × 目标剩余天数） */
router.get('/pages/finance/predicted-savings', async (req, res, next) => {
  try {
    const data = await getFinancePredictedSavings({
      ...parseDayBoundary(req),
      targetDate: parseStringQuery(req.query.targetDate)?.trim() ?? '',
      logicalToday: parseStringQuery(req.query.logicalToday),
      lookbackDays: parseIntQuery(req.query.lookbackDays),
    });
    success(res, data);
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** GET /finance/budget — 预算结余 / 今日可用 / 周期设置摘要 */
router.get('/finance/budget', async (req, res, next) => {
  try {
    const data = await getFinanceBudgetSummary({
      ...parseDayBoundary(req),
      logicalToday: parseStringQuery(req.query.logicalToday),
    });
    success(res, data);
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** PUT /finance/budget — 设置/调整某月预算（基数、含上周期结余、结余校正） */
router.put('/finance/budget', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await upsertMonthBudgetSetting({
      monthKey: typeof body.month_key === 'string' ? body.month_key : body.monthKey,
      baseAmount:
        body.base_amount != null
          ? Number(body.base_amount)
          : body.baseAmount != null
            ? Number(body.baseAmount)
            : undefined,
      includeLastBalance:
        typeof body.include_last_balance === 'boolean'
          ? body.include_last_balance
          : typeof body.includeLastBalance === 'boolean'
            ? body.includeLastBalance
            : undefined,
      periodSurplusOverride:
        body.period_surplus_override === null || body.periodSurplusOverride === null
          ? null
          : body.period_surplus_override != null
            ? Number(body.period_surplus_override)
            : body.periodSurplusOverride != null
              ? Number(body.periodSurplusOverride)
              : undefined,
      clearSurplusOverride: Boolean(body.clear_surplus_override ?? body.clearSurplusOverride),
      logicalToday: parseStringQuery(req.query.logicalToday) ??
        (typeof body.logical_today === 'string' ? body.logical_today : undefined),
      ...parseDayBoundary(req),
    });
    success(res, data, '预算已保存');
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** DELETE /finance/budget — 撤销某月预算设置 */
router.delete('/finance/budget', async (req, res, next) => {
  try {
    const data = await clearMonthBudgetSetting({
      monthKey: parseStringQuery(req.query.month_key) ?? parseStringQuery(req.query.monthKey),
      logicalToday: parseStringQuery(req.query.logicalToday),
      ...parseDayBoundary(req),
    });
    success(res, data, data.cleared ? '已清除本月预算' : '本月无预算配置');
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** PUT /finance/budget/refresh-day — 设置预算刷新日（每月几日） */
router.put('/finance/budget/refresh-day', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const day = Number(body.refresh_day ?? body.refreshDay ?? body.day);
    const data = await setBudgetRefreshDay(day);
    success(res, data, '预算刷新日已更新');
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** GET /finance/savings-goal — 首页储蓄目标（净资产目标日） */
router.get('/finance/savings-goal', async (req, res, next) => {
  try {
    const data = await getFinanceSavingsGoalSummary({
      ...parseDayBoundary(req),
      logicalToday: parseStringQuery(req.query.logicalToday),
    });
    success(res, data);
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** PUT /finance/savings-goal — 设置/编辑储蓄目标 */
router.put('/finance/savings-goal', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await upsertFinanceSavingsGoal({
      targetAmount: Number(body.target_amount ?? body.targetAmount),
      targetDate: String(body.target_date ?? body.targetDate ?? ''),
      logicalToday: parseStringQuery(req.query.logicalToday) ??
        (typeof body.logical_today === 'string' ? body.logical_today : undefined),
      ...parseDayBoundary(req),
    });
    success(res, data, '储蓄目标已保存');
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

/** DELETE /finance/savings-goal — 清除储蓄目标 */
router.delete('/finance/savings-goal', async (req, res, next) => {
  try {
    const data = await clearFinanceSavingsGoal();
    success(res, data, '已清除储蓄目标');
  } catch (err) {
    handleFinanceError(err, res, next);
  }
});

export default router;
