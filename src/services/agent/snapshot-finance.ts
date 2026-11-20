/**
 * Agent 只读财务快照：字段白名单，一次 HTTP 够用。
 * 挂载：GET /api/app/agent/snapshot/finance
 */
import {
  FinancePageError,
  getFinanceHome,
  getFinanceInsights,
  type FinanceDayBoundaryParams,
} from '../pages/finance.js';
import {
  getFinanceBudgetSummary,
  getFinanceSavingsGoalSummary,
} from '../finance-budget.js';

const RECENT_TXN_LIMIT = 12;
const SCHEDULED_LIMIT = 8;
const ACCOUNT_LIMIT = 20;

export type AgentFinanceSnapshotParams = FinanceDayBoundaryParams & {
  logicalToday?: string;
  budgetRefreshDay?: number;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function typeLabel(txnType: unknown): string {
  const t = String(txnType ?? '').trim().toLowerCase();
  if (t === 'income') return '收入';
  if (t === 'transfer') return '转账';
  if (t === 'expense') return '支出';
  return t || '流水';
}

function trimTxn(row: Record<string, unknown>) {
  const amountRaw = row.amount;
  const amount = typeof amountRaw === 'number' ? Math.abs(amountRaw) : Number(amountRaw);
  return {
    id: row.id == null ? null : String(row.id),
    name: String(row.name ?? '').trim() || '未命名',
    amount: Number.isFinite(amount) ? amount : 0,
    transaction_type: String(row.transaction_type ?? '').trim() || null,
    type_label: typeLabel(row.transaction_type),
    happened_at: row.happened_at == null ? null : String(row.happened_at),
  };
}

function trimScheduled(row: Record<string, unknown>) {
  const amountRaw = row.amount;
  const amount = typeof amountRaw === 'number' ? Math.abs(amountRaw) : Number(amountRaw);
  return {
    id: row.id == null ? null : String(row.id),
    name: String(row.name ?? '').trim() || '定时支出',
    amount: Number.isFinite(amount) ? amount : 0,
    due_ymd:
      row.next_due_ymd == null && row.due_ymd == null
        ? null
        : String(row.next_due_ymd ?? row.due_ymd ?? ''),
    enabled: row.enabled !== false && row.enabled !== 0,
  };
}

function trimAccount(row: Record<string, unknown>) {
  return {
    id: row.id == null ? null : String(row.id),
    name: String(row.name ?? '').trim() || '账户',
  };
}

export async function getAgentFinanceSnapshot(params: AgentFinanceSnapshotParams = {}) {
  const dayBoundary = {
    dayBoundaryHour: params.dayBoundaryHour,
    dayBoundaryMinute: params.dayBoundaryMinute,
    logicalToday: params.logicalToday,
  };
  const [home, insights, budget, savingsGoal] = await Promise.all([
    getFinanceHome({
      ...dayBoundary,
      historyDays: 3,
      daysBack: 40,
      budgetRefreshDay: params.budgetRefreshDay,
    }),
    getFinanceInsights({
      ...dayBoundary,
      months: 1,
    }).catch(() => null),
    getFinanceBudgetSummary(dayBoundary).catch(() => null),
    getFinanceSavingsGoalSummary(dayBoundary).catch(() => null),
  ]);

  const meta = asRecord(home.meta) ?? {};
  const today = String(meta.logicalToday ?? params.logicalToday ?? '').trim() || null;
  const monthKey = today && today.length >= 7 ? today.slice(0, 7) : null;

  const monthly = asRecord(home.monthly) ?? {};
  const monthIncome = Number(monthly.income) || 0;
  const monthExpense = Number(monthly.expense) || 0;

  const txns = Array.isArray(home.transactions) ? home.transactions : [];
  const recent = txns
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => !!row)
    .filter((row) => {
      const t = String(row.transaction_type ?? '').toLowerCase();
      return t === 'expense' || t === 'income' || t === 'transfer';
    })
    .slice(0, RECENT_TXN_LIMIT)
    .map(trimTxn);

  const scheduledRaw = Array.isArray(home.scheduledExpenses) ? home.scheduledExpenses : [];
  const upcoming = scheduledRaw
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => !!row)
    .filter((row) => row.enabled !== false && row.enabled !== 0)
    .slice(0, SCHEDULED_LIMIT)
    .map(trimScheduled);

  const accountsRaw = Array.isArray(home.accounts) ? home.accounts : [];
  const accounts = accountsRaw
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => !!row)
    .slice(0, ACCOUNT_LIMIT)
    .map(trimAccount);

  const categoryTop =
    insights && Array.isArray(insights.categoryTop)
      ? insights.categoryTop.slice(0, 5).map((row) => ({
          name: String(row.name ?? '').trim() || '未分类',
          amount: Number(row.amount) || 0,
        }))
      : [];

  return {
    domain: 'finance',
    today_ymd: today,
    month_key: monthKey,
    month_income: monthIncome,
    month_expense: monthExpense,
    month_net: Math.round((monthIncome - monthExpense) * 100) / 100,
    net_worth: typeof home.netWorth === 'number' ? home.netWorth : null,
    recent_txns: recent,
    upcoming_scheduled: upcoming,
    accounts,
    category_top: categoryTop,
    budget: budget
      ? {
          configured: budget.configured,
          month_key: budget.month_key,
          refresh_day: budget.refresh_day,
          base_amount: budget.base_amount,
          include_last_balance: budget.include_last_balance,
          period_total: budget.period_total,
          period_expense: budget.period_expense,
          period_remaining: budget.period_remaining,
          today_available: budget.today_available,
          daily_budget: budget.daily_budget,
          scheduled_deduction: budget.scheduled_deduction,
          days_left: budget.days_left,
        }
      : null,
    savings_goal: savingsGoal
      ? {
          goal: savingsGoal.goal,
          net_worth: savingsGoal.net_worth,
          gap: savingsGoal.gap,
          days_left: savingsGoal.days_left,
          daily_target: savingsGoal.daily_target,
          achieved: savingsGoal.achieved,
          overdue: savingsGoal.overdue,
        }
      : null,
    note: '权威账本只读摘要；含服务端预算结余/今日可用与首页储蓄目标。',
    meta: {
      serverTime: meta.serverTime ?? null,
      logicalToday: today,
    },
  };
}

export { FinancePageError };
