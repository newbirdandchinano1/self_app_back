import type { RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import { getTableMeta, type TableMeta } from '../crud.js';
import { formatRecordDateTimesForApi } from '../calendar/logical-day.js';
import type { AllowedTable } from '../../config/tables.js';

export class ProfilePageError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'ProfilePageError';
  }
}

const USER_TABLE = 'users' as const;
const VISION_TABLE = 'visions' as const;
const WISH_TABLE = 'wish_items' as const;
const SAVINGS_PLAN_TABLE = 'savings_plans' as const;
const SAVINGS_DEPOSIT_TABLE = 'savings_plan_deposits' as const;
const MEMO_DIM_TABLE = 'memo_dimensions' as const;
const MEMO_TABLE = 'memos' as const;
const GOAL_DIM_TABLE = 'goal_dimensions' as const;
const WALLET_TABLE = 'points_wallet' as const;
const WISH_BOARD_TABLE = 'wish_board_items' as const;
const LEDGER_TABLE = 'points_ledger' as const;
const RECIPE_CAT_TABLE = 'recipe_categories' as const;
const RECIPE_ITEM_TABLE = 'recipe_items' as const;

const DEFAULT_WISH_PREVIEW_LIMIT = 12;
const MAX_WISH_PREVIEW_LIMIT = 50;

const RAW_STRING_FIELDS = [
  'extra_data',
  'body',
  'persona_portrait',
  'ingredients_json',
  'steps_json',
  'notes',
  'reason',
  'ai_comment',
  'ai_evaluation',
  'ai_suggestions',
  'description',
] as const;

export interface ProfileHomeParams {
  wishPreviewLimit?: number;
}

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function serverNowIso(): string {
  return new Date().toISOString();
}

export function resolveWishPreviewLimit(raw?: number): number {
  if (raw == null || !Number.isFinite(raw)) return DEFAULT_WISH_PREVIEW_LIMIT;
  return Math.min(MAX_WISH_PREVIEW_LIMIT, Math.max(1, Math.trunc(raw)));
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

function formatProfileRow(row: Record<string, unknown>, table: string): Record<string, unknown> {
  const formatted = formatRecordDateTimesForApi({ ...row }, table);
  for (const key of RAW_STRING_FIELDS) {
    keepRawStringField(formatted, row, key);
  }
  return formatted;
}

function jsonFlagNotDoneSql(columns: Set<string>, paths: string[]): string {
  if (!columns.has('extra_data') || paths.length === 0) return '1=1';
  const extra = quoteIdent('extra_data');
  const checks = paths.map((path) => {
    const unquote = `LOWER(IF(JSON_VALID(${extra}), JSON_UNQUOTE(JSON_EXTRACT(${extra}, '${path}')), NULL))`;
    return `(${unquote} IS NULL OR ${unquote} IN ('', '0', 'false', 'no', 'null'))`;
  });
  return `(
    ${extra} IS NULL OR TRIM(${extra}) = '' OR NOT JSON_VALID(${extra})
    OR (${checks.join(' AND ')})
  )`;
}

/** 未完成心愿：列标志 + extra_data 常见完成字段均为假 */
export function incompleteWishSql(columns: Set<string>): string {
  const parts: string[] = [];
  if (columns.has('is_done')) {
    parts.push(
      `(${quoteIdent('is_done')} IS NULL OR ${quoteIdent('is_done')} IN (0, '0', 'false'))`,
    );
  }
  if (columns.has('fulfilled')) {
    parts.push(
      `(${quoteIdent('fulfilled')} IS NULL OR ${quoteIdent('fulfilled')} IN (0, '0', 'false'))`,
    );
  }
  if (columns.has('status')) {
    parts.push(
      `(${quoteIdent('status')} IS NULL OR ${quoteIdent('status')} NOT IN ('done', 'completed', 'fulfilled', 'purchased'))`,
    );
  }
  parts.push(
    jsonFlagNotDoneSql(columns, [
      '$.is_done',
      '$.isDone',
      '$.fulfilled',
      '$.is_fulfilled',
      '$.purchased',
      '$.is_purchased',
      '$.completed',
      '$.is_completed',
    ]),
  );
  return parts.join(' AND ');
}

function wishOrderSql(columns: Set<string>): string {
  const parts: string[] = [];
  if (columns.has('desire_level')) parts.push(`${quoteIdent('desire_level')} DESC`);
  if (columns.has('price')) parts.push(`${quoteIdent('price')} DESC`);
  if (columns.has('updated_at')) parts.push(`${quoteIdent('updated_at')} DESC`);
  parts.push('id DESC');
  return parts.join(', ');
}

function planExtraWhereSql(columns: Set<string>): string {
  const parts: string[] = [];
  if (columns.has('status')) {
    parts.push(
      `(${quoteIdent('status')} IS NULL OR ${quoteIdent('status')} NOT IN ('archived', 'completed', 'inactive', 'done'))`,
    );
  }
  parts.push(
    jsonFlagNotDoneSql(columns, ['$.archived', '$.inactive', '$.completed', '$.is_archived']),
  );
  return parts.join(' AND ');
}

async function loadSortedRows(
  table: AllowedTable,
  orderSql: string,
  extraWhere = '',
  extraValues: unknown[] = [],
  limit?: number,
): Promise<Record<string, unknown>[]> {
  const { meta, columns } = await loadMeta(table);
  const where = extraWhere ? `${activeWhereSql(columns)} AND ${extraWhere}` : activeWhereSql(columns);
  const limitSql = limit != null ? ' LIMIT ?' : '';
  const values = limit != null ? [...extraValues, limit] : extraValues;
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectSql(meta)} FROM ${quoteIdent(table)}
     WHERE ${where}
     ORDER BY ${orderSql}${limitSql}`,
    values,
  );
  return (rows as Record<string, unknown>[]).map((row) => formatProfileRow(row, table));
}

async function loadDefaultUser(): Promise<Record<string, unknown> | null> {
  const { meta, columns } = await loadMeta(USER_TABLE);
  const preferDefault = columns.has('id')
    ? `(CASE WHEN id = 'default' THEN 0 ELSE 1 END) ASC,`
    : '';
  const created = columns.has('created_at') ? `${quoteIdent('created_at')} ASC,` : '';
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectSql(meta)} FROM ${quoteIdent(USER_TABLE)}
     WHERE ${activeWhereSql(columns)}
     ORDER BY ${preferDefault} ${created} id ASC
     LIMIT 1`,
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  return row ? formatProfileRow(row, USER_TABLE) : null;
}

export async function getProfileHome(params: ProfileHomeParams = {}) {
  const wishPreviewLimit = resolveWishPreviewLimit(params.wishPreviewLimit);
  const wishMeta = await loadMeta(WISH_TABLE);
  const [user, visions, wishPreview] = await Promise.all([
    loadDefaultUser(),
    loadSortedRows(VISION_TABLE, 'sort_order ASC, id ASC'),
    loadSortedRows(
      WISH_TABLE,
      wishOrderSql(wishMeta.columns),
      incompleteWishSql(wishMeta.columns),
      [],
      wishPreviewLimit,
    ),
  ]);

  return {
    user,
    visions,
    wishPreview,
    meta: {
      serverTime: serverNowIso(),
      wishPreviewLimit,
    },
  };
}

export async function getProfileWishList() {
  const [wishMeta, planMeta] = await Promise.all([
    loadMeta(WISH_TABLE),
    loadMeta(SAVINGS_PLAN_TABLE),
  ]);
  const [wishItems, savingsPlans] = await Promise.all([
    loadSortedRows(WISH_TABLE, wishOrderSql(wishMeta.columns)),
    loadSortedRows(
      SAVINGS_PLAN_TABLE,
      columnsHasCreated(planMeta.columns),
      planExtraWhereSql(planMeta.columns),
    ),
  ]);

  const planIds = savingsPlans
    .map((row) => (typeof row.id === 'string' ? row.id : String(row.id ?? '')))
    .filter(Boolean);

  let savingsDeposits: Record<string, unknown>[] = [];
  if (planIds.length > 0) {
    const placeholders = planIds.map(() => '?').join(', ');
    savingsDeposits = await loadSortedRows(
      SAVINGS_DEPOSIT_TABLE,
      'created_at DESC, id DESC',
      `savings_plan_id IN (${placeholders})`,
      planIds,
    );
  }

  return {
    wishItems,
    savingsPlans,
    savingsDeposits,
    meta: { serverTime: serverNowIso() },
  };
}

function columnsHasCreated(columns: Set<string>): string {
  return columns.has('created_at') ? 'created_at ASC, id ASC' : 'id ASC';
}

export async function getProfileMemoList() {
  const [dimensions, memos] = await Promise.all([
    loadSortedRows(MEMO_DIM_TABLE, 'sort_order ASC, created_at ASC, id ASC'),
    loadSortedRows(MEMO_TABLE, 'updated_at DESC, id DESC'),
  ]);
  return {
    dimensions,
    memos,
    meta: { serverTime: serverNowIso() },
  };
}

export async function getProfileVisionWall() {
  const [user, visions, goalDimensions] = await Promise.all([
    loadDefaultUser(),
    loadSortedRows(VISION_TABLE, 'sort_order ASC, id ASC'),
    loadSortedRows(GOAL_DIM_TABLE, 'sort_order ASC, id ASC'),
  ]);
  return {
    user,
    visions,
    goalDimensions,
    meta: { serverTime: serverNowIso() },
  };
}

export async function getProfileWishBoard() {
  const [pointsWallet, items, pointsLedger] = await Promise.all([
    loadSortedRows(WALLET_TABLE, 'id ASC'),
    loadSortedRows(WISH_BOARD_TABLE, 'sort_order ASC, updated_at DESC, id ASC', `status = 'active'`),
    loadSortedRows(LEDGER_TABLE, 'created_at DESC, id DESC'),
  ]);
  return {
    pointsWallet,
    items,
    pointsLedger,
    meta: { serverTime: serverNowIso() },
  };
}

export async function getProfileRecipes() {
  const [categories, items] = await Promise.all([
    loadSortedRows(RECIPE_CAT_TABLE, 'created_at ASC, id ASC'),
    loadSortedRows(RECIPE_ITEM_TABLE, 'created_at ASC, id ASC'),
  ]);
  return {
    categories,
    items,
    meta: { serverTime: serverNowIso() },
  };
}
