import type { RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import { getTableMeta, type TableMeta } from '../crud.js';
import { formatRecordDateTimesForApi, getLogicalLocalYmd } from '../calendar/logical-day.js';
import { DEFAULT_TASKS_DAY_BOUNDARY } from '../calendar/types.js';
import { addDaysToYmd, countInclusiveYmdDays, isValidYmd } from '../../utils/ymd.js';
import type { AllowedTable } from '../../config/tables.js';

export class ReviewPageError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'ReviewPageError';
  }
}

const DIM_TABLE = 'review_dimensions' as const;
const COL_TABLE = 'review_columns' as const;
const DAILY_TABLE = 'daily_review_journal' as const;
const WEEKLY_TABLE = 'weekly_review_journal' as const;
const MONTHLY_TABLE = 'monthly_review_journal' as const;

const DAILY_MAX_RANGE_DAYS = 93;
const PERIOD_MAX_RANGE_DAYS = 400;
const WEEK_METRICS_MAX_RANGE_DAYS = 31;

const REVIEW_SCOPES = new Set(['daily', 'weekly', 'monthly']);

export interface ReviewHomeParams {
  logicalToday?: string;
  dailyStart?: string;
  dailyEnd?: string;
  weekStart?: string;
  monthStart?: string;
}

export interface ReviewDailyParams {
  start: string;
  end: string;
}

export interface ReviewPeriodParams {
  weekStart?: string;
  monthStart?: string;
  start?: string;
  end?: string;
}

export interface ReviewCatalogParams {
  scope?: string;
}

export interface ReviewWeekMetricsParams {
  start: string;
  end: string;
  rangeKind?: string;
}

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function serverNowIso(): string {
  return new Date().toISOString();
}

function monthStartOf(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

function requireYmd(value: string | undefined, field: string): string {
  const raw = value?.trim() ?? '';
  if (!raw || !isValidYmd(raw)) {
    throw new ReviewPageError(`${field} 须为 YYYY-MM-DD`);
  }
  return raw;
}

function optionalYmd(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (!isValidYmd(raw)) {
    throw new ReviewPageError('日期须为 YYYY-MM-DD');
  }
  return raw;
}

function assertRange(start: string, end: string, maxDays: number, label: string): void {
  if (start > end) {
    throw new ReviewPageError(`${label} 起始日不能晚于结束日`);
  }
  const days = countInclusiveYmdDays(start, end);
  if (days > maxDays) {
    throw new ReviewPageError(`${label} 区间最长 ${maxDays} 天`);
  }
}

/** 墙上时钟取日历日：LEFT(REPLACE(TRIM(col),'T',' '),10)，禁止当 UTC 再偏移 */
function wallClockYmdSql(column: string, alias = ''): string {
  const col = alias ? `${alias}.${quoteIdent(column)}` : quoteIdent(column);
  return `LEFT(REPLACE(TRIM(${col}), 'T', ' '), 10)`;
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

function keepRawStringField(
  formatted: Record<string, unknown>,
  row: Record<string, unknown>,
  key: string,
): void {
  if (!(key in row)) return;
  const raw = row[key];
  if (raw == null) {
    formatted[key] = raw;
  } else if (typeof raw === 'string') {
    formatted[key] = raw;
  } else if (typeof raw === 'object') {
    try {
      formatted[key] = JSON.stringify(raw);
    } catch {
      formatted[key] = String(raw);
    }
  } else {
    formatted[key] = String(raw);
  }
}

function formatReviewRow(row: Record<string, unknown>, table: string): Record<string, unknown> {
  const formatted = formatRecordDateTimesForApi({ ...row }, table);
  keepRawStringField(formatted, row, 'extra_data');
  keepRawStringField(formatted, row, 'body');
  keepRawStringField(formatted, row, 'section_summary');
  keepRawStringField(formatted, row, 'section_plans');
  keepRawStringField(formatted, row, 'section_reflect');
  keepRawStringField(formatted, row, 'section_learnings');
  keepRawStringField(formatted, row, 'section_next_week');
  keepRawStringField(formatted, row, 'ai_coaching');
  return formatted;
}

function formatCnMonthDay(ymd: string): string {
  const month = Number(ymd.slice(5, 7));
  const day = Number(ymd.slice(8, 10));
  return `${month}月${day}日`;
}

export function formatReviewRangeDisplay(start: string, end: string): string {
  return `${formatCnMonthDay(start)} – ${formatCnMonthDay(end)}`;
}

export function formatReviewWeekTitle(start: string, end: string): string {
  return `近七天复盘 · ${formatReviewRangeDisplay(start, end)}`;
}

export function resolveReviewLogicalToday(logicalToday?: string): string {
  const raw = logicalToday?.trim();
  if (raw && isValidYmd(raw)) return raw;
  return getLogicalLocalYmd(new Date(), DEFAULT_TASKS_DAY_BOUNDARY);
}

export function resolveReviewHomeWindow(params: ReviewHomeParams): {
  logicalToday: string;
  dailyStart: string;
  dailyEnd: string;
  weekStart: string;
  monthStart: string;
} {
  const logicalToday = resolveReviewLogicalToday(params.logicalToday);
  const dailyEnd = optionalYmd(params.dailyEnd) ?? logicalToday;
  const dailyStart = optionalYmd(params.dailyStart) ?? addDaysToYmd(dailyEnd, -6);
  assertRange(dailyStart, dailyEnd, DAILY_MAX_RANGE_DAYS, '日刊');
  const weekStart = optionalYmd(params.weekStart) ?? dailyStart;
  const monthStart = optionalYmd(params.monthStart) ?? monthStartOf(logicalToday);
  if (!monthStart.endsWith('-01')) {
    throw new ReviewPageError('monthStart 须为自然月月初 YYYY-MM-01');
  }
  return { logicalToday, dailyStart, dailyEnd, weekStart, monthStart };
}

async function loadDimensions(scope?: string): Promise<Record<string, unknown>[]> {
  const { meta, columns } = await loadMeta(DIM_TABLE);
  const where: string[] = [activeWhereSql(columns)];
  const values: unknown[] = [];
  if (scope && REVIEW_SCOPES.has(scope)) {
    where.push('scope = ?');
    values.push(scope);
  }
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectSql(meta)} FROM ${quoteIdent(DIM_TABLE)}
     WHERE ${where.join(' AND ')}
     ORDER BY sort_order ASC, id ASC`,
    values,
  );
  return (rows as Record<string, unknown>[]).map((row) => formatReviewRow(row, DIM_TABLE));
}

async function loadColumnsForDimensions(dimensionIds: string[]): Promise<Record<string, unknown>[]> {
  if (dimensionIds.length === 0) return [];
  const { meta, columns } = await loadMeta(COL_TABLE);
  const placeholders = dimensionIds.map(() => '?').join(', ');
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectSql(meta)} FROM ${quoteIdent(COL_TABLE)}
     WHERE ${activeWhereSql(columns)}
       AND dimension_id IN (${placeholders})
     ORDER BY sort_order ASC, id ASC`,
    dimensionIds,
  );
  return (rows as Record<string, unknown>[]).map((row) => formatReviewRow(row, COL_TABLE));
}

async function loadDailyJournals(start: string, end: string): Promise<Record<string, unknown>[]> {
  const { meta, columns } = await loadMeta(DAILY_TABLE);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectSql(meta)} FROM ${quoteIdent(DAILY_TABLE)}
     WHERE ${activeWhereSql(columns)}
       AND record_date_ymd BETWEEN ? AND ?
     ORDER BY record_date_ymd ASC, id ASC`,
    [start, end],
  );
  return (rows as Record<string, unknown>[]).map((row) => formatReviewRow(row, DAILY_TABLE));
}

async function loadWeeklyJournals(start: string, end: string): Promise<Record<string, unknown>[]> {
  const { meta, columns } = await loadMeta(WEEKLY_TABLE);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectSql(meta)} FROM ${quoteIdent(WEEKLY_TABLE)}
     WHERE ${activeWhereSql(columns)}
       AND week_start_ymd BETWEEN ? AND ?
     ORDER BY week_start_ymd ASC, id ASC`,
    [start, end],
  );
  return (rows as Record<string, unknown>[]).map((row) => formatReviewRow(row, WEEKLY_TABLE));
}

async function loadMonthlyJournals(start: string, end: string): Promise<Record<string, unknown>[]> {
  const { meta, columns } = await loadMeta(MONTHLY_TABLE);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectSql(meta)} FROM ${quoteIdent(MONTHLY_TABLE)}
     WHERE ${activeWhereSql(columns)}
       AND month_start_ymd BETWEEN ? AND ?
     ORDER BY month_start_ymd ASC, id ASC`,
    [start, end],
  );
  return (rows as Record<string, unknown>[]).map((row) => formatReviewRow(row, MONTHLY_TABLE));
}

async function loadOneByYmd(
  table: typeof WEEKLY_TABLE | typeof MONTHLY_TABLE,
  column: 'week_start_ymd' | 'month_start_ymd',
  ymd: string,
): Promise<Record<string, unknown> | null> {
  const { meta, columns } = await loadMeta(table);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectSql(meta)} FROM ${quoteIdent(table)}
     WHERE ${activeWhereSql(columns)}
       AND ${quoteIdent(column)} = ?
     LIMIT 1`,
    [ymd],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  return row ? formatReviewRow(row, table) : null;
}

function resolvePeriodRange(
  params: ReviewPeriodParams,
  singleKey: 'weekStart' | 'monthStart',
  label: string,
): { start: string; end: string } {
  const startQ = optionalYmd(params.start);
  const endQ = optionalYmd(params.end);
  if (startQ || endQ) {
    const start = startQ ?? endQ!;
    const end = endQ ?? startQ!;
    assertRange(start, end, PERIOD_MAX_RANGE_DAYS, label);
    return { start, end };
  }
  const single = optionalYmd(params[singleKey]);
  if (!single) {
    throw new ReviewPageError(
      singleKey === 'weekStart'
        ? '请提供 weekStart 或 start/end'
        : '请提供 monthStart 或 start/end',
    );
  }
  if (singleKey === 'monthStart' && !single.endsWith('-01')) {
    throw new ReviewPageError('monthStart 须为自然月月初 YYYY-MM-01');
  }
  return { start: single, end: single };
}

export async function getReviewHome(params: ReviewHomeParams) {
  const window = resolveReviewHomeWindow(params);
  const [dimensions, dailyJournals, weeklyJournal, monthlyJournal] = await Promise.all([
    loadDimensions(),
    loadDailyJournals(window.dailyStart, window.dailyEnd),
    loadOneByYmd(WEEKLY_TABLE, 'week_start_ymd', window.weekStart),
    loadOneByYmd(MONTHLY_TABLE, 'month_start_ymd', window.monthStart),
  ]);
  const columns = await loadColumnsForDimensions(
    dimensions.map((d) => String(d.id ?? '')).filter(Boolean),
  );

  return {
    dimensions,
    columns,
    dailyJournals,
    weeklyJournal,
    monthlyJournal,
    meta: {
      serverTime: serverNowIso(),
      logicalToday: window.logicalToday,
      dailyStart: window.dailyStart,
      dailyEnd: window.dailyEnd,
      weekStart: window.weekStart,
      monthStart: window.monthStart,
      catalogComplete: true,
    },
  };
}

export async function getReviewCatalog(params: ReviewCatalogParams) {
  const raw = params.scope?.trim().toLowerCase();
  const scope =
    !raw || raw === 'all'
      ? undefined
      : REVIEW_SCOPES.has(raw)
        ? raw
        : (() => {
            throw new ReviewPageError('scope 须为 daily | weekly | monthly | all');
          })();

  const dimensions = await loadDimensions(scope);
  const columns = await loadColumnsForDimensions(
    dimensions.map((d) => String(d.id ?? '')).filter(Boolean),
  );

  return {
    dimensions,
    columns,
    meta: {
      serverTime: serverNowIso(),
      catalogComplete: true,
      ...(scope ? { scope } : {}),
    },
  };
}

export async function getReviewDaily(params: ReviewDailyParams) {
  const start = requireYmd(params.start, 'start');
  const end = requireYmd(params.end, 'end');
  assertRange(start, end, DAILY_MAX_RANGE_DAYS, '日刊');
  const journals = await loadDailyJournals(start, end);
  return {
    journals,
    meta: {
      serverTime: serverNowIso(),
      start,
      end,
    },
  };
}

export async function getReviewWeekly(params: ReviewPeriodParams) {
  const { start, end } = resolvePeriodRange(params, 'weekStart', '周刊');
  const journals = await loadWeeklyJournals(start, end);
  return {
    journals,
    meta: {
      serverTime: serverNowIso(),
      start,
      end,
      ...(start === end ? { weekStart: start } : {}),
    },
  };
}

export async function getReviewMonthly(params: ReviewPeriodParams) {
  const { start, end } = resolvePeriodRange(params, 'monthStart', '月刊');
  const journals = await loadMonthlyJournals(start, end);
  return {
    journals,
    meta: {
      serverTime: serverNowIso(),
      start,
      end,
      ...(start === end ? { monthStart: start } : {}),
    },
  };
}

async function countScalar(sql: string, values: unknown[]): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(sql, values);
  return Number(rows[0]?.cnt ?? 0);
}

export async function getReviewWeekMetrics(params: ReviewWeekMetricsParams) {
  const start = requireYmd(params.start, 'start');
  const end = requireYmd(params.end, 'end');
  assertRange(start, end, WEEK_METRICS_MAX_RANGE_DAYS, '周指标');
  const rangeKind = (params.rangeKind?.trim() || 'rolling-7') || 'rolling-7';

  const [tasksMeta, habitsMeta, hciMeta, plansMeta, depositsMeta, txnMeta, wishMeta] =
    await Promise.all([
      loadMeta('tasks'),
      loadMeta('habits'),
      loadMeta('habit_check_ins'),
      loadMeta('savings_plans'),
      loadMeta('savings_plan_deposits'),
      loadMeta('finance_transactions'),
      loadMeta('wish_items'),
    ]);

  const tasksActive = activeWhereSql(tasksMeta.columns);
  const habitsActive = activeWhereSql(habitsMeta.columns, 'h');
  const hciActive = activeWhereSql(hciMeta.columns, 'c');
  const plansActive = activeWhereSql(plansMeta.columns, 'p');
  const depositsActive = activeWhereSql(depositsMeta.columns, 'd');
  const txnActive = activeWhereSql(txnMeta.columns);
  const wishActive = activeWhereSql(wishMeta.columns);

  const completedAtYmd = wallClockYmdSql('completed_at');
  const createdAtYmd = wallClockYmdSql('created_at');
  const depositCreatedYmd = wallClockYmdSql('created_at', 'd');
  const happenedYmd = wallClockYmdSql('happened_at');
  const wishUpdatedYmd = wallClockYmdSql('updated_at');

  const [
    tasksCompleted,
    tasksCreated,
    habitCheckInTotal,
    savingsWeekTotal,
    financeIncome,
    financeExpense,
    wishUpdates,
  ] = await Promise.all([
    countScalar(
      `SELECT COUNT(*) AS cnt FROM ${quoteIdent('tasks')}
       WHERE ${tasksActive}
         AND status = 'done'
         AND completed_at IS NOT NULL AND TRIM(completed_at) != ''
         AND ${completedAtYmd} BETWEEN ? AND ?`,
      [start, end],
    ),
    countScalar(
      `SELECT COUNT(*) AS cnt FROM ${quoteIdent('tasks')}
       WHERE ${tasksActive}
         AND ${createdAtYmd} BETWEEN ? AND ?`,
      [start, end],
    ),
    countScalar(
      `SELECT COALESCE(SUM(c.count), 0) AS cnt
       FROM ${quoteIdent('habit_check_ins')} c
       INNER JOIN ${quoteIdent('habits')} h ON h.id = c.habit_id
       WHERE ${hciActive}
         AND ${habitsActive}
         AND c.record_date BETWEEN ? AND ?`,
      [start, end],
    ),
    countScalar(
      `SELECT COALESCE(SUM(d.amount), 0) AS cnt
       FROM ${quoteIdent('savings_plan_deposits')} d
       INNER JOIN ${quoteIdent('savings_plans')} p ON p.id = d.savings_plan_id
       WHERE ${depositsActive}
         AND ${plansActive}
         AND ${depositCreatedYmd} BETWEEN ? AND ?`,
      [start, end],
    ),
    countScalar(
      `SELECT COALESCE(SUM(ABS(COALESCE(amount, 0))), 0) AS cnt
       FROM ${quoteIdent('finance_transactions')}
       WHERE ${txnActive}
         AND transaction_type = 'income'
         AND ${happenedYmd} BETWEEN ? AND ?`,
      [start, end],
    ),
    countScalar(
      `SELECT COALESCE(SUM(ABS(COALESCE(amount, 0))), 0) AS cnt
       FROM ${quoteIdent('finance_transactions')}
       WHERE ${txnActive}
         AND transaction_type = 'expense'
         AND ${happenedYmd} BETWEEN ? AND ?`,
      [start, end],
    ),
    countScalar(
      `SELECT COUNT(*) AS cnt FROM ${quoteIdent('wish_items')}
       WHERE ${wishActive}
         AND ${wishUpdatedYmd} BETWEEN ? AND ?`,
      [start, end],
    ),
  ]);

  return {
    rangeKind,
    weekStartYmd: start,
    weekEndYmd: end,
    rangeDisplay: formatReviewRangeDisplay(start, end),
    weekTitle: formatReviewWeekTitle(start, end),
    tasksCompleted,
    tasksCreated,
    habitCheckInTotal,
    savingsWeekTotal: Math.round(savingsWeekTotal),
    financeIncome: Math.round(financeIncome),
    financeExpense: Math.round(financeExpense),
    wishUpdates,
    meta: {
      serverTime: serverNowIso(),
      start,
      end,
    },
  };
}
