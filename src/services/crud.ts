import { createHash, randomUUID } from 'crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import {
  type AllowedTable,
  ADMIN_AUTO_MANAGED_COLUMNS,
  ADMIN_DEFAULT_SYNC_STATUS,
  getPrimaryKey,
  HIDDEN_COLUMNS,
  isAllowedTable,
  PASSWORD_FIELDS,
  requiresClientId,
  TABLE_FOREIGN_KEYS,
  TABLE_SYNC_DEPENDS_ON,
} from '../config/tables.js';
import { buildColumnMeta, getColumnLabel, getTableLabel } from '../config/table-labels.js';
import { hashPassword } from '../utils/password.js';
import { buildListQuery, type ListQueryParams } from './list-query.js';
import { formatUtcMySQLDateTime, normalizeDbDateTimeForStorage } from './calendar/logical-day.js';

const DB_DATETIME_COLUMNS = new Set(['created_at', 'updated_at', 'completed_at']);

function normalizeStoredDateTimeFields(payload: Record<string, unknown>): void {
  for (const column of DB_DATETIME_COLUMNS) {
    if (!(column in payload)) continue;
    const raw = payload[column];
    if (raw == null || raw === '') continue;
    const normalized = normalizeDbDateTimeForStorage(raw);
    if (normalized) payload[column] = normalized;
  }
}

export interface TableMeta {
  primaryKey: string;
  columns: string[];
}

const tableMetaCache = new Map<AllowedTable, TableMeta>();

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function assertTable(table: string): AllowedTable {
  if (!isAllowedTable(table)) {
    throw new CrudError(`表 ${table} 不存在或不允许访问`, 404);
  }
  return table;
}

export class CrudError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = -1,
  ) {
    super(message);
    this.name = 'CrudError';
  }
}

export async function getTableMeta(table: AllowedTable): Promise<TableMeta> {
  const cached = tableMetaCache.get(table);
  if (cached) return cached;

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME, COLUMN_KEY
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [table],
  );

  if (rows.length === 0) {
    throw new CrudError(`表 ${table} 不存在`, 404);
  }

  const primaryKey = getPrimaryKey(table);
  const columns = rows.map((r) => r.COLUMN_NAME as string);
  if (!columns.includes(primaryKey)) {
    throw new CrudError(`表 ${table} 主键配置错误`, 500);
  }

  const meta: TableMeta = {
    primaryKey,
    columns,
  };
  tableMetaCache.set(table, meta);
  return meta;
}

const adminAutoColumnSet = new Set<string>(ADMIN_AUTO_MANAGED_COLUMNS);

function getHiddenColumns(table: AllowedTable, meta: TableMeta): string[] {
  const hidden = new Set(HIDDEN_COLUMNS[table] ?? []);
  return meta.columns.filter((c) => hidden.has(c));
}

function stripHidden<T extends Record<string, unknown>>(
  table: AllowedTable,
  meta: TableMeta,
  row: T,
): T {
  const result = { ...row };
  for (const col of getHiddenColumns(table, meta)) {
    delete result[col];
  }
  return result;
}

async function normalizeWriteData(
  table: AllowedTable,
  meta: TableMeta,
  data: Record<string, unknown>,
  isCreate: boolean,
  adminPanel = false,
): Promise<Record<string, unknown>> {
  const allowed = new Set(meta.columns);
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (adminPanel && adminAutoColumnSet.has(key)) continue;
    if (allowed.has(key)) {
      result[key] = value;
    }
  }

  const pwd = PASSWORD_FIELDS[table];
  if (pwd && typeof data[pwd.plain] === 'string' && data[pwd.plain]) {
    result[pwd.hash] = await hashPassword(data[pwd.plain] as string);
    delete result[pwd.plain];
  }

  const now = new Date();
  const nowUtcMySQL = formatUtcMySQLDateTime(now);
  if (isCreate) {
    const needsClientId = requiresClientId(table);
    if (meta.columns.includes('id')) {
      const id = result.id;
      const hasClientId = id != null && String(id).trim() !== '';
      if (needsClientId) {
        if (!hasClientId) {
          throw new CrudError(`创建 ${table} 时必须由客户端提供 id`);
        }
      } else if (!hasClientId) {
        result.id = randomUUID();
      }
    }
    if (meta.columns.includes('title') && (result.title == null || result.title === '')) {
      result.title = '';
    }
    if (adminPanel) {
      if (meta.columns.includes('created_at')) {
        result.created_at = nowUtcMySQL;
      }
      if (meta.columns.includes('sync_status')) {
        result.sync_status = ADMIN_DEFAULT_SYNC_STATUS;
      }
    } else if (meta.columns.includes('created_at') && result.created_at == null) {
      result.created_at = nowUtcMySQL;
    }
  }

  if (meta.columns.includes('updated_at')) {
    if (adminPanel || result.updated_at == null) {
      result.updated_at = nowUtcMySQL;
    }
  }

  normalizeStoredDateTimeFields(result);

  if (!isCreate) {
    delete result[meta.primaryKey];
  }

  if (table === 'tasks' && meta.columns.includes('frog_assigned_on')) {
    const frog = extractFrogAssignedOn(result.extra_data);
    if (frog !== undefined) {
      result.frog_assigned_on = frog;
    }
  }

  return result;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function extractFrogAssignedOn(extraData: unknown): string | null | undefined {
  if (extraData === undefined) return undefined;
  if (extraData === null || extraData === '') return null;
  try {
    const parsed =
      typeof extraData === 'string'
        ? (JSON.parse(extraData) as { frogAssignedOn?: unknown })
        : (extraData as { frogAssignedOn?: unknown });
    const raw = parsed?.frogAssignedOn;
    if (raw == null || raw === '') return null;
    if (typeof raw === 'string' && YMD_RE.test(raw.trim())) return raw.trim();
  } catch {
    /* ignore */
  }
  return null;
}

async function validateForeignKeys(
  table: AllowedTable,
  data: Record<string, unknown>,
): Promise<void> {
  const fkMap = TABLE_FOREIGN_KEYS[table];
  if (!fkMap) return;

  for (const [column, refTable] of Object.entries(fkMap)) {
    if (!refTable) continue;

    const value = data[column];
    if (value == null || value === '') continue;

    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT 1 FROM ${quoteIdent(refTable)} WHERE ${quoteIdent(getPrimaryKey(refTable))} = ? LIMIT 1`,
      [value],
    );
    if (rows.length === 0) {
      const refLabel = getTableLabel(refTable);
      if (table === 'tasks' && column === 'category_id') {
        throw new CrudError(
          `任务分类不存在（category_id=${value}），请先通过 POST /api/data/task_categories 同步任务分类（非 project_categories）`,
          400,
        );
      }
      if (table === 'tasks' && column === 'project_id') {
        throw new CrudError(
          `项目不存在（project_id=${value}），请按顺序先同步 project_categories → projects，再上传 tasks`,
          400,
        );
      }
      if (table === 'projects' && column === 'category_id') {
        throw new CrudError(
          `项目分类不存在（category_id=${value}），请先通过 POST /api/data/project_categories 同步项目分类`,
          400,
        );
      }
      if (table === 'memos' && column === 'dimension_id') {
        throw new CrudError(
          `备忘录维度不存在（dimension_id=${value}），请先通过 POST /api/data/memo_dimensions 同步备忘录维度`,
          400,
        );
      }
      throw new CrudError(
        `${getColumnLabel(table, column)} 引用的 ${refLabel}（${refTable}）不存在，请先同步 ${refTable}`,
        400,
      );
    }
  }
}

export interface ListOptions extends ListQueryParams {}

export async function listRecords(tableName: string, options: ListOptions = {}) {
  const table = assertTable(tableName);
  const meta = await getTableMeta(table);
  const page = Math.max(1, options.page ?? 1);

  const hidden = new Set(getHiddenColumns(table, meta));
  const visibleColumns = meta.columns.filter((c) => !hidden.has(c));
  const built = buildListQuery(table, visibleColumns, options, {
    hasFrogAssignedOnColumn: meta.columns.includes('frog_assigned_on'),
  });
  const limit = Math.min(built.maxLimit, Math.max(1, options.limit ?? 50));
  const offset = (page - 1) * limit;

  const selectCols =
    built.selectFields && built.selectFields.length > 0
      ? built.selectFields.map(quoteIdent).join(', ')
      : visibleColumns.map(quoteIdent).join(', ');

  const whereSql =
    built.whereClauses.length > 0 ? `WHERE ${built.whereClauses.join(' AND ')}` : '';

  const [countRows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM ${quoteIdent(table)} ${whereSql}`,
    built.whereValues,
  );
  const total = Number(countRows[0]?.total ?? 0);

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectCols} FROM ${quoteIdent(table)}
     ${whereSql}
     ORDER BY ${quoteIdent(meta.primaryKey)} DESC
     LIMIT ? OFFSET ?`,
    [...built.whereValues, limit, offset],
  );

  return {
    list: rows.map((row) => stripHidden(table, meta, row as Record<string, unknown>)),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function listAllRecords(
  tableName: string,
  options: ListOptions = {},
  maxRows = 100_000,
) {
  const table = assertTable(tableName);
  const meta = await getTableMeta(table);

  const hidden = new Set(getHiddenColumns(table, meta));
  const visibleColumns = meta.columns.filter((c) => !hidden.has(c));
  const built = buildListQuery(table, visibleColumns, options, {
    hasFrogAssignedOnColumn: meta.columns.includes('frog_assigned_on'),
  });

  const selectCols =
    built.selectFields && built.selectFields.length > 0
      ? built.selectFields.map(quoteIdent).join(', ')
      : visibleColumns.map(quoteIdent).join(', ');

  const whereSql =
    built.whereClauses.length > 0 ? `WHERE ${built.whereClauses.join(' AND ')}` : '';

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectCols} FROM ${quoteIdent(table)}
     ${whereSql}
     ORDER BY ${quoteIdent(meta.primaryKey)} DESC
     LIMIT ?`,
    [...built.whereValues, maxRows],
  );

  return rows.map((row) => stripHidden(table, meta, row as Record<string, unknown>));
}

export interface TableSnapshotMeta {
  count: number;
  maxUpdatedAt: string | null;
  version: string | null;
}

function buildSnapshotVersion(
  count: number,
  maxUpdatedAt: string | null,
  minUpdatedAt: string | null,
): string | null {
  if (count === 0) return null;
  const input = `${maxUpdatedAt ?? ''}|${minUpdatedAt ?? ''}|${count}`;
  return createHash('md5').update(input).digest('hex').slice(0, 8);
}

export async function getTableFilteredSnapshotMeta(
  tableName: string,
  options: ListOptions = {},
): Promise<TableSnapshotMeta> {
  const table = assertTable(tableName);
  const meta = await getTableMeta(table);
  const hidden = new Set(getHiddenColumns(table, meta));
  const visibleColumns = meta.columns.filter((c) => !hidden.has(c));
  const built = buildListQuery(table, visibleColumns, options, {
    hasFrogAssignedOnColumn: meta.columns.includes('frog_assigned_on'),
  });
  const whereSql =
    built.whereClauses.length > 0 ? `WHERE ${built.whereClauses.join(' AND ')}` : '';
  const hasUpdatedAt = meta.columns.includes('updated_at');

  const [rows] = await db.query<RowDataPacket[]>(
    hasUpdatedAt
      ? `SELECT COUNT(*) AS cnt, MAX(updated_at) AS max_updated_at, MIN(updated_at) AS min_updated_at
         FROM ${quoteIdent(table)} ${whereSql}`
      : `SELECT COUNT(*) AS cnt, NULL AS max_updated_at, NULL AS min_updated_at
         FROM ${quoteIdent(table)} ${whereSql}`,
    built.whereValues,
  );

  const row = rows[0];
  const count = Number(row?.cnt ?? 0);
  const maxUpdatedAt = row?.max_updated_at != null ? String(row.max_updated_at) : null;
  const minUpdatedAt = row?.min_updated_at != null ? String(row.min_updated_at) : null;

  return {
    count,
    maxUpdatedAt,
    version: buildSnapshotVersion(count, maxUpdatedAt, minUpdatedAt),
  };
}

export async function getTableSnapshotMeta(tableName: string): Promise<TableSnapshotMeta> {
  return getTableFilteredSnapshotMeta(tableName);
}

export async function getRecord(tableName: string, pkValue: string) {
  const table = assertTable(tableName);
  const meta = await getTableMeta(table);
  const hidden = new Set(getHiddenColumns(table, meta));
  const selectCols = meta.columns
    .filter((c) => !hidden.has(c))
    .map(quoteIdent)
    .join(', ');

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectCols} FROM ${quoteIdent(table)}
     WHERE ${quoteIdent(meta.primaryKey)} = ? LIMIT 1`,
    [pkValue],
  );

  const row = rows[0];
  if (!row) return null;
  return stripHidden(table, meta, row as Record<string, unknown>);
}

export interface CrudWriteOptions {
  adminPanel?: boolean;
}

export async function createRecord(
  tableName: string,
  data: Record<string, unknown>,
  options: CrudWriteOptions = {},
) {
  const table = assertTable(tableName);
  const meta = await getTableMeta(table);
  const payload = await normalizeWriteData(table, meta, data, true, options.adminPanel);

  if (!payload[meta.primaryKey]) {
    throw new CrudError(`创建 ${table} 时必须提供 ${meta.primaryKey}`);
  }

  await validateForeignKeys(table, payload);

  const keys = Object.keys(payload);
  if (keys.length === 0) {
    throw new CrudError('请求体不能为空');
  }

  const cols = keys.map(quoteIdent).join(', ');
  const placeholders = keys.map(() => '?').join(', ');
  const values = keys.map((k) => payload[k]);

  await db.query(
    `INSERT INTO ${quoteIdent(table)} (${cols}) VALUES (${placeholders})`,
    values,
  );

  const pk = String(payload[meta.primaryKey] ?? data[meta.primaryKey]);
  return getRecord(table, pk);
}

export async function updateRecord(
  tableName: string,
  pkValue: string,
  data: Record<string, unknown>,
  options: CrudWriteOptions = {},
) {
  const table = assertTable(tableName);
  const meta = await getTableMeta(table);
  const payload = await normalizeWriteData(table, meta, data, false, options.adminPanel);

  const keys = Object.keys(payload);
  if (keys.length === 0) {
    throw new CrudError('没有可更新的字段');
  }

  await validateForeignKeys(table, payload);

  const sets = keys.map((k) => `${quoteIdent(k)} = ?`).join(', ');
  const values = [...keys.map((k) => payload[k]), pkValue];

  const [result] = await db.query<ResultSetHeader>(
    `UPDATE ${quoteIdent(table)} SET ${sets}
     WHERE ${quoteIdent(meta.primaryKey)} = ?`,
    values,
  );

  if (result.affectedRows === 0) {
    return null;
  }
  return getRecord(table, pkValue);
}

export async function deleteRecord(tableName: string, pkValue: string) {
  const table = assertTable(tableName);

  if (table === 'tasks') {
    const { deleteTaskCascade } = await import('./task-delete.js');
    return deleteTaskCascade(pkValue);
  }

  const pk = getPrimaryKey(table);

  const [result] = await db.query<ResultSetHeader>(
    `DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent(pk)} = ?`,
    [pkValue],
  );

  return result.affectedRows > 0;
}

export async function listTableNames() {
  const { ALLOWED_TABLES } = await import('../config/tables.js');
  const tables = [];

  for (const name of ALLOWED_TABLES) {
    try {
      const meta = await getTableMeta(name);
      const hidden = new Set(getHiddenColumns(name, meta));
      const visibleColumns = meta.columns.filter((c) => !hidden.has(c));
      const fkMap = TABLE_FOREIGN_KEYS[name] ?? {};
      tables.push({
        name,
        label: getTableLabel(name),
        primaryKey: meta.primaryKey,
        primaryKeyLabel: getColumnLabel(name, meta.primaryKey),
        clientIdRequired: requiresClientId(name),
        syncDependsOn: TABLE_SYNC_DEPENDS_ON[name] ?? [],
        autoManagedColumns: [...ADMIN_AUTO_MANAGED_COLUMNS],
        columns: buildColumnMeta(name, visibleColumns).map((col) => ({
          ...col,
          ...(fkMap[col.name] ? { refTable: fkMap[col.name] } : {}),
        })),
      });
    } catch {
      // 数据库中尚未建表时跳过，避免 /api/tables 整体失败
    }
  }

  return tables;
}
