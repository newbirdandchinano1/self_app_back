/**
 * 财务预算 / 首页储蓄目标：专用读写（app_settings 语义键 + 流水/定时聚合）。
 * 供 Agent 代查预算结余 / 今日可用，以及确认后写入对齐。
 */
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import { formatUtcMySQLDateTime } from './calendar/logical-day.js';
import { addDaysToYmd, isValidYmd, ymdToLocalDate } from '../utils/ymd.js';
import {
  balanceCorrectionSql,
  budgetCycleStart,
  clampBudgetRefreshDay,
  FinancePageError,
  getFinanceNetWorth,
  logicalDaySql,
  previousBudgetCycleStart,
  resolveLogicalToday,
  type FinanceDayBoundaryParams,
} from './pages/finance.js';
import { getTableMeta } from './crud.js';

export { FinancePageError as FinanceBudgetError };

const KEYS = {
  monthlyBudget: '@finance_monthly_budget_settings_v2',
  budgetRefreshDay: '@finance_budget_refresh_day_v1',
  savingsGoal: '@finance_savings_goal_v1',
} as const;

const TXN_TABLE = 'finance_transactions';
const SCHEDULED_TABLE = 'finance_scheduled_expenses';
const DEFAULT_REFRESH_DAY = 1;
const SAVINGS_GOAL_MAX = 99_999_999;

export type MonthBudgetSetting = {
  baseAmount: number;
  includeLastBalance: boolean;
  periodSurplusOverride?: number;
};

export type FinanceSavingsGoal = {
  targetAmount: number;
  targetDate: string;
};

function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function parseJsonValue(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readSetting(key: string): Promise<unknown> {
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT value_json FROM app_settings WHERE `key` = ? LIMIT 1',
    [key],
  );
  return parseJsonValue(rows[0]?.value_json);
}

async function writeSetting(key: string, value: unknown): Promise<void> {
  const payload = JSON.stringify(value);
  const now = formatUtcMySQLDateTime(new Date());
  await db.query<ResultSetHeader>(
    `INSERT INTO app_settings (\`key\`, value_json, updated_at, sync_status)
     VALUES (?, ?, ?, 'synced')
     ON DUPLICATE KEY UPDATE
       value_json = VALUES(value_json),
       updated_at = VALUES(updated_at),
       sync_status = 'synced'`,
    [key, payload, now],
  );
}

async function deleteSetting(key: string): Promise<void> {
  await db.query<ResultSetHeader>('DELETE FROM app_settings WHERE `key` = ?', [key]);
}

function activeWhereSql(columns: Set<string>, alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  const parts: string[] = [];
  if (columns.has('deleted_at')) parts.push(`${prefix}deleted_at IS NULL`);
  if (columns.has('sync_status')) {
    parts.push(`(${prefix}sync_status IS NULL OR ${prefix}sync_status != 'pending_delete')`);
  }
  return parts.length > 0 ? parts.join(' AND ') : '1=1';
}

/** 不计入预算：转账腿 / exclude_from_budget / 余额校正 / 历史固定支出 id */
function excludeFromBudgetSql(alias = ''): string {
  const p = alias ? `${alias}.` : '';
  const extra = alias ? `${alias}.extra_data` : 'extra_data';
  const extract = (path: string) => `IF(JSON_VALID(${extra}), JSON_EXTRACT(${extra}, '${path}'), NULL)`;
  const unquote = (path: string) =>
    `IF(JSON_VALID(${extra}), JSON_UNQUOTE(JSON_EXTRACT(${extra}, '${path}')), NULL)`;
  return `(
    ${p}transaction_type = 'transfer'
    OR COALESCE(${unquote('$.transfer_leg')}, '') IN ('out', 'in')
    OR COALESCE(${unquote('$.transferLeg')}, '') IN ('out', 'in')
    OR COALESCE(${extract('$.exclude_from_budget')}, FALSE) = TRUE
    OR COALESCE(${unquote('$.exclude_from_budget')}, '') IN ('true', '1')
    OR COALESCE(${unquote('$.budget_fixed_expense_id')}, '') != ''
    OR ${balanceCorrectionSql(alias)}
  )`;
}

function normalizeMonthSettings(raw: unknown): Record<string, MonthBudgetSetting> {
  const out: Record<string, MonthBudgetSetting> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const o = v as Record<string, unknown>;
    const base = typeof o.baseAmount === 'number' ? o.baseAmount : Number(o.baseAmount);
    const inc = o.includeLastBalance;
    if (!Number.isFinite(base) || base < 0 || typeof inc !== 'boolean') continue;
    const surplus = o.periodSurplusOverride;
    out[k] = {
      baseAmount: roundMoney(base),
      includeLastBalance: inc,
      ...(typeof surplus === 'number' && Number.isFinite(surplus)
        ? { periodSurplusOverride: roundMoney(surplus) }
        : {}),
    };
  }
  return out;
}

export async function loadBudgetRefreshDay(): Promise<number> {
  const raw = await readSetting(KEYS.budgetRefreshDay);
  if (raw == null) return DEFAULT_REFRESH_DAY;
  return clampBudgetRefreshDay(typeof raw === 'number' ? raw : Number(raw));
}

export async function loadMonthBudgetSettings(): Promise<Record<string, MonthBudgetSetting>> {
  return normalizeMonthSettings(await readSetting(KEYS.monthlyBudget));
}

export function normalizeFinanceSavingsGoal(raw: unknown): FinanceSavingsGoal | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const amount =
    typeof o.targetAmount === 'number'
      ? o.targetAmount
      : typeof o.targetAmount === 'string'
        ? parseFloat(o.targetAmount)
        : NaN;
  const targetDate = typeof o.targetDate === 'string' ? o.targetDate.trim() : '';
  if (!Number.isFinite(amount) || amount <= 0 || !isValidYmd(targetDate)) return null;
  return {
    targetAmount: Math.min(SAVINGS_GOAL_MAX, roundMoney(amount)),
    targetDate,
  };
}

export async function loadFinanceSavingsGoal(): Promise<FinanceSavingsGoal | null> {
  return normalizeFinanceSavingsGoal(await readSetting(KEYS.savingsGoal));
}

function monthKeyFromCycleStart(cycleStartYmd: string): string {
  return cycleStartYmd.slice(0, 7);
}

function nextBudgetCycleStart(periodStartYmd: string, refreshDay: number): string {
  const parsed = periodStartYmd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parsed) return periodStartYmd;
  let y = Number(parsed[1]);
  let m = Number(parsed[2]) + 1;
  if (m > 12) {
    m = 1;
    y += 1;
  }
  const day = clampBudgetRefreshDay(refreshDay);
  const last = new Date(y, m, 0).getDate();
  const d = Math.min(day, last);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysLeftIncludingToday(todayYmd: string, periodEndExclusive: string): number {
  const t0 = ymdToLocalDate(todayYmd);
  const endEx = ymdToLocalDate(periodEndExclusive);
  if (!t0 || !endEx) return 1;
  const last = new Date(endEx);
  last.setDate(last.getDate() - 1);
  const diff = Math.round((last.getTime() - t0.getTime()) / 86400000) + 1;
  return Math.max(1, diff);
}

function weekdayMonAs1(ymd: string): number {
  const d = ymdToLocalDate(ymd);
  if (!d) return 1;
  return ((d.getDay() + 6) % 7) + 1;
}

function parseDaysJson(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n >= 1 && n <= 31);
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n >= 1 && n <= 31);
      }
    } catch {
      /* ignore */
    }
  }
  return [];
}

function isScheduledDueOnDay(row: {
  repeat_option: string;
  weekly_days: unknown;
  monthly_days: unknown;
}, ymd: string): boolean {
  const opt = String(row.repeat_option || 'daily').toLowerCase();
  if (opt === 'daily' || opt === '每天') return true;
  if (opt === 'weekly' || opt === '每周') {
    const days = parseDaysJson(row.weekly_days);
    return days.length > 0 && days.includes(weekdayMonAs1(ymd));
  }
  if (opt === 'monthly' || opt === '每月') {
    const days = parseDaysJson(row.monthly_days);
    const dom = Number(ymd.slice(8, 10));
    return days.length > 0 && days.includes(dom);
  }
  return false;
}

async function sumBudgetSideInRange(
  logicalDayExpr: string,
  startYmd: string,
  endExclusiveYmd: string,
  side: 'expense' | 'income',
): Promise<number> {
  const meta = await getTableMeta(TXN_TABLE);
  const columns = new Set(meta.columns);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COALESCE(SUM(ABS(COALESCE(amount, 0))), 0) AS total
     FROM ${TXN_TABLE}
     WHERE ${activeWhereSql(columns)}
       AND transaction_type = ?
       AND ${logicalDayExpr} >= ?
       AND ${logicalDayExpr} < ?
       AND NOT ${excludeFromBudgetSql()}`,
    [side, startYmd, endExclusiveYmd],
  );
  return roundMoney(Number(rows[0]?.total) || 0);
}

async function sumTodayBudgetExpense(
  logicalDayExpr: string,
  todayYmd: string,
): Promise<number> {
  const meta = await getTableMeta(TXN_TABLE);
  const columns = new Set(meta.columns);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COALESCE(SUM(ABS(COALESCE(amount, 0))), 0) AS total
     FROM ${TXN_TABLE}
     WHERE ${activeWhereSql(columns)}
       AND transaction_type = 'expense'
       AND ${logicalDayExpr} = ?
       AND NOT ${excludeFromBudgetSql()}`,
    [todayYmd],
  );
  return roundMoney(Number(rows[0]?.total) || 0);
}

/** 上周期结余：上周期收入 − 支出（不计 exclude；与 App lastMonthRemaining 口径一致） */
async function sumPrevPeriodRemaining(
  logicalDayExpr: string,
  prevStart: string,
  prevEndExclusive: string,
): Promise<number> {
  const meta = await getTableMeta(TXN_TABLE);
  const columns = new Set(meta.columns);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT
        COALESCE(SUM(CASE WHEN transaction_type = 'income' THEN ABS(COALESCE(amount, 0)) ELSE 0 END), 0) AS income,
        COALESCE(SUM(CASE WHEN transaction_type = 'expense' THEN ABS(COALESCE(amount, 0)) ELSE 0 END), 0) AS expense
     FROM ${TXN_TABLE}
     WHERE ${activeWhereSql(columns)}
       AND transaction_type IN ('income', 'expense')
       AND ${logicalDayExpr} >= ?
       AND ${logicalDayExpr} < ?
       AND NOT ${balanceCorrectionSql()}`,
    [prevStart, prevEndExclusive],
  );
  const income = Number(rows[0]?.income) || 0;
  const expense = Number(rows[0]?.expense) || 0;
  return roundMoney(Math.max(0, income - expense));
}

async function sumScheduledBudgetDeduction(
  periodStart: string,
  periodEndExclusive: string,
): Promise<number> {
  const meta = await getTableMeta(SCHEDULED_TABLE);
  const columns = new Set(meta.columns);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, amount, repeat_option, weekly_days, monthly_days, times_per_day,
            include_in_budget, enabled
     FROM ${SCHEDULED_TABLE}
     WHERE ${activeWhereSql(columns)}`,
  );

  let total = 0;
  for (const row of rows) {
    if (row.enabled === 0 || row.enabled === false || row.enabled === '0') continue;
    if (row.include_in_budget === 0 || row.include_in_budget === false || row.include_in_budget === '0') {
      continue;
    }
    const amount = Math.abs(Number(row.amount) || 0);
    if (amount <= 0) continue;
    const times = Math.max(1, Math.floor(Number(row.times_per_day) || 1));
    let cursor = periodStart;
    while (cursor < periodEndExclusive) {
      if (
        isScheduledDueOnDay(
          {
            repeat_option: String(row.repeat_option ?? 'daily'),
            weekly_days: row.weekly_days,
            monthly_days: row.monthly_days,
          },
          cursor,
        )
      ) {
        total += amount * times;
      }
      const next = addDaysToYmd(cursor, 1);
      if (!next || next === cursor) break;
      cursor = next;
    }
  }
  return roundMoney(total);
}

function computeDailyFromSurplus(
  periodSurplus: number,
  periodTotalBudget: number,
  daysLeft: number,
): number {
  const days = Math.max(1, daysLeft);
  const dailyFromSurplus = periodSurplus / days;
  if (periodSurplus > 0) {
    const dailyCap = periodTotalBudget / days;
    return Math.min(dailyFromSurplus, dailyCap);
  }
  return dailyFromSurplus;
}

export type FinanceBudgetSummaryParams = FinanceDayBoundaryParams & {
  logicalToday?: string;
};

export async function getFinanceBudgetSummary(params: FinanceBudgetSummaryParams = {}) {
  const logicalToday = resolveLogicalToday(params);
  const boundary = {
    hour: params.dayBoundaryHour ?? 0,
    minute: params.dayBoundaryMinute ?? 0,
  };
  const logicalDayExpr = logicalDaySql({
    hour: boundary.hour,
    minute: boundary.minute,
  });

  const [refreshDay, settings] = await Promise.all([
    loadBudgetRefreshDay(),
    loadMonthBudgetSettings(),
  ]);

  const periodStart = budgetCycleStart(logicalToday, refreshDay);
  const periodEndExclusive = nextBudgetCycleStart(periodStart, refreshDay);
  const prevStart = previousBudgetCycleStart(periodStart, refreshDay);
  const monthKey = monthKeyFromCycleStart(periodStart);
  const setting = settings[monthKey];
  const configured = !!setting;
  const baseAmount = setting?.baseAmount ?? 0;
  const includeLastBalance = setting?.includeLastBalance ?? false;
  const periodSurplusOverride = setting?.periodSurplusOverride;

  const [periodExpense, periodIncome, todayExpense, lastRemaining, scheduledDeduction] =
    await Promise.all([
      sumBudgetSideInRange(logicalDayExpr, periodStart, periodEndExclusive, 'expense'),
      sumBudgetSideInRange(logicalDayExpr, periodStart, periodEndExclusive, 'income'),
      sumTodayBudgetExpense(logicalDayExpr, logicalToday),
      includeLastBalance
        ? sumPrevPeriodRemaining(logicalDayExpr, prevStart, periodStart)
        : Promise.resolve(0),
      sumScheduledBudgetDeduction(periodStart, periodEndExclusive),
    ]);

  const gross = includeLastBalance ? baseAmount + lastRemaining : baseAmount;
  const periodTotal = roundMoney(Math.max(0, gross - scheduledDeduction + periodIncome));
  const autoSurplus = roundMoney(periodTotal - periodExpense);
  const periodRemaining =
    typeof periodSurplusOverride === 'number' && Number.isFinite(periodSurplusOverride)
      ? roundMoney(periodSurplusOverride)
      : autoSurplus;
  const daysLeft = daysLeftIncludingToday(logicalToday, periodEndExclusive);
  const dailyBudget = roundMoney(computeDailyFromSurplus(periodRemaining, periodTotal, daysLeft));
  const todayAvailable = roundMoney(Math.max(0, dailyBudget - todayExpense));

  return {
    domain: 'finance_budget',
    today_ymd: logicalToday,
    month_key: monthKey,
    period_start: periodStart,
    period_end_exclusive: periodEndExclusive,
    days_left: daysLeft,
    refresh_day: refreshDay,
    configured,
    base_amount: baseAmount,
    include_last_balance: includeLastBalance,
    last_period_remaining: lastRemaining,
    scheduled_deduction: scheduledDeduction,
    period_income: periodIncome,
    period_expense: periodExpense,
    period_total: periodTotal,
    period_remaining: periodRemaining,
    period_surplus_auto: autoSurplus,
    period_surplus_override:
      typeof periodSurplusOverride === 'number' ? periodSurplusOverride : null,
    daily_budget: dailyBudget,
    today_expense: todayExpense,
    today_available: todayAvailable,
    note:
      '预算结余 / 今日可用按服务端流水 + app_settings 预算键聚合；与 App 首页预算卡同口径（定时预扣为整周期应发生合计）。',
  };
}

export async function upsertMonthBudgetSetting(input: {
  monthKey?: string;
  baseAmount?: number;
  includeLastBalance?: boolean;
  periodSurplusOverride?: number | null;
  clearSurplusOverride?: boolean;
  logicalToday?: string;
  dayBoundaryHour?: number;
  dayBoundaryMinute?: number;
}) {
  const logicalToday = resolveLogicalToday({
    logicalToday: input.logicalToday,
    dayBoundaryHour: input.dayBoundaryHour,
    dayBoundaryMinute: input.dayBoundaryMinute,
  });
  const refreshDay = await loadBudgetRefreshDay();
  const monthKey =
    (input.monthKey && /^\d{4}-\d{2}$/.test(input.monthKey.trim())
      ? input.monthKey.trim()
      : monthKeyFromCycleStart(budgetCycleStart(logicalToday, refreshDay)));

  const map = await loadMonthBudgetSettings();
  const prev = map[monthKey] ?? { baseAmount: 0, includeLastBalance: false };

  const baseRaw = input.baseAmount;
  const baseAmount =
    baseRaw == null
      ? prev.baseAmount
      : roundMoney(Math.max(0, Number(baseRaw)));
  if (!Number.isFinite(baseAmount)) {
    throw new FinancePageError('baseAmount 无效');
  }

  const includeLastBalance =
    typeof input.includeLastBalance === 'boolean'
      ? input.includeLastBalance
      : prev.includeLastBalance;

  let periodSurplusOverride: number | undefined = prev.periodSurplusOverride;
  if (input.clearSurplusOverride || input.periodSurplusOverride === null) {
    periodSurplusOverride = undefined;
  } else if (
    typeof input.periodSurplusOverride === 'number' &&
    Number.isFinite(input.periodSurplusOverride)
  ) {
    periodSurplusOverride = roundMoney(input.periodSurplusOverride);
  }

  map[monthKey] = {
    baseAmount,
    includeLastBalance,
    ...(periodSurplusOverride != null ? { periodSurplusOverride } : {}),
  };
  await writeSetting(KEYS.monthlyBudget, map);
  return { month_key: monthKey, setting: map[monthKey] };
}

export async function clearMonthBudgetSetting(input: {
  monthKey?: string;
  logicalToday?: string;
  dayBoundaryHour?: number;
  dayBoundaryMinute?: number;
}) {
  const logicalToday = resolveLogicalToday({
    logicalToday: input.logicalToday,
    dayBoundaryHour: input.dayBoundaryHour,
    dayBoundaryMinute: input.dayBoundaryMinute,
  });
  const refreshDay = await loadBudgetRefreshDay();
  const monthKey =
    (input.monthKey && /^\d{4}-\d{2}$/.test(input.monthKey.trim())
      ? input.monthKey.trim()
      : monthKeyFromCycleStart(budgetCycleStart(logicalToday, refreshDay)));

  const map = await loadMonthBudgetSettings();
  if (!(monthKey in map)) {
    return { month_key: monthKey, cleared: false };
  }
  delete map[monthKey];
  await writeSetting(KEYS.monthlyBudget, map);
  return { month_key: monthKey, cleared: true };
}

export async function setBudgetRefreshDay(day: number) {
  const next = clampBudgetRefreshDay(day);
  await writeSetting(KEYS.budgetRefreshDay, next);
  return { refresh_day: next };
}

export async function getFinanceSavingsGoalSummary(params: FinanceBudgetSummaryParams = {}) {
  const logicalToday = resolveLogicalToday(params);
  const [goal, netWorth] = await Promise.all([
    loadFinanceSavingsGoal(),
    getFinanceNetWorth().catch(() => null),
  ]);
  if (!goal) {
    return {
      domain: 'finance_savings_goal',
      today_ymd: logicalToday,
      goal: null,
      net_worth: netWorth,
      gap: null,
      days_left: null,
      daily_target: null,
      achieved: null,
      overdue: null,
    };
  }

  const net = typeof netWorth === 'number' ? netWorth : 0;
  const rawGap = Math.max(0, goal.targetAmount - net);
  const t0 = ymdToLocalDate(logicalToday);
  const target = ymdToLocalDate(goal.targetDate);
  let daysLeft = 1;
  let overdue = false;
  if (t0 && target) {
    const diff = Math.round((target.getTime() - t0.getTime()) / 86400000) + 1;
    daysLeft = Math.max(1, diff);
    overdue = target.getTime() < t0.getTime() && rawGap > 1e-6;
  }
  const achieved = rawGap <= 1e-6;
  const dailyTarget = achieved ? 0 : roundMoney(rawGap / daysLeft);

  return {
    domain: 'finance_savings_goal',
    today_ymd: logicalToday,
    goal,
    net_worth: netWorth,
    gap: roundMoney(rawGap),
    days_left: daysLeft,
    daily_target: dailyTarget,
    achieved,
    overdue,
  };
}

export async function upsertFinanceSavingsGoal(input: {
  targetAmount: number;
  targetDate: string;
  logicalToday?: string;
  dayBoundaryHour?: number;
  dayBoundaryMinute?: number;
}) {
  const logicalToday = resolveLogicalToday({
    logicalToday: input.logicalToday,
    dayBoundaryHour: input.dayBoundaryHour,
    dayBoundaryMinute: input.dayBoundaryMinute,
  });
  const amount = Number(input.targetAmount);
  const targetDate = String(input.targetDate || '').trim();
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new FinancePageError('目标金额须为正数');
  }
  if (!isValidYmd(targetDate)) {
    throw new FinancePageError('目标日期须为 YYYY-MM-DD');
  }
  if (targetDate <= logicalToday) {
    throw new FinancePageError('目标日期最早只能选明天');
  }
  const netWorth = await getFinanceNetWorth().catch(() => 0);
  if (amount <= netWorth) {
    throw new FinancePageError(`目标金额须大于当前净资产（¥${roundMoney(netWorth)}）`);
  }
  const goal: FinanceSavingsGoal = {
    targetAmount: Math.min(SAVINGS_GOAL_MAX, roundMoney(amount)),
    targetDate,
  };
  await writeSetting(KEYS.savingsGoal, goal);
  return { goal, net_worth: netWorth };
}

export async function clearFinanceSavingsGoal() {
  await deleteSetting(KEYS.savingsGoal);
  return { cleared: true };
}
