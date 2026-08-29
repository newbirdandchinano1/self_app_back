import type { RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import { getTableMeta, type TableMeta } from '../crud.js';
import {
  formatRecordDateTimesForApi,
  getLogicalLocalYmd,
  getLogicalYmdFromWallClock,
  normalizeTasksDayBoundary,
  parseTaskAuditWallClockParts,
} from '../calendar/logical-day.js';
import type { TasksDayBoundary } from '../calendar/types.js';
import { addDaysToYmd, countInclusiveYmdDays, isValidYmd, listYmdRange } from '../../utils/ymd.js';
import type { AllowedTable } from '../../config/tables.js';

export class FinancePageError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'FinancePageError';
  }
}

const TXN_TABLE = 'finance_transactions' as const;
const ACCOUNT_TABLE = 'finance_accounts' as const;
const ACCOUNT_TYPE_TABLE = 'finance_account_types' as const;
const CATEGORY_TABLE = 'finance_flow_categories' as const;

const DEFAULT_DAYS_BACK = 90;
const MAX_DAYS_BACK = 366;
const DEFAULT_HISTORY_DAYS = 2;
const MAX_HISTORY_DAYS = 31;
const DEFAULT_BUDGET_REFRESH_DAY = 1;
const TXN_DEFAULT_LIMIT = 200;
const TXN_MAX_LIMIT = 500;
const TXN_MAX_RANGE_DAYS = 800;
const DAILY_SUMMARY_MAX_DAYS = 93;
const RECENT_DAYS_DEFAULT = 3;
const RECENT_DAYS_MAX = 31;
const INSIGHTS_DEFAULT_MONTHS = 6;
const INSIGHTS_MAX_MONTHS = 24;
const CATEGORY_TOP_LIMIT = 10;
const ACCOUNT_DETAIL_MAX_ROWS = 100_000;
const STATS_RANK_DEFAULT = 5;
const STATS_RANK_MAX = 20;
const STATS_RECENT_DAYS_DEFAULT = 6;
const STATS_RECENT_DAYS_MAX = 31;
const STATS_SAMPLE_LIMIT = 50;
const STATS_AUTO_MONTH_DAYS = 90;
const UNCATEGORIZED_NAME = '未分类';

/** 与 APP `BUILTIN_SHEET_CATEGORY_LABELS` 对齐 */
export const BUILTIN_SHEET_CATEGORY_LABELS: Record<string, string> = {
  food: '餐饮',
  snack: '零食',
  fruit: '水果',
  drink: '饮品',
  cook: '做饭食材',
  traffic: '交通',
  home: '居住',
  cloth: '服饰',
  play: '娱乐',
  other: '其他',
  salary: '工资',
  bonus: '奖金',
  refund: '报销',
  invest: '理财',
  sideline: '副业',
  allowance: '补贴',
  redpack: '红包',
  gift: '礼金',
  rent: '租金',
  'other-income': '其他',
};

export interface FinanceDayBoundaryParams {
  dayBoundaryHour?: number;
  dayBoundaryMinute?: number;
}

export interface FinanceHomeParams extends FinanceDayBoundaryParams {
  logicalToday?: string;
  historyDays?: number;
  daysBack?: number;
  budgetRefreshDay?: number;
}

export interface FinanceRecentDaysParams extends FinanceDayBoundaryParams {
  before: string;
  days?: number;
}

export interface FinanceTransactionsParams extends FinanceDayBoundaryParams {
  start: string;
  end: string;
  accountId?: string;
  page?: number;
  limit?: number;
  excludeCorrections?: boolean;
}

export interface FinanceDailySummariesParams {
  start: string;
  end: string;
  dayBoundaryHour?: number;
  dayBoundaryMinute?: number;
}

export interface FinanceAccountDetailParams {
  accountId?: string;
  accountName?: string;
}

export interface FinanceInsightsParams {
  months?: number;
  logicalToday?: string;
  dayBoundaryHour?: number;
  dayBoundaryMinute?: number;
}

export type FinanceStatsGranularity = 'day' | 'month' | 'auto';
export type FinanceStatsSideMode = 'expense' | 'income' | 'both';

export interface FinanceStatsParams extends FinanceDayBoundaryParams {
  start: string;
  end: string;
  granularity?: FinanceStatsGranularity;
  categoryMode?: FinanceStatsSideMode;
  rankMode?: FinanceStatsSideMode;
  rankLimit?: number;
  recentDaysLimit?: number;
  excludeCorrections?: boolean;
}

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function serverNowIso(): string {
  return new Date().toISOString();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function parseExtraData(raw: unknown): Record<string, unknown> {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function isBalanceCorrection(extra: Record<string, unknown>, transactionType?: string): boolean {
  if (transactionType === 'balance_correction') return true;
  const reason = String(extra.reason ?? '').trim();
  if (reason === 'balance_correction') return true;
  const kind = String(extra.kind ?? extra.type ?? '').trim();
  if (kind === 'balance_correction') return true;
  return isTruthyFlag(extra.balance_correction) || isTruthyFlag(extra.is_balance_correction);
}

/** 与 APP `isInitialBalanceFinanceTransaction` 对齐 */
export function isInitialBalanceFinanceTransaction(
  name: unknown,
  extraData?: unknown,
): boolean {
  const extra = parseExtraData(extraData);
  if (String(extra.reason ?? '').trim() === 'initial_balance') return true;
  return String(name ?? '').trim() === '初始余额';
}

export function isBalanceCorrectionFinanceTransaction(
  name: unknown,
  transactionType: unknown,
  extraData?: unknown,
): boolean {
  const extra = parseExtraData(extraData);
  if (isBalanceCorrection(extra, String(transactionType ?? ''))) return true;
  return String(name ?? '').trim() === '余额校正';
}

export function shouldExcludeFromNetWorth(extra: Record<string, unknown>): boolean {
  return (
    isTruthyFlag(extra.exclude_from_total_assets) || isTruthyFlag(extra.excludeFromTotalAssets)
  );
}

export function computeTransactionLedgerEffect(
  transactionType: string,
  amount: unknown,
  extraData?: unknown,
): number {
  const abs = Math.abs(Number(amount) || 0);
  const type = String(transactionType ?? '').trim().toLowerCase();
  if (type === 'income') return abs;
  if (type === 'expense') return -abs;
  if (type === 'transfer') {
    const extra = parseExtraData(extraData);
    const leg = String(extra.transfer_leg ?? extra.transferLeg ?? '')
      .trim()
      .toLowerCase();
    if (leg === 'in') return abs;
    return -abs;
  }
  return 0;
}

export function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const idx = year * 12 + (month - 1) + delta;
  const nextYear = Math.floor(idx / 12);
  const nextMonth = (idx % 12) + 1;
  return { year: nextYear, month: nextMonth };
}

export function ymdFromParts(year: number, month: number, day: number): string {
  const clamped = Math.min(Math.max(1, day), lastDayOfMonth(year, month));
  return `${year}-${pad2(month)}-${pad2(clamped)}`;
}

export function parseYmdParts(ymd: string): { year: number; month: number; day: number } | null {
  if (!isValidYmd(ymd)) return null;
  const [year, month, day] = ymd.split('-').map((x) => parseInt(x, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return { year, month, day };
}

export function clampBudgetRefreshDay(raw: number | undefined): number {
  const n = Number.isFinite(raw) ? Math.round(raw as number) : DEFAULT_BUDGET_REFRESH_DAY;
  return Math.min(31, Math.max(1, n));
}

/** 当前预算周期起始日：不晚于 today 的最近一次刷新日（1–31，短月钳到月末） */
export function budgetCycleStart(todayYmd: string, refreshDay: number): string {
  const parsed = parseYmdParts(todayYmd);
  if (!parsed) return todayYmd;
  const day = clampBudgetRefreshDay(refreshDay);
  const thisMonthStart = ymdFromParts(parsed.year, parsed.month, day);
  if (todayYmd >= thisMonthStart) return thisMonthStart;
  const prev = addMonths(parsed.year, parsed.month, -1);
  return ymdFromParts(prev.year, prev.month, day);
}

export function previousBudgetCycleStart(currentStartYmd: string, refreshDay: number): string {
  const parsed = parseYmdParts(currentStartYmd);
  if (!parsed) return currentStartYmd;
  const prev = addMonths(parsed.year, parsed.month, -1);
  return ymdFromParts(prev.year, prev.month, clampBudgetRefreshDay(refreshDay));
}

export function resolveFinanceHomeWindow(params: {
  logicalToday: string;
  daysBack: number;
  budgetRefreshDay: number;
}): { windowStart: string; daysBackStart: string; currentCycleStart: string; previousCycleStart: string } {
  const daysBack = Math.min(MAX_DAYS_BACK, Math.max(1, params.daysBack));
  const daysBackStart = addDaysToYmd(params.logicalToday, -daysBack);
  const currentCycleStart = budgetCycleStart(params.logicalToday, params.budgetRefreshDay);
  const previousCycleStart = previousBudgetCycleStart(currentCycleStart, params.budgetRefreshDay);
  const windowStart = daysBackStart < previousCycleStart ? daysBackStart : previousCycleStart;
  return { windowStart, daysBackStart, currentCycleStart, previousCycleStart };
}

export function listMonthKeysEndingAt(ymd: string, months: number): string[] {
  const parsed = parseYmdParts(ymd);
  if (!parsed) return [];
  const count = Math.max(1, months);
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const m = addMonths(parsed.year, parsed.month, -i);
    keys.push(`${m.year}-${pad2(m.month)}`);
  }
  return keys;
}

export function monthKeyFromYmd(ymd: string): string {
  return ymd.slice(0, 7);
}

export function listMonthKeysBetween(startYmd: string, endYmd: string): string[] {
  const start = parseYmdParts(startYmd);
  const end = parseYmdParts(endYmd);
  if (!start || !end) return [];
  const keys: string[] = [];
  let year = start.year;
  let month = start.month;
  while (year < end.year || (year === end.year && month <= end.month)) {
    keys.push(`${year}-${pad2(month)}`);
    const next = addMonths(year, month, 1);
    year = next.year;
    month = next.month;
  }
  return keys;
}

export function resolveStatsGranularity(
  requested: FinanceStatsGranularity | undefined,
  start: string,
  end: string,
): 'day' | 'month' {
  if (requested === 'day' || requested === 'month') return requested;
  const days = countInclusiveYmdDays(start, end);
  if (days > STATS_AUTO_MONTH_DAYS) return 'month';
  if (start.slice(0, 4) !== end.slice(0, 4)) return 'month';
  return 'day';
}

function parseSideMode(raw: FinanceStatsSideMode | undefined): FinanceStatsSideMode {
  if (raw === 'expense' || raw === 'income' || raw === 'both') return raw;
  return 'both';
}

function categoryIconKey(extraData: unknown): string | null {
  const extra = parseExtraData(extraData);
  const icon = extra.icon ?? extra.icon_key;
  if (typeof icon === 'string' && icon.trim()) return icon.trim();
  return null;
}

export function resolveFinanceStatsCategory(
  txn: {
    flow_category_id?: unknown;
    extra_data?: unknown;
  },
  categoryById: Map<string, { id: string; name: string; iconKey: string | null }>,
  categoryByName: Map<string, { id: string; name: string; iconKey: string | null }>,
): { categoryId: string | null; name: string; iconKey: string | null; bucketKey: string } {
  const flowId = txn.flow_category_id == null || txn.flow_category_id === '' ? null : String(txn.flow_category_id);
  if (flowId) {
    const row = categoryById.get(flowId);
    if (row) {
      return { categoryId: row.id, name: row.name, iconKey: row.iconKey, bucketKey: `id:${row.id}` };
    }
  }

  const extra = parseExtraData(txn.extra_data);
  const labelRaw =
    (typeof extra.category_label === 'string' ? extra.category_label.trim() : '') ||
    (typeof extra.category_key === 'string' ? BUILTIN_SHEET_CATEGORY_LABELS[extra.category_key] ?? '' : '');
  if (labelRaw) {
    const row = categoryByName.get(labelRaw);
    if (row) {
      return { categoryId: row.id, name: row.name, iconKey: row.iconKey, bucketKey: `id:${row.id}` };
    }
    return { categoryId: null, name: labelRaw, iconKey: null, bucketKey: `label:${labelRaw}` };
  }

  return {
    categoryId: null,
    name: UNCATEGORIZED_NAME,
    iconKey: null,
    bucketKey: 'uncategorized',
  };
}

function trendDayLabel(ymd: string): string {
  const parts = parseYmdParts(ymd);
  if (!parts) return ymd;
  return `${parts.month}.${parts.day}`;
}

function trendMonthLabel(monthKey: string): string {
  const month = Number(monthKey.slice(5, 7));
  if (!Number.isFinite(month) || month < 1 || month > 12) return monthKey;
  return `${month}月`;
}

function buildCategorySide(
  buckets: Map<string, { categoryId: string | null; name: string; iconKey: string | null; amount: number; count: number }>,
  sideTotal: number,
) {
  return Array.from(buckets.values())
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'zh-CN'))
    .map((item) => ({
      categoryId: item.categoryId,
      name: item.name,
      amount: roundMoney(item.amount),
      count: item.count,
      percent: sideTotal > 0 ? roundMoney((item.amount / sideTotal) * 100) : 0,
      iconKey: item.iconKey,
    }));
}

function resolveDayBoundary(params: FinanceDayBoundaryParams): TasksDayBoundary {
  return normalizeTasksDayBoundary({
    hour: params.dayBoundaryHour ?? 0,
    minute: params.dayBoundaryMinute ?? 0,
  });
}

export function resolveLogicalToday(params: FinanceDayBoundaryParams & { logicalToday?: string }): string {
  const boundary = resolveDayBoundary(params);
  const raw = params.logicalToday?.trim();
  if (raw && isValidYmd(raw)) return raw;
  return getLogicalLocalYmd(new Date(), boundary);
}

export function logicalYmdFromHappenedAt(raw: unknown, boundary: TasksDayBoundary): string | null {
  const text = String(raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return getLogicalYmdFromWallClock({ year: Number(text.slice(0, 4)), month: Number(text.slice(5, 7)), day: Number(text.slice(8, 10)), hour: 0, minute: 0 }, boundary);
  }
  const wallClock = parseTaskAuditWallClockParts(raw);
  if (!wallClock) {
    const ymd = text.slice(0, 10);
    return isValidYmd(ymd) ? ymd : null;
  }
  return getLogicalYmdFromWallClock(wallClock, boundary);
}

/** happened_at 按墙上时钟取逻辑日；日界 0:00 时退化为 LEFT(happened_at, 10) */
export function logicalDaySql(boundary: TasksDayBoundary, alias = ''): string {
  const col = alias ? `${alias}.happened_at` : 'happened_at';
  const happened = `REPLACE(LEFT(TRIM(${col}), 19), 'T', ' ')`;
  if (boundary.hour === 0 && boundary.minute === 0) {
    return `LEFT(${happened}, 10)`;
  }
  const offsetMins = boundary.hour * 60 + boundary.minute;
  return `DATE_FORMAT(DATE_SUB(CAST(${happened} AS DATETIME), INTERVAL ${offsetMins} MINUTE), '%Y-%m-%d')`;
}

/** 账户余额：income +|amt|，expense -|amt|，transfer 看 transfer_leg（缺省当 out） */
export function ledgerEffectSql(alias = ''): string {
  const p = alias ? `${alias}.` : '';
  const extra = alias ? `${alias}.extra_data` : 'extra_data';
  const json = (path: string) =>
    `IF(JSON_VALID(${extra}), JSON_UNQUOTE(JSON_EXTRACT(${extra}, '${path}')), NULL)`;
  return `CASE
    WHEN ${p}transaction_type = 'income' THEN ABS(COALESCE(${p}amount, 0))
    WHEN ${p}transaction_type = 'expense' THEN -ABS(COALESCE(${p}amount, 0))
    WHEN ${p}transaction_type = 'transfer' THEN
      CASE
        WHEN LOWER(COALESCE(${json('$.transfer_leg')}, ${json('$.transferLeg')}, '')) = 'in'
        THEN ABS(COALESCE(${p}amount, 0))
        ELSE -ABS(COALESCE(${p}amount, 0))
      END
    ELSE 0
  END`;
}

export function excludeFromNetWorthSql(alias = ''): string {
  const extra = alias ? `${alias}.extra_data` : 'extra_data';
  const extract = (path: string) => `IF(JSON_VALID(${extra}), JSON_EXTRACT(${extra}, '${path}'), NULL)`;
  const unquote = (path: string) =>
    `IF(JSON_VALID(${extra}), JSON_UNQUOTE(JSON_EXTRACT(${extra}, '${path}')), NULL)`;
  return `(
    ${extract('$.exclude_from_total_assets')} = TRUE
    OR ${extract('$.excludeFromTotalAssets')} = TRUE
    OR ${unquote('$.exclude_from_total_assets')} IN ('true', '1')
    OR ${unquote('$.excludeFromTotalAssets')} IN ('true', '1')
  )`;
}

export function balanceCorrectionSql(alias = ''): string {
  const p = alias ? `${alias}.` : '';
  const extra = alias ? `${alias}.extra_data` : 'extra_data';
  const extract = (path: string) => `IF(JSON_VALID(${extra}), JSON_EXTRACT(${extra}, '${path}'), NULL)`;
  const unquote = (path: string) =>
    `IF(JSON_VALID(${extra}), JSON_UNQUOTE(JSON_EXTRACT(${extra}, '${path}')), NULL)`;
  return `(
    ${p}transaction_type = 'balance_correction'
    OR TRIM(${p}name) = '余额校正'
    OR ${unquote('$.reason')} = 'balance_correction'
    OR ${unquote('$.kind')} = 'balance_correction'
    OR ${unquote('$.type')} = 'balance_correction'
    OR ${extract('$.balance_correction')} = TRUE
    OR ${extract('$.is_balance_correction')} = TRUE
    OR ${unquote('$.balance_correction')} IN ('true', '1')
    OR ${unquote('$.is_balance_correction')} IN ('true', '1')
  )`;
}

export function initialBalanceSql(alias = ''): string {
  const p = alias ? `${alias}.` : '';
  const extra = alias ? `${alias}.extra_data` : 'extra_data';
  const unquote = (path: string) =>
    `IF(JSON_VALID(${extra}), JSON_UNQUOTE(JSON_EXTRACT(${extra}, '${path}')), NULL)`;
  return `(
    TRIM(${p}name) = '初始余额'
    OR ${unquote('$.reason')} = 'initial_balance'
  )`;
}

function activeWhereSql(columns: Set<string>, alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  const parts: string[] = [];
  if (columns.has('deleted_at')) {
    parts.push(`${prefix}deleted_at IS NULL`);
  }
  if (columns.has('sync_status')) {
    parts.push(`(${prefix}sync_status IS NULL OR ${prefix}sync_status != 'pending_delete')`);
  }
  return parts.length > 0 ? parts.join(' AND ') : '1=1';
}

async function loadMeta(table: AllowedTable): Promise<{ meta: TableMeta; columns: Set<string> }> {
  const meta = await getTableMeta(table);
  return { meta, columns: new Set(meta.columns) };
}

function selectSql(meta: TableMeta, alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  return meta.columns.map((c) => `${prefix}${quoteIdent(c)}`).join(', ');
}

function formatFinanceRow(row: Record<string, unknown>, table: string): Record<string, unknown> {
  const happenedAt = row.happened_at;
  const extraData = row.extra_data;
  const formatted = formatRecordDateTimesForApi({ ...row }, table);
  if ('happened_at' in row) {
    formatted.happened_at = happenedAt == null || happenedAt === '' ? happenedAt : String(happenedAt);
  }
  if ('extra_data' in row) {
    if (extraData == null) {
      formatted.extra_data = extraData;
    } else if (typeof extraData === 'string') {
      formatted.extra_data = extraData;
    } else {
      formatted.extra_data = JSON.stringify(extraData);
    }
  }
  if (typeof formatted.amount === 'number') {
    formatted.amount = roundMoney(formatted.amount);
  }
  return formatted;
}

function formatAccountRow(
  row: Record<string, unknown>,
  balance: number,
): Record<string, unknown> {
  const formatted = formatFinanceRow(row, ACCOUNT_TABLE);
  formatted.balance = roundMoney(balance);
  return formatted;
}

async function loadBalancesByAccount(): Promise<Map<string, number>> {
  const txnMeta = await loadMeta(TXN_TABLE);
  const where = activeWhereSql(txnMeta.columns);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT account_id AS accountId, COALESCE(SUM(${ledgerEffectSql()}), 0) AS balance
     FROM ${TXN_TABLE}
     WHERE ${where}
     GROUP BY account_id`,
  );
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(String(row.accountId ?? ''), roundMoney(Number(row.balance) || 0));
  }
  return map;
}

async function loadActiveAccounts(): Promise<Record<string, unknown>[]> {
  const { meta, columns } = await loadMeta(ACCOUNT_TABLE);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectSql(meta)} FROM ${ACCOUNT_TABLE}
     WHERE ${activeWhereSql(columns)}
     ORDER BY name ASC, id ASC`,
  );
  return rows as Record<string, unknown>[];
}

async function loadAccountsWithBalance(): Promise<{
  accounts: Record<string, unknown>[];
  netWorth: number;
}> {
  const [accountRows, balances] = await Promise.all([loadActiveAccounts(), loadBalancesByAccount()]);
  let netWorth = 0;
  const accounts = accountRows.map((row) => {
    const id = String(row.id ?? '');
    const balance = balances.get(id) ?? 0;
    if (!shouldExcludeFromNetWorth(parseExtraData(row.extra_data))) {
      netWorth += balance;
    }
    return formatAccountRow(row, balance);
  });
  return { accounts, netWorth: roundMoney(netWorth) };
}

async function loadSortedRows(table: AllowedTable, orderSql: string): Promise<Record<string, unknown>[]> {
  const { meta, columns } = await loadMeta(table);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectSql(meta)} FROM ${quoteIdent(table)}
     WHERE ${activeWhereSql(columns)}
     ORDER BY ${orderSql}`,
  );
  return (rows as Record<string, unknown>[]).map((row) => formatFinanceRow(row, table));
}

async function tableCount(table: AllowedTable): Promise<number> {
  const { columns } = await loadMeta(table);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM ${quoteIdent(table)} WHERE ${activeWhereSql(columns)}`,
  );
  return Number(rows[0]?.cnt ?? 0);
}

async function loadCategories(): Promise<Record<string, unknown>[]> {
  return loadSortedRows(CATEGORY_TABLE, 'sort_order ASC, name ASC, id ASC');
}

async function loadAccountTypes(): Promise<Record<string, unknown>[]> {
  return loadSortedRows(ACCOUNT_TYPE_TABLE, 'sort_order ASC, name ASC, id ASC');
}

async function existsTxnBeforeDay(logicalDayExpr: string, beforeYmd: string, extraWhere = '', extraValues: unknown[] = []): Promise<boolean> {
  const { columns } = await loadMeta(TXN_TABLE);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT 1 AS ok FROM ${TXN_TABLE}
     WHERE ${activeWhereSql(columns)}
       AND ${logicalDayExpr} < ?
       ${extraWhere}
     LIMIT 1`,
    [beforeYmd, ...extraValues],
  );
  return rows.length > 0;
}

async function loadHistoryDaysWithTxns(
  logicalDayExpr: string,
  beforeYmd: string,
  days: number,
  extraWhere = '',
  extraValues: unknown[] = [],
): Promise<string[]> {
  if (days <= 0) return [];
  const { columns } = await loadMeta(TXN_TABLE);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${logicalDayExpr} AS day
     FROM ${TXN_TABLE}
     WHERE ${activeWhereSql(columns)}
       AND ${logicalDayExpr} < ?
       ${extraWhere}
     GROUP BY day
     ORDER BY day DESC
     LIMIT ?`,
    [beforeYmd, ...extraValues, days],
  );
  return rows.map((row) => String(row.day ?? '')).filter((d) => isValidYmd(d));
}

async function loadTransactionsWhere(
  whereSql: string,
  values: unknown[],
  orderSql = 'happened_at DESC, id DESC',
  limit?: number,
  offset?: number,
): Promise<Record<string, unknown>[]> {
  const { meta } = await loadMeta(TXN_TABLE);
  const limitSql = limit != null ? ' LIMIT ?' : '';
  const offsetSql = offset != null ? ' OFFSET ?' : '';
  const params = [...values];
  if (limit != null) params.push(limit);
  if (offset != null) params.push(offset);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectSql(meta)} FROM ${TXN_TABLE}
     WHERE ${whereSql}
     ORDER BY ${orderSql}${limitSql}${offsetSql}`,
    params,
  );
  return (rows as Record<string, unknown>[]).map((row) => formatFinanceRow(row, TXN_TABLE));
}

async function loadMonthlyIncomeExpense(
  logicalDayExpr: string,
  monthKey: string,
): Promise<{ income: number; expense: number }> {
  const { columns } = await loadMeta(TXN_TABLE);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT
        COALESCE(SUM(CASE WHEN transaction_type = 'income' THEN ABS(COALESCE(amount, 0)) ELSE 0 END), 0) AS income,
        COALESCE(SUM(CASE WHEN transaction_type = 'expense' THEN ABS(COALESCE(amount, 0)) ELSE 0 END), 0) AS expense
     FROM ${TXN_TABLE}
     WHERE ${activeWhereSql(columns)}
       AND LEFT(${logicalDayExpr}, 7) = ?
       AND transaction_type IN ('income', 'expense')
       AND NOT ${balanceCorrectionSql()}`,
    [monthKey],
  );
  const row = rows[0];
  return {
    income: roundMoney(Number(row?.income) || 0),
    expense: roundMoney(Number(row?.expense) || 0),
  };
}

export async function getFinanceHome(params: FinanceHomeParams) {
  const boundary = resolveDayBoundary(params);
  const logicalToday = resolveLogicalToday(params);
  const daysBack = Math.min(MAX_DAYS_BACK, Math.max(1, params.daysBack ?? DEFAULT_DAYS_BACK));
  const historyDays = Math.min(
    MAX_HISTORY_DAYS,
    Math.max(0, params.historyDays ?? DEFAULT_HISTORY_DAYS),
  );
  const budgetRefreshDay = clampBudgetRefreshDay(params.budgetRefreshDay);
  const window = resolveFinanceHomeWindow({ logicalToday, daysBack, budgetRefreshDay });
  const logicalDayExpr = logicalDaySql(boundary);
  const { columns } = await loadMeta(TXN_TABLE);

  const historyDayList = await loadHistoryDaysWithTxns(logicalDayExpr, logicalToday, historyDays);
  const inHistory =
    historyDayList.length > 0 ? ` OR ${logicalDayExpr} IN (${historyDayList.map(() => '?').join(', ')})` : '';

  const txnWhere = `${activeWhereSql(columns)}
    AND (
      (${logicalDayExpr} >= ? AND ${logicalDayExpr} <= ?)
      ${inHistory}
    )`;
  const txnValues: unknown[] = [window.windowStart, logicalToday, ...historyDayList];

  const [accountsPayload, categories, transactions, historyHasMore, monthly] = await Promise.all([
    loadAccountsWithBalance(),
    loadCategories(),
    loadTransactionsWhere(txnWhere, txnValues),
    existsTxnBeforeDay(logicalDayExpr, window.windowStart),
    loadMonthlyIncomeExpense(logicalDayExpr, monthKeyFromYmd(logicalToday)),
  ]);

  return {
    accounts: accountsPayload.accounts,
    categories,
    transactions,
    historyHasMore,
    netWorth: accountsPayload.netWorth,
    monthly,
    meta: {
      serverTime: serverNowIso(),
      logicalToday,
      daysBack,
      budgetRefreshDay,
      windowStart: window.windowStart,
    },
  };
}

export async function getFinanceCatalog() {
  const [accountsPayload, accountTypes, categories, accountCount, typeCount, categoryCount] =
    await Promise.all([
      loadAccountsWithBalance(),
      loadAccountTypes(),
      loadCategories(),
      tableCount(ACCOUNT_TABLE),
      tableCount(ACCOUNT_TYPE_TABLE),
      tableCount(CATEGORY_TABLE),
    ]);

  return {
    accounts: accountsPayload.accounts,
    accountTypes,
    categories,
    meta: {
      serverTime: serverNowIso(),
      tablesVersion: {
        finance_accounts: { count: accountCount },
        finance_account_types: { count: typeCount },
        finance_flow_categories: { count: categoryCount },
      },
    },
  };
}

export async function getFinanceRecentDays(params: FinanceRecentDaysParams) {
  if (!isValidYmd(params.before)) {
    throw new FinancePageError('before 必填，格式为 YYYY-MM-DD');
  }
  const boundary = resolveDayBoundary(params);
  const days = Math.min(RECENT_DAYS_MAX, Math.max(1, params.days ?? RECENT_DAYS_DEFAULT));
  const logicalDayExpr = logicalDaySql(boundary);
  const { columns } = await loadMeta(TXN_TABLE);
  const dayList = await loadHistoryDaysWithTxns(logicalDayExpr, params.before, days);

  if (dayList.length === 0) {
    return {
      transactions: [] as Record<string, unknown>[],
      historyHasMore: false,
      meta: { serverTime: serverNowIso(), before: params.before, days },
    };
  }

  const oldest = dayList.reduce((min, d) => (d < min ? d : min), dayList[0]!);
  const txnWhere = `${activeWhereSql(columns)} AND ${logicalDayExpr} IN (${dayList.map(() => '?').join(', ')})`;
  const [transactions, historyHasMore] = await Promise.all([
    loadTransactionsWhere(txnWhere, dayList),
    existsTxnBeforeDay(logicalDayExpr, oldest),
  ]);

  return {
    transactions,
    historyHasMore,
    meta: { serverTime: serverNowIso(), before: params.before, days },
  };
}

export async function getFinanceTransactions(params: FinanceTransactionsParams) {
  if (!isValidYmd(params.start) || !isValidYmd(params.end)) {
    throw new FinancePageError('start 与 end 必填，格式为 YYYY-MM-DD');
  }
  if (params.start > params.end) {
    throw new FinancePageError('start 不能晚于 end');
  }
  const rangeDays = countInclusiveYmdDays(params.start, params.end);
  if (rangeDays > TXN_MAX_RANGE_DAYS) {
    throw new FinancePageError(`区间不能超过 ${TXN_MAX_RANGE_DAYS} 天`);
  }

  const boundary = resolveDayBoundary(params);
  const logicalDayExpr = logicalDaySql(boundary);
  const { columns } = await loadMeta(TXN_TABLE);
  const where = [
    activeWhereSql(columns),
    `${logicalDayExpr} >= ?`,
    `${logicalDayExpr} <= ?`,
  ];
  const values: unknown[] = [params.start, params.end];

  if (params.accountId?.trim()) {
    where.push('account_id = ?');
    values.push(params.accountId.trim());
  }
  if (params.excludeCorrections) {
    where.push(`NOT ${balanceCorrectionSql()}`);
  }

  const whereSql = where.join(' AND ');
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(TXN_MAX_LIMIT, Math.max(1, params.limit ?? TXN_DEFAULT_LIMIT));
  const offset = (page - 1) * limit;

  const [countRows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM ${TXN_TABLE} WHERE ${whereSql}`,
    values,
  );
  const total = Number(countRows[0]?.total ?? 0);
  const transactions = await loadTransactionsWhere(whereSql, values, 'happened_at DESC, id DESC', limit, offset);

  return {
    transactions,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
    },
    meta: {
      serverTime: serverNowIso(),
      start: params.start,
      end: params.end,
      accountId: params.accountId?.trim() || null,
    },
  };
}

export async function getFinanceDailySummaries(params: FinanceDailySummariesParams) {
  if (!isValidYmd(params.start) || !isValidYmd(params.end)) {
    throw new FinancePageError('start 与 end 必填，格式为 YYYY-MM-DD');
  }
  if (params.start > params.end) {
    throw new FinancePageError('start 不能晚于 end');
  }
  const rangeDays = countInclusiveYmdDays(params.start, params.end);
  if (rangeDays > DAILY_SUMMARY_MAX_DAYS) {
    throw new FinancePageError(`区间不能超过 ${DAILY_SUMMARY_MAX_DAYS} 天`);
  }

  const boundary = resolveDayBoundary(params);
  const logicalDayExpr = logicalDaySql(boundary);
  const { columns } = await loadMeta(TXN_TABLE);

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT
        ${logicalDayExpr} AS day,
        COALESCE(SUM(CASE WHEN transaction_type = 'income' THEN ABS(COALESCE(amount, 0)) ELSE 0 END), 0) AS income,
        COALESCE(SUM(CASE WHEN transaction_type = 'expense' THEN ABS(COALESCE(amount, 0)) ELSE 0 END), 0) AS expense
     FROM ${TXN_TABLE}
     WHERE ${activeWhereSql(columns)}
       AND ${logicalDayExpr} >= ?
       AND ${logicalDayExpr} <= ?
       AND transaction_type IN ('income', 'expense')
       AND NOT ${balanceCorrectionSql()}
     GROUP BY day
     ORDER BY day ASC`,
    [params.start, params.end],
  );

  const days = rows
    .map((row) => {
      const income = roundMoney(Number(row.income) || 0);
      const expense = roundMoney(Number(row.expense) || 0);
      return {
        day: String(row.day ?? ''),
        income,
        expense,
        net: roundMoney(income - expense),
      };
    })
    .filter((row) => isValidYmd(row.day));

  return {
    days,
    meta: {
      serverTime: serverNowIso(),
      start: params.start,
      end: params.end,
    },
  };
}

export async function getFinanceAccountDetail(params: FinanceAccountDetailParams) {
  const accountId = params.accountId?.trim();
  const accountName = params.accountName?.trim();
  if (!accountId && !accountName) {
    throw new FinancePageError('accountId 或 accountName 必填');
  }

  const { meta, columns } = await loadMeta(ACCOUNT_TABLE);
  const where = [activeWhereSql(columns)];
  const values: unknown[] = [];
  if (accountId) {
    where.push('id = ?');
    values.push(accountId);
  } else {
    where.push('name = ?');
    values.push(accountName);
  }

  const [accountRows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectSql(meta)} FROM ${ACCOUNT_TABLE}
     WHERE ${where.join(' AND ')}
     LIMIT 1`,
    values,
  );
  const accountRow = accountRows[0] as Record<string, unknown> | undefined;
  if (!accountRow) {
    return {
      account: null,
      transactions: [] as Record<string, unknown>[],
      meta: { serverTime: serverNowIso() },
    };
  }

  const balances = await loadBalancesByAccount();
  const id = String(accountRow.id ?? '');
  const account = formatAccountRow(accountRow, balances.get(id) ?? 0);

  const txnMeta = await loadMeta(TXN_TABLE);
  const txnWhere = `${activeWhereSql(txnMeta.columns)} AND account_id = ?`;
  const transactions = await loadTransactionsWhere(
    txnWhere,
    [id],
    'happened_at DESC, id DESC',
    ACCOUNT_DETAIL_MAX_ROWS,
    0,
  );

  return {
    account,
    transactions,
    meta: { serverTime: serverNowIso() },
  };
}

export async function getFinanceCashFlow() {
  const [profileRows, incomes, holdings, expenseLines] = await Promise.all([
    (async () => {
      const { meta, columns } = await loadMeta('cash_flow_profile');
      const [rows] = await db.query<RowDataPacket[]>(
        `SELECT ${selectSql(meta)} FROM cash_flow_profile
         WHERE ${activeWhereSql(columns)} AND id = 'default'
         LIMIT 1`,
      );
      const row = rows[0] as Record<string, unknown> | undefined;
      return row ? formatFinanceRow(row, 'cash_flow_profile') : null;
    })(),
    loadSortedRows('cash_flow_incomes', 'sort_order ASC, name ASC, id ASC'),
    loadSortedRows('cash_flow_holdings', 'sort_order ASC, name ASC, id ASC'),
    loadSortedRows('cash_flow_expense_lines', 'sort_order ASC, name ASC, id ASC'),
  ]);

  return {
    profile: profileRows,
    incomes,
    holdings,
    expenseLines,
    meta: { serverTime: serverNowIso() },
  };
}

export async function getFinanceInsights(params: FinanceInsightsParams) {
  const months = Math.min(INSIGHTS_MAX_MONTHS, Math.max(1, params.months ?? INSIGHTS_DEFAULT_MONTHS));
  const boundary = resolveDayBoundary(params);
  const logicalToday = resolveLogicalToday(params);
  const monthKeys = listMonthKeysEndingAt(logicalToday, months);
  const firstMonthStart = `${monthKeys[0] ?? monthKeyFromYmd(logicalToday)}-01`;
  const logicalDayExpr = logicalDaySql(boundary);
  const txnMeta = await loadMeta(TXN_TABLE);
  const accountMeta = await loadMeta(ACCOUNT_TABLE);

  const [{ netWorth }, monthlyRows, categoryRows, monthDeltaRows] = await Promise.all([
    loadAccountsWithBalance(),
    db.query<RowDataPacket[]>(
      `SELECT
          LEFT(${logicalDayExpr}, 7) AS month_key,
          COALESCE(SUM(CASE WHEN transaction_type = 'income' THEN ABS(COALESCE(amount, 0)) ELSE 0 END), 0) AS income,
          COALESCE(SUM(CASE WHEN transaction_type = 'expense' THEN ABS(COALESCE(amount, 0)) ELSE 0 END), 0) AS expense
       FROM ${TXN_TABLE}
       WHERE ${activeWhereSql(txnMeta.columns)}
         AND ${logicalDayExpr} >= ?
         AND ${logicalDayExpr} <= ?
         AND transaction_type IN ('income', 'expense')
         AND NOT ${balanceCorrectionSql()}
       GROUP BY month_key`,
      [firstMonthStart, logicalToday],
    ),
    db.query<RowDataPacket[]>(
      `SELECT
          t.flow_category_id AS categoryId,
          COALESCE(c.name, '') AS name,
          COALESCE(SUM(ABS(COALESCE(t.amount, 0))), 0) AS amount
       FROM ${TXN_TABLE} t
       LEFT JOIN ${CATEGORY_TABLE} c ON c.id = t.flow_category_id
       WHERE ${activeWhereSql(txnMeta.columns, 't')}
         AND ${logicalDaySql(boundary, 't')} >= ?
         AND ${logicalDaySql(boundary, 't')} <= ?
         AND t.transaction_type = 'expense'
         AND NOT ${balanceCorrectionSql('t')}
       GROUP BY t.flow_category_id, c.name
       ORDER BY amount DESC
       LIMIT ?`,
      [firstMonthStart, logicalToday, CATEGORY_TOP_LIMIT],
    ),
    db.query<RowDataPacket[]>(
      `SELECT
          LEFT(${logicalDaySql(boundary, 't')}, 7) AS month_key,
          COALESCE(SUM(${ledgerEffectSql('t')}), 0) AS delta
       FROM ${TXN_TABLE} t
       INNER JOIN ${ACCOUNT_TABLE} a ON a.id = t.account_id AND ${activeWhereSql(accountMeta.columns, 'a')}
       WHERE ${activeWhereSql(txnMeta.columns, 't')}
         AND ${logicalDaySql(boundary, 't')} >= ?
         AND ${logicalDaySql(boundary, 't')} <= ?
         AND NOT ${excludeFromNetWorthSql('a')}
       GROUP BY month_key`,
      [firstMonthStart, logicalToday],
    ),
  ]);

  const monthlyMap = new Map<string, { income: number; expense: number }>();
  for (const row of monthlyRows[0]) {
    monthlyMap.set(String(row.month_key ?? ''), {
      income: roundMoney(Number(row.income) || 0),
      expense: roundMoney(Number(row.expense) || 0),
    });
  }
  const monthly = monthKeys.map((key) => {
    const found = monthlyMap.get(key) ?? { income: 0, expense: 0 };
    return {
      key,
      income: found.income,
      expense: found.expense,
      net: roundMoney(found.income - found.expense),
    };
  });

  const categoryTop = categoryRows[0].map((row) => ({
    categoryId: row.categoryId == null ? null : String(row.categoryId),
    name: String(row.name ?? ''),
    amount: roundMoney(Number(row.amount) || 0),
  }));

  const deltaMap = new Map<string, number>();
  for (const row of monthDeltaRows[0]) {
    deltaMap.set(String(row.month_key ?? ''), Number(row.delta) || 0);
  }
  let running = netWorth;
  const monthEndNetWorthNewestFirst: { key: string; netWorth: number }[] = [];
  for (let i = monthKeys.length - 1; i >= 0; i -= 1) {
    const key = monthKeys[i]!;
    monthEndNetWorthNewestFirst.push({ key, netWorth: roundMoney(running) });
    running = roundMoney(running - (deltaMap.get(key) ?? 0));
  }

  return {
    netWorth,
    monthly,
    categoryTop,
    monthEndNetWorth: monthEndNetWorthNewestFirst.reverse(),
    meta: {
      serverTime: serverNowIso(),
      months,
    },
  };
}

export async function getFinanceStats(params: FinanceStatsParams) {
  if (!isValidYmd(params.start) || !isValidYmd(params.end)) {
    throw new FinancePageError('start 与 end 必填，格式为 YYYY-MM-DD');
  }
  if (params.start > params.end) {
    throw new FinancePageError('start 不能晚于 end');
  }
  const rangeDays = countInclusiveYmdDays(params.start, params.end);
  if (rangeDays > TXN_MAX_RANGE_DAYS) {
    throw new FinancePageError(`区间不能超过 ${TXN_MAX_RANGE_DAYS} 天`);
  }

  const boundary = resolveDayBoundary(params);
  const logicalDayExpr = logicalDaySql(boundary);
  const granularity = resolveStatsGranularity(params.granularity, params.start, params.end);
  const categoryMode = parseSideMode(params.categoryMode);
  const rankMode = parseSideMode(params.rankMode);
  const rankLimit = Math.min(STATS_RANK_MAX, Math.max(1, params.rankLimit ?? STATS_RANK_DEFAULT));
  const recentDaysLimit = Math.min(
    STATS_RECENT_DAYS_MAX,
    Math.max(1, params.recentDaysLimit ?? STATS_RECENT_DAYS_DEFAULT),
  );
  const excludeCorrections = params.excludeCorrections !== false;
  const days = Math.max(1, rangeDays);

  const { columns } = await loadMeta(TXN_TABLE);
  const whereParts = [
    activeWhereSql(columns),
    `${logicalDayExpr} >= ?`,
    `${logicalDayExpr} <= ?`,
    `transaction_type IN ('income', 'expense')`,
  ];
  const values: unknown[] = [params.start, params.end];
  if (excludeCorrections) {
    whereParts.push(`NOT ${balanceCorrectionSql()}`);
  }
  const whereSql = whereParts.join(' AND ');

  const [categoryRows, txnRows] = await Promise.all([
    loadCategories(),
    db.query<RowDataPacket[]>(
      `SELECT
          id,
          name,
          happened_at,
          transaction_type,
          flow_category_id,
          amount,
          note,
          ai_comment,
          extra_data,
          ${logicalDayExpr} AS logical_day
       FROM ${TXN_TABLE}
       WHERE ${whereSql}
       ORDER BY happened_at DESC, id DESC`,
      values,
    ),
  ]);

  const categoryById = new Map<string, { id: string; name: string; iconKey: string | null }>();
  const categoryByName = new Map<string, { id: string; name: string; iconKey: string | null }>();
  for (const row of categoryRows) {
    const id = String(row.id ?? '');
    if (!id) continue;
    const entry = {
      id,
      name: String(row.name ?? '').trim() || id,
      iconKey: categoryIconKey(row.extra_data),
    };
    categoryById.set(id, entry);
    if (entry.name && !categoryByName.has(entry.name)) {
      categoryByName.set(entry.name, entry);
    }
  }

  type StatsTxn = {
    id: string;
    name: string;
    happenedAt: string;
    transactionType: 'income' | 'expense';
    flowCategoryId: string | null;
    amount: number;
    absAmount: number;
    note: string | null;
    aiComment: string | null;
    extraData: string | null;
    logicalDay: string;
    isInitialBalance: boolean;
  };

  const txns: StatsTxn[] = [];
  for (const row of txnRows[0]) {
    const typeRaw = String(row.transaction_type ?? '').trim().toLowerCase();
    if (typeRaw !== 'income' && typeRaw !== 'expense') continue;
    const logicalDay = String(row.logical_day ?? '').slice(0, 10);
    if (!isValidYmd(logicalDay)) continue;
    const name = String(row.name ?? '');
    const extraData =
      row.extra_data == null
        ? null
        : typeof row.extra_data === 'string'
          ? row.extra_data
          : JSON.stringify(row.extra_data);
    if (
      excludeCorrections &&
      isBalanceCorrectionFinanceTransaction(name, typeRaw, extraData ?? row.extra_data)
    ) {
      continue;
    }
    const amount = Number(row.amount) || 0;
    txns.push({
      id: String(row.id ?? ''),
      name,
      happenedAt: row.happened_at == null || row.happened_at === '' ? '' : String(row.happened_at),
      transactionType: typeRaw,
      flowCategoryId:
        row.flow_category_id == null || row.flow_category_id === ''
          ? null
          : String(row.flow_category_id),
      amount,
      absAmount: Math.abs(amount),
      note: row.note == null || row.note === '' ? null : String(row.note),
      aiComment: row.ai_comment == null || row.ai_comment === '' ? null : String(row.ai_comment),
      extraData,
      logicalDay,
      isInitialBalance: isInitialBalanceFinanceTransaction(name, extraData ?? row.extra_data),
    });
  }

  let income = 0;
  let expense = 0;
  const expenseCats = new Map<
    string,
    { categoryId: string | null; name: string; iconKey: string | null; amount: number; count: number }
  >();
  const incomeCats = new Map<
    string,
    { categoryId: string | null; name: string; iconKey: string | null; amount: number; count: number }
  >();
  const dayBuckets = new Map<string, { income: number; expense: number }>();
  const monthBuckets = new Map<string, { income: number; expense: number }>();

  for (const txn of txns) {
    if (txn.transactionType === 'income') income += txn.absAmount;
    else expense += txn.absAmount;

    const dayBucket = dayBuckets.get(txn.logicalDay) ?? { income: 0, expense: 0 };
    if (txn.transactionType === 'income') dayBucket.income += txn.absAmount;
    else dayBucket.expense += txn.absAmount;
    dayBuckets.set(txn.logicalDay, dayBucket);

    const mk = monthKeyFromYmd(txn.logicalDay);
    const monthBucket = monthBuckets.get(mk) ?? { income: 0, expense: 0 };
    if (txn.transactionType === 'income') monthBucket.income += txn.absAmount;
    else monthBucket.expense += txn.absAmount;
    monthBuckets.set(mk, monthBucket);

    const shouldAggregateCategory =
      categoryMode === 'both' ||
      (categoryMode === 'expense' && txn.transactionType === 'expense') ||
      (categoryMode === 'income' && txn.transactionType === 'income');
    if (shouldAggregateCategory) {
      const resolved = resolveFinanceStatsCategory(
        { flow_category_id: txn.flowCategoryId, extra_data: txn.extraData },
        categoryById,
        categoryByName,
      );
      const target = txn.transactionType === 'income' ? incomeCats : expenseCats;
      const current = target.get(resolved.bucketKey) ?? {
        categoryId: resolved.categoryId,
        name: resolved.name,
        iconKey: resolved.iconKey,
        amount: 0,
        count: 0,
      };
      current.amount += txn.absAmount;
      current.count += 1;
      if (!current.iconKey && resolved.iconKey) current.iconKey = resolved.iconKey;
      target.set(resolved.bucketKey, current);
    }
  }

  income = roundMoney(income);
  expense = roundMoney(expense);
  const balance = roundMoney(income - expense);

  const trendSource = granularity === 'month' ? monthBuckets : dayBuckets;
  const trendKeys =
    granularity === 'month'
      ? listMonthKeysBetween(params.start, params.end)
      : listYmdRange(params.start, params.end);
  const trendPoints = trendKeys.map((key) => {
    const found = trendSource.get(key) ?? { income: 0, expense: 0 };
    const pointIncome = roundMoney(found.income);
    const pointExpense = roundMoney(found.expense);
    return {
      key,
      label: granularity === 'month' ? trendMonthLabel(key) : trendDayLabel(key),
      income: pointIncome,
      expense: pointExpense,
      balance: roundMoney(pointIncome - pointExpense),
    };
  });

  const recentDays = Array.from(dayBuckets.entries())
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .slice(0, recentDaysLimit)
    .map(([day, item]) => {
      const dayIncome = roundMoney(item.income);
      const dayExpense = roundMoney(item.expense);
      return {
        day,
        expense: dayExpense,
        income: dayIncome,
        balance: roundMoney(dayIncome - dayExpense),
      };
    });

  const buildRanking = (side: 'income' | 'expense') => {
    if (rankMode !== 'both' && rankMode !== side) return [];
    return txns
      .filter((txn) => !txn.isInitialBalance && txn.transactionType === side)
      .sort((a, b) => b.absAmount - a.absAmount || b.happenedAt.localeCompare(a.happenedAt))
      .slice(0, rankLimit)
      .map((txn) => {
        const resolved = resolveFinanceStatsCategory(
          { flow_category_id: txn.flowCategoryId, extra_data: txn.extraData },
          categoryById,
          categoryByName,
        );
        const categoryName = resolved.name === UNCATEGORIZED_NAME ? null : resolved.name;
        return {
          id: txn.id,
          name: categoryName ? `${categoryName}-${txn.name}` : txn.name,
          categoryName,
          note: txn.note ?? txn.aiComment,
          amount: roundMoney(txn.absAmount),
          happenedAt: txn.happenedAt,
        };
      });
  };

  const sampleTransactions = txns
    .slice()
    .sort((a, b) => b.absAmount - a.absAmount || b.happenedAt.localeCompare(a.happenedAt))
    .slice(0, STATS_SAMPLE_LIMIT)
    .map((txn) => ({
      id: txn.id,
      name: txn.name,
      happened_at: txn.happenedAt,
      transaction_type: txn.transactionType,
      flow_category_id: txn.flowCategoryId,
      amount: roundMoney(txn.absAmount),
      note: txn.note,
      ai_comment: txn.aiComment,
      extra_data: txn.extraData,
    }));

  return {
    summary: {
      income,
      expense,
      balance,
      days,
      txnCount: txns.length,
    },
    categories: {
      expense:
        categoryMode === 'income' ? [] : buildCategorySide(expenseCats, expense),
      income: categoryMode === 'expense' ? [] : buildCategorySide(incomeCats, income),
    },
    trend: {
      granularity,
      points: trendPoints,
    },
    billTable: {
      total: { expense, income, balance },
      dailyAvg: {
        expense: roundMoney(expense / days),
        income: roundMoney(income / days),
        balance: roundMoney(balance / days),
      },
      recentDays,
    },
    ranking: {
      expense: buildRanking('expense'),
      income: buildRanking('income'),
    },
    sampleTransactions,
    meta: {
      serverTime: serverNowIso(),
      start: params.start,
      end: params.end,
      granularity,
    },
  };
}
