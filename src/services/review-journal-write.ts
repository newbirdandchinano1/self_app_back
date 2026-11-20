/**
 * 复盘 journal 语义写：按栏目合并 PATCH、空栏填入事实/rollup。
 * 对齐 App 不覆盖非空栏规则；写库走 sync change log。
 */
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import { formatUtcMySQLDateTime } from './calendar/logical-day.js';
import { getTableMeta } from './crud.js';
import {
  BUILTIN_COLUMN_IDS,
  REVIEW_BODY_VERSION,
  WEEKDAY_LABELS,
  builtinReviewFactsFieldPatch,
  loadReviewDayFacts,
  loadReviewPeriodFacts,
  reviewDayFactsIsEmpty,
  reviewFactsTextForColumn,
  type ReviewFactsScope,
} from './review-facts.js';
import { getReviewSettings } from './review-settings.js';
import { ReviewPageError, resolveReviewLogicalToday } from './pages/review.js';
import {
  appendChangeLog,
  withSyncTransaction,
  type SyncWriteOptions,
} from './sync-change-log.js';
import { stampLiveUpsert } from './sync-revision.js';
import { addDaysToYmd, isValidYmd } from '../utils/ymd.js';

export { ReviewPageError as ReviewJournalWriteError };

type FieldMap = Record<string, string>;

type JournalMeta = {
  weather?: string;
  mood?: string;
  ai_analysis?: string;
};

const SCOPE_TABLE = {
  daily: {
    table: 'daily_review_journal' as const,
    periodColumn: 'record_date_ymd' as const,
    idPrefix: 'drj_',
  },
  weekly: {
    table: 'weekly_review_journal' as const,
    periodColumn: 'week_start_ymd' as const,
    idPrefix: 'wrj_',
  },
  monthly: {
    table: 'monthly_review_journal' as const,
    periodColumn: 'month_start_ymd' as const,
    idPrefix: 'mrj_',
  },
};

const MODULE_KEYS = ['health', 'tasks', 'finance', 'routine', 'defects', 'ideas'] as const;

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function activeWhereSql(columns: Set<string>): string {
  const parts: string[] = [];
  if (columns.has('deleted_at')) parts.push('deleted_at IS NULL');
  if (columns.has('sync_status')) {
    parts.push(`(sync_status IS NULL OR sync_status != 'pending_delete')`);
  }
  return parts.length > 0 ? parts.join(' AND ') : '1=1';
}

function requireScope(raw: unknown): ReviewFactsScope {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (s === 'daily' || s === 'weekly' || s === 'monthly') return s;
  throw new ReviewPageError('scope 须为 daily | weekly | monthly');
}

function requireYmd(value: unknown, field: string): string {
  const raw = String(value ?? '').trim();
  if (!raw || !isValidYmd(raw)) {
    throw new ReviewPageError(`${field} 须为 YYYY-MM-DD`);
  }
  return raw;
}

function journalId(scope: ReviewFactsScope, periodYmd: string): string {
  return `${SCOPE_TABLE[scope].idPrefix}${periodYmd.replace(/-/g, '')}`;
}

function monthStartOf(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

function monthEndOf(monthStartYmd: string): string {
  const y = Number(monthStartYmd.slice(0, 4));
  const m = Number(monthStartYmd.slice(5, 7));
  const last = new Date(y, m, 0).getDate();
  return `${monthStartYmd.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}

function emptyFields(columnIds: string[]): FieldMap {
  const out: FieldMap = {};
  for (const id of columnIds) out[id] = '';
  return out;
}

function parseBodyFields(raw: string | null | undefined, columnIds: string[]): FieldMap {
  const empty = emptyFields(columnIds);
  if (!raw || !String(raw).trim()) return empty;
  const s = String(raw).trim();
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    if (o && typeof o === 'object') {
      if (o.v === REVIEW_BODY_VERSION && o.fields && typeof o.fields === 'object') {
        const fields = o.fields as Record<string, unknown>;
        const out = { ...empty };
        for (const [id, val] of Object.entries(fields)) {
          if (val != null) out[id] = String(val);
        }
        for (const id of columnIds) {
          if (!(id in out)) out[id] = '';
        }
        return out;
      }
      if (o.v === 1) {
        const out = { ...empty };
        for (const id of columnIds) {
          if (o[id] != null) out[id] = String(o[id]);
        }
        return out;
      }
    }
  } catch {
    // plain text
  }
  if (columnIds.length > 0) return { ...empty, [columnIds[0]!]: s };
  return empty;
}

function parseBodyMeta(raw: string | null | undefined): JournalMeta {
  if (!raw || !String(raw).trim()) return {};
  try {
    const o = JSON.parse(String(raw).trim()) as Record<string, unknown>;
    if (!o?.meta || typeof o.meta !== 'object') return {};
    const m = o.meta as Record<string, unknown>;
    const meta: JournalMeta = {};
    if (m.weather != null) meta.weather = String(m.weather);
    if (m.mood != null) meta.mood = String(m.mood);
    if (m.ai_analysis != null) meta.ai_analysis = String(m.ai_analysis);
    return meta;
  } catch {
    return {};
  }
}

function serializeBody(fields: FieldMap, meta?: JournalMeta): string {
  const payload: Record<string, unknown> = { v: REVIEW_BODY_VERSION, fields };
  if (meta && (meta.weather || meta.mood || meta.ai_analysis)) {
    payload.meta = meta;
  }
  return JSON.stringify(payload);
}

function serializeWeeklyExtra(fields: FieldMap): string {
  return JSON.stringify({ body_v: REVIEW_BODY_VERSION, fields });
}

function parseWeeklyFields(
  row: Record<string, unknown> | null,
  columnIds: string[],
): FieldMap {
  const empty = emptyFields(columnIds);
  if (!row) return empty;
  const extra = row.extra_data == null ? '' : String(row.extra_data);
  if (extra.trim()) {
    try {
      const o = JSON.parse(extra) as Record<string, unknown>;
      if (o?.body_v === REVIEW_BODY_VERSION && o.fields && typeof o.fields === 'object') {
        const fields = o.fields as Record<string, unknown>;
        const out = { ...empty };
        for (const [id, val] of Object.entries(fields)) {
          if (val != null) out[id] = String(val);
        }
        for (const id of columnIds) {
          if (!(id in out)) out[id] = '';
        }
        return out;
      }
    } catch {
      // fall through
    }
  }
  return empty;
}

async function loadColumnIds(scope: ReviewFactsScope): Promise<string[]> {
  const dimMeta = await getTableMeta('review_dimensions');
  const colMeta = await getTableMeta('review_columns');
  const dimActive = activeWhereSql(new Set(dimMeta.columns));
  const [dimRows] = await db.query<RowDataPacket[]>(
    `SELECT id FROM ${quoteIdent('review_dimensions')}
     WHERE ${dimActive} AND scope = ?
     ORDER BY sort_order ASC, id ASC`,
    [scope],
  );
  const ids = dimRows.map((r) => String(r.id ?? '')).filter(Boolean);
  if (ids.length === 0) {
    return Object.values(BUILTIN_COLUMN_IDS[scope]);
  }
  const placeholders = ids.map(() => '?').join(', ');
  const colActive = activeWhereSql(new Set(colMeta.columns));
  const [colRows] = await db.query<RowDataPacket[]>(
    `SELECT id FROM ${quoteIdent('review_columns')}
     WHERE ${colActive} AND dimension_id IN (${placeholders})
     ORDER BY sort_order ASC, id ASC`,
    ids,
  );
  const columnIds = colRows.map((r) => String(r.id ?? '')).filter(Boolean);
  return columnIds.length > 0 ? columnIds : Object.values(BUILTIN_COLUMN_IDS[scope]);
}

async function loadJournalRow(
  scope: ReviewFactsScope,
  periodYmd: string,
): Promise<Record<string, unknown> | null> {
  const { table, periodColumn } = SCOPE_TABLE[scope];
  const meta = await getTableMeta(table);
  const cols = new Set(meta.columns);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT * FROM ${quoteIdent(table)}
     WHERE ${activeWhereSql(cols)}
       AND ${quoteIdent(periodColumn)} = ?
     LIMIT 1`,
    [periodYmd],
  );
  return (rows[0] as Record<string, unknown> | undefined) ?? null;
}

function fillEmptyOnly(base: FieldMap, patch: FieldMap): { next: FieldMap; filled: string[] } {
  const next = { ...base };
  const filled: string[] = [];
  for (const [id, value] of Object.entries(patch)) {
    const v = (value ?? '').trim();
    if (!v) continue;
    if ((next[id] ?? '').trim()) continue;
    next[id] = value;
    filled.push(id);
  }
  return { next, filled };
}

function mergeOverwrite(
  base: FieldMap,
  patch: FieldMap,
  opts?: { onlyEmpty?: boolean },
): { next: FieldMap; changed: string[] } {
  if (opts?.onlyEmpty) {
    const r = fillEmptyOnly(base, patch);
    return { next: r.next, changed: r.filled };
  }
  const next = { ...base };
  const changed: string[] = [];
  for (const [id, value] of Object.entries(patch)) {
    if (value == null) continue;
    const prev = next[id] ?? '';
    if (prev === value) continue;
    next[id] = String(value);
    changed.push(id);
  }
  return { next, changed };
}

function ymdDow(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y!, m! - 1, d!).getDay();
}

function formatCnMonthDay(ymd: string): string {
  return `${Number(ymd.slice(5, 7))}月${Number(ymd.slice(8, 10))}日`;
}

function aggregateChildFields(opts: {
  children: { label: string; fields: FieldMap }[];
  childScope: 'daily' | 'weekly';
  parentScope: 'weekly' | 'monthly';
}): FieldMap {
  const out: FieldMap = {};
  for (const key of MODULE_KEYS) {
    const parentId = BUILTIN_COLUMN_IDS[opts.parentScope][key];
    const childId = BUILTIN_COLUMN_IDS[opts.childScope][key];
    const blocks: string[] = [];
    for (const child of opts.children) {
      const raw = (child.fields[childId] ?? '').trim();
      if (!raw) continue;
      blocks.push(`【${child.label}】\n${raw}`);
    }
    out[parentId] = blocks.join('\n\n');
  }
  return out;
}

async function upsertJournalFields(
  scope: ReviewFactsScope,
  periodYmd: string,
  fields: FieldMap,
  meta: JournalMeta,
  options: SyncWriteOptions,
): Promise<{ id: string; created: boolean }> {
  const { table, periodColumn } = SCOPE_TABLE[scope];
  const id = journalId(scope, periodYmd);
  const now = formatUtcMySQLDateTime(new Date());
  const existing = await loadJournalRow(scope, periodYmd);
  const tableMeta = await getTableMeta(table);
  const cols = new Set(tableMeta.columns);

  return withSyncTransaction(async (conn) => {
    let created = false;
    if (scope === 'weekly') {
      const extra = serializeWeeklyExtra(fields);
      if (existing) {
        await conn.query<ResultSetHeader>(
          `UPDATE ${quoteIdent(table)}
           SET extra_data = ?, updated_at = ?, sync_status = 'synced'
           WHERE ${quoteIdent(periodColumn)} = ?`,
          [extra, now, periodYmd],
        );
      } else {
        created = true;
        await conn.query<ResultSetHeader>(
          `INSERT INTO ${quoteIdent(table)}
             (id, week_start_ymd, section_summary, section_plans, section_reflect,
              section_learnings, section_next_week, execution_score, ai_coaching,
              adjust_tasks, adjust_savings, adjust_plans,
              created_at, updated_at, sync_status, extra_data)
           VALUES (?, ?, '', '', '', '', '', 0, NULL, 0, 0, 0, ?, ?, 'synced', ?)`,
          [id, periodYmd, now, now, extra],
        );
      }
    } else {
      const body = serializeBody(fields, meta);
      if (existing) {
        await conn.query<ResultSetHeader>(
          `UPDATE ${quoteIdent(table)}
           SET body = ?, updated_at = ?, sync_status = 'synced'
           WHERE ${quoteIdent(periodColumn)} = ?`,
          [body, now, periodYmd],
        );
      } else {
        created = true;
        if (scope === 'daily') {
          const hasDeleted = cols.has('deleted_at');
          const hasVersion = cols.has('version');
          await conn.query<ResultSetHeader>(
            `INSERT INTO ${quoteIdent(table)}
               (id, record_date_ymd, body, created_at, updated_at, sync_status
                ${hasDeleted ? ', deleted_at' : ''}
                ${hasVersion ? ', version' : ''}
                ${cols.has('extra_data') ? ', extra_data' : ''})
             VALUES (?, ?, ?, ?, ?, 'synced'
                ${hasDeleted ? ', NULL' : ''}
                ${hasVersion ? ', 1' : ''}
                ${cols.has('extra_data') ? ', NULL' : ''})`,
            [id, periodYmd, body, now, now],
          );
        } else {
          await conn.query<ResultSetHeader>(
            `INSERT INTO ${quoteIdent(table)}
               (id, month_start_ymd, body, created_at, updated_at, sync_status, extra_data)
             VALUES (?, ?, ?, ?, ?, 'synced', NULL)`,
            [id, periodYmd, body, now, now],
          );
        }
      }
    }

    const rowId = existing?.id != null ? String(existing.id) : id;
    const stamp = await stampLiveUpsert(conn, table, rowId, {
      mode: existing ? 'update' : 'insert',
      mutationId: options.mutationId,
      expectedRev: options.expectedRev,
      skipOcc: options.expectedRev == null,
    });
    await appendChangeLog(conn, [
      {
        tableName: table,
        recordPk: rowId,
        op: 'upsert',
        updatedAt: now,
        deviceId: options.deviceId,
        hint: { reason: 'review_journal_write', scope, periodYmd },
        serverRev: stamp.serverRev,
        mutationId: stamp.mutationId,
      },
    ]);
    return { id: rowId, created };
  });
}

export type PatchReviewJournalInput = {
  scope?: unknown;
  period_ymd?: unknown;
  periodYmd?: unknown;
  ymd?: unknown;
  week_start_ymd?: unknown;
  weekStartYmd?: unknown;
  month_start_ymd?: unknown;
  monthStartYmd?: unknown;
  fields?: unknown;
  only_empty?: unknown;
  onlyEmpty?: unknown;
  replace?: unknown;
  logical_today?: unknown;
  logicalToday?: unknown;
};

function resolvePeriodYmd(scope: ReviewFactsScope, input: PatchReviewJournalInput): string {
  if (scope === 'daily') {
    const raw = input.period_ymd ?? input.periodYmd ?? input.ymd;
    if (raw != null && String(raw).trim()) return requireYmd(raw, 'period_ymd');
    return resolveReviewLogicalToday(
      typeof input.logical_today === 'string'
        ? input.logical_today
        : typeof input.logicalToday === 'string'
          ? input.logicalToday
          : undefined,
    );
  }
  if (scope === 'weekly') {
    const raw = input.period_ymd ?? input.periodYmd ?? input.week_start_ymd ?? input.weekStartYmd;
    return requireYmd(raw, 'week_start_ymd');
  }
  const raw = input.period_ymd ?? input.periodYmd ?? input.month_start_ymd ?? input.monthStartYmd;
  const ymd = requireYmd(raw, 'month_start_ymd');
  return monthStartOf(ymd);
}

function normalizeFieldsInput(raw: unknown): FieldMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReviewPageError('fields 须为 { columnId: text } 对象');
  }
  const out: FieldMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = k.trim();
    if (!id) continue;
    out[id] = v == null ? '' : String(v);
  }
  return out;
}

export async function patchReviewJournalFields(
  input: PatchReviewJournalInput,
  options: SyncWriteOptions = {},
) {
  const scope = requireScope(input.scope);
  const periodYmd = resolvePeriodYmd(scope, input);
  const patch = normalizeFieldsInput(input.fields);
  const onlyEmpty = Boolean(input.only_empty ?? input.onlyEmpty);
  const replace = Boolean(input.replace);
  if (Object.keys(patch).length === 0) {
    throw new ReviewPageError('fields 不能为空');
  }

  const columnIds = await loadColumnIds(scope);
  const row = await loadJournalRow(scope, periodYmd);
  const current =
    scope === 'weekly'
      ? parseWeeklyFields(row, columnIds)
      : parseBodyFields(row?.body == null ? null : String(row.body), columnIds);
  const meta =
    scope === 'weekly'
      ? {}
      : parseBodyMeta(row?.body == null ? null : String(row.body));

  const { next, changed } = mergeOverwrite(current, patch, {
    onlyEmpty: onlyEmpty && !replace,
  });
  if (changed.length === 0) {
    return {
      domain: 'review_journal',
      scope,
      period_ymd: periodYmd,
      id: row?.id != null ? String(row.id) : journalId(scope, periodYmd),
      changed_columns: [],
      fields: next,
      created: false,
      note: '无栏目变更（目标栏已有内容或 patch 为空）。',
    };
  }

  const saved = await upsertJournalFields(scope, periodYmd, next, meta, options);
  return {
    domain: 'review_journal',
    scope,
    period_ymd: periodYmd,
    id: saved.id,
    changed_columns: changed,
    fields: next,
    created: saved.created,
    note: onlyEmpty
      ? '已按栏目合并写入（仅空栏）。'
      : '已按栏目合并写入（覆盖指定栏）。',
  };
}

export type FillEmptyReviewInput = {
  scope?: unknown;
  period_ymd?: unknown;
  periodYmd?: unknown;
  ymd?: unknown;
  week_start_ymd?: unknown;
  weekStartYmd?: unknown;
  month_start_ymd?: unknown;
  monthStartYmd?: unknown;
  columns?: unknown;
  column_ids?: unknown;
  columnIds?: unknown;
  replace?: unknown;
  logical_today?: unknown;
  logicalToday?: unknown;
};

function normalizeColumnFilter(raw: unknown): string[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) {
    throw new ReviewPageError('columns 须为栏目 id 数组');
  }
  const ids = raw
    .map((x) => String(x ?? '').trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : null;
}

async function buildDailyFactPatch(
  ymd: string,
  columnFilter: string[] | null,
): Promise<FieldMap> {
  const facts = await loadReviewDayFacts(ymd);
  if (reviewDayFactsIsEmpty(facts)) return {};
  if (!columnFilter) return builtinReviewFactsFieldPatch('daily', facts);
  const patch: FieldMap = {};
  for (const id of columnFilter) {
    const text = reviewFactsTextForColumn(facts, 'daily', id);
    if (text) patch[id] = text;
  }
  return patch;
}

async function buildWeeklyRollupPatch(
  weekStartYmd: string,
  columnFilter: string[] | null,
): Promise<FieldMap> {
  const settings = await getReviewSettings();
  const configuredDow = settings.weekly_review_weekday;
  const weekEnd = addDaysToYmd(weekStartYmd, 6);
  const skip = new Set<string>();
  const children: { label: string; fields: FieldMap }[] = [];
  const dailyColumnIds = await loadColumnIds('daily');

  for (let i = 0; i < 7; i++) {
    const ymd = addDaysToYmd(weekStartYmd, i);
    if (configuredDow != null && ymdDow(ymd) === configuredDow) {
      skip.add(ymd);
      continue;
    }
    const row = await loadJournalRow('daily', ymd);
    const fields = parseBodyFields(
      row?.body == null ? null : String(row.body),
      dailyColumnIds,
    );
    const d = ymdDow(ymd);
    children.push({
      label: `${formatCnMonthDay(ymd)} 周${WEEKDAY_LABELS[d]}`,
      fields,
    });
  }

  const textRollup = aggregateChildFields({
    children,
    childScope: 'daily',
    parentScope: 'weekly',
  });

  let factsPatch: FieldMap = {};
  const activeDays = listDays(weekStartYmd, weekEnd).filter((d) => !skip.has(d));
  if (activeDays.length > 0) {
    const facts = await loadReviewPeriodFacts(activeDays[0]!, activeDays[activeDays.length - 1]!, {
      skipYmds: skip,
    });
    if (!reviewDayFactsIsEmpty(facts)) {
      factsPatch = builtinReviewFactsFieldPatch('weekly', facts);
    }
  }

  const prefer = { ...textRollup, ...factsPatch };
  const structured = new Set([
    BUILTIN_COLUMN_IDS.weekly.health,
    BUILTIN_COLUMN_IDS.weekly.tasks,
    BUILTIN_COLUMN_IDS.weekly.finance,
  ]);
  const out: FieldMap = {};
  for (const [id, value] of Object.entries(prefer)) {
    const v = (value ?? '').trim();
    if (!v) continue;
    if (columnFilter && !columnFilter.includes(id)) continue;
    if (structured.has(id) && (factsPatch[id] ?? '').trim()) {
      out[id] = factsPatch[id]!;
      continue;
    }
    out[id] = value;
  }
  return out;
}

function listDays(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  for (let i = 0; i < 40; i++) {
    out.push(cur);
    if (cur === end) break;
    cur = addDaysToYmd(cur, 1);
  }
  return out;
}

async function buildMonthlyRollupPatch(
  monthStartYmd: string,
  columnFilter: string[] | null,
): Promise<FieldMap> {
  const monthEnd = monthEndOf(monthStartYmd);
  const weeklyColumnIds = await loadColumnIds('weekly');
  const weeklyMeta = await getTableMeta('weekly_review_journal');
  const [weeklyRows] = await db.query<RowDataPacket[]>(
    `SELECT * FROM ${quoteIdent('weekly_review_journal')}
     WHERE ${activeWhereSql(new Set(weeklyMeta.columns))}
       AND week_start_ymd BETWEEN ? AND ?
     ORDER BY week_start_ymd ASC`,
    [monthStartYmd, monthEnd],
  );

  const children = weeklyRows.map((row) => {
    const start = String(row.week_start_ymd ?? '');
    const end = addDaysToYmd(start, 6);
    return {
      label: `${formatCnMonthDay(start)}–${formatCnMonthDay(end)}`,
      fields: parseWeeklyFields(row as Record<string, unknown>, weeklyColumnIds),
    };
  });

  const textRollup = aggregateChildFields({
    children,
    childScope: 'weekly',
    parentScope: 'monthly',
  });

  let factsPatch: FieldMap = {};
  const facts = await loadReviewPeriodFacts(monthStartYmd, monthEnd);
  if (!reviewDayFactsIsEmpty(facts)) {
    factsPatch = builtinReviewFactsFieldPatch('monthly', facts);
  }

  const prefer = { ...textRollup, ...factsPatch };
  const structured = new Set([
    BUILTIN_COLUMN_IDS.monthly.health,
    BUILTIN_COLUMN_IDS.monthly.tasks,
    BUILTIN_COLUMN_IDS.monthly.finance,
  ]);
  const out: FieldMap = {};
  for (const [id, value] of Object.entries(prefer)) {
    const v = (value ?? '').trim();
    if (!v) continue;
    if (columnFilter && !columnFilter.includes(id)) continue;
    if (structured.has(id) && (factsPatch[id] ?? '').trim()) {
      out[id] = factsPatch[id]!;
      continue;
    }
    out[id] = value;
  }
  return out;
}

export async function fillEmptyReviewJournal(
  input: FillEmptyReviewInput,
  options: SyncWriteOptions = {},
) {
  const scope = requireScope(input.scope ?? 'daily');
  const periodYmd = resolvePeriodYmd(scope, input);
  const columnFilter = normalizeColumnFilter(
    input.columns ?? input.column_ids ?? input.columnIds,
  );
  const replace = Boolean(input.replace);

  let patch: FieldMap;
  if (scope === 'daily') {
    patch = await buildDailyFactPatch(periodYmd, columnFilter);
  } else if (scope === 'weekly') {
    patch = await buildWeeklyRollupPatch(periodYmd, columnFilter);
  } else {
    if (!periodYmd.endsWith('-01')) {
      throw new ReviewPageError('month_start_ymd 须为自然月月初 YYYY-MM-01');
    }
    patch = await buildMonthlyRollupPatch(periodYmd, columnFilter);
  }

  if (Object.keys(patch).length === 0) {
    return {
      domain: 'review_fill_empty',
      scope,
      period_ymd: periodYmd,
      filled_columns: [],
      skipped: true,
      note: '无可用事实/汇总可写入。',
    };
  }

  const result = await patchReviewJournalFields(
    {
      scope,
      period_ymd: periodYmd,
      fields: patch,
      only_empty: !replace,
      replace,
    },
    options,
  );

  return {
    domain: 'review_fill_empty',
    scope,
    period_ymd: periodYmd,
    filled_columns: result.changed_columns,
    fields: result.fields,
    id: result.id,
    created: result.created,
    skipped: result.changed_columns.length === 0,
    note:
      result.changed_columns.length === 0
        ? '目标栏目均已有内容，未覆盖（传 replace=true 可强制替换）。'
        : replace
          ? '已写入事实/汇总（含覆盖）。'
          : '已写入空栏事实/汇总。',
  };
}
