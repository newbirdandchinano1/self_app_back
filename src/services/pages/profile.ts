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

const MEMO_DIM_TABLE = 'memo_dimensions' as const;
const MEMO_TABLE = 'memos' as const;
const WALLET_TABLE = 'points_wallet' as const;
const LEDGER_TABLE = 'points_ledger' as const;
const RECIPE_CAT_TABLE = 'recipe_categories' as const;
const RECIPE_ITEM_TABLE = 'recipe_items' as const;

const RAW_STRING_FIELDS = [
  'extra_data',
  'body',
  'ingredients_json',
  'steps_json',
  'notes',
  'reason',
  'ai_evaluation',
  'ai_suggestions',
  'description',
] as const;

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function serverNowIso(): string {
  return new Date().toISOString();
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

export async function getProfilePoints() {
  const [pointsWallet, pointsLedger] = await Promise.all([
    loadSortedRows(WALLET_TABLE, 'id ASC'),
    loadSortedRows(LEDGER_TABLE, 'created_at DESC, id DESC'),
  ]);
  return {
    pointsWallet,
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
