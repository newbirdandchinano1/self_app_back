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
import {
  formatDbDateTimeForApi,
  formatMySQLWallClockDateTime,
  formatUtcMySQLDateTime,
  getDbNaiveDateTimeModeForTable,
  looksLikeDateTimeValue,
  normalizeDbDateTimeForTableStorage,
  formatRecordDateTimesForApi,
  parseDbDateTimeToInstant,
} from './calendar/logical-day.js';

const DB_DATETIME_COLUMNS = new Set(['created_at', 'updated_at', 'completed_at', 'redeemed_at']);

function formatNowForTable(table: AllowedTable): string {
  const now = new Date();
  return getDbNaiveDateTimeModeForTable(table) === 'shanghai'
    ? formatMySQLWallClockDateTime(now)
    : formatUtcMySQLDateTime(now);
}

function normalizeStoredDateTimeFields(table: AllowedTable, payload: Record<string, unknown>): void {
  for (const column of DB_DATETIME_COLUMNS) {
    if (!(column in payload)) continue;
    const raw = payload[column];
    if (raw == null || raw === '') continue;
    const normalized = normalizeDbDateTimeForTableStorage(table, raw);
    if (normalized) payload[column] = normalized;
  }
  if ('record_date' in payload && looksLikeDateTimeValue(payload.record_date)) {
    const normalized = normalizeDbDateTimeForTableStorage(table, payload.record_date);
    if (normalized) payload.record_date = normalized;
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
  return formatRecordDateTimesForApi(result, table) as T;
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
  const nowForTable = formatNowForTable(table);
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
        result.created_at = nowForTable;
      }
      if (meta.columns.includes('sync_status')) {
        result.sync_status = ADMIN_DEFAULT_SYNC_STATUS;
      }
    } else if (meta.columns.includes('created_at') && result.created_at == null) {
      result.created_at = nowForTable;
    }
  }

  if (meta.columns.includes('updated_at')) {
    if (adminPanel || result.updated_at == null) {
      result.updated_at = nowForTable;
    }
  }

  normalizeStoredDateTimeFields(table, result);

  if (!isCreate) {
    delete result[meta.primaryKey];
  }

  if (table === 'tasks' && meta.columns.includes('frog_assigned_on')) {
    const frog = extractFrogAssignedOn(result.extra_data);
    if (frog !== undefined) {
      result.frog_assigned_on = frog;
    }
  }

  // 习惯 / 任务 / 项目：整包存 extra_data（含 reward_points）；剥离已下线的 completion_reward
  if (
    (table === 'habits' || table === 'tasks' || table === 'projects') &&
    'extra_data' in result
  ) {
    result.extra_data = normalizeRewardPointsExtraData(result.extra_data);
  }

  if (
    (table === 'tasks' || table === 'projects') &&
    meta.columns.includes('priority') &&
    'priority' in result
  ) {
    result.priority = clampEisenhowerPriority(result.priority);
  }

  if (table === 'users' && meta.columns.includes('persona_portrait') && 'persona_portrait' in result) {
    result.persona_portrait = normalizePersonaPortrait(result.persona_portrait);
  }

  if (table === 'wish_board_items') {
    normalizeWishBoardItemWrite(result, isCreate);
  }

  if (table === 'points_wallet' && 'balance' in result) {
    result.balance = normalizeNonNegativeInt(result.balance, 'balance');
  }

  if (table === 'points_ledger') {
    normalizePointsLedgerWrite(result, isCreate);
  }

  return result;
}

const PERSONA_PORTRAIT_MAX_CHARS = 500;

/** 空串规范为 null；按 Unicode 码点计长，超过 500 拒绝 */
function normalizePersonaPortrait(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value);
  if (text === '') return null;
  if ([...text].length > PERSONA_PORTRAIT_MAX_CHARS) {
    throw new CrudError('persona_portrait 最多 500 字', 400);
  }
  return text;
}

function normalizeNonNegativeInt(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new CrudError(`${field} 必须为 >= 0 的整数`, 400);
  }
  return n;
}

function normalizeOptionalText(
  value: unknown,
  field: string,
  maxChars: number,
): string | null {
  if (value == null || value === '') return null;
  const text = String(value);
  if ([...text].length > maxChars) {
    throw new CrudError(`${field} 最多 ${maxChars} 字`, 400);
  }
  return text;
}

function normalizeWishBoardItemWrite(result: Record<string, unknown>, isCreate: boolean): void {
  if (isCreate || 'title' in result) {
    const title = String(result.title ?? '').trim();
    if (!title) throw new CrudError('心愿名称无效', 400);
    if ([...title].length > 80) throw new CrudError('心愿名称无效', 400);
    result.title = title;
  }

  if (isCreate || 'cost_points' in result) {
    try {
      const raw = isCreate && result.cost_points == null ? 0 : result.cost_points;
      result.cost_points = normalizeNonNegativeInt(raw, 'cost_points');
    } catch {
      throw new CrudError('所需积分无效', 400);
    }
  }

  if ('description' in result) {
    try {
      result.description = normalizeOptionalText(result.description, 'description', 500);
    } catch {
      throw new CrudError('描述最多 500 字', 400);
    }
  }

  if ('note' in result) {
    try {
      result.note = normalizeOptionalText(result.note, 'note', 500);
    } catch {
      throw new CrudError('描述最多 500 字', 400);
    }
  }

  // 创建时 description / note 互相同步（客户端通常双写；缺一则对齐）
  if (isCreate) {
    if (result.description == null && result.note != null) {
      result.description = result.note;
    } else if (result.note == null && result.description != null) {
      result.note = result.description;
    }
  }

  if (isCreate || 'icon_key' in result) {
    const raw = result.icon_key == null ? '' : String(result.icon_key).trim();
    const iconKey = raw || 'card-giftcard';
    if (iconKey.length > 64) throw new CrudError('icon_key 最多 64 字', 400);
    result.icon_key = iconKey;
  }

  if (isCreate || 'wish_type' in result) {
    const wishType = String(result.wish_type ?? (isCreate ? 'once' : '')).trim();
    if (wishType !== 'once' && wishType !== 'repeat') {
      throw new CrudError('心愿类型无效', 400);
    }
    result.wish_type = wishType;
  }

  // 同步可上传已兑换行：保留客户端 status / redeemed_at（勿强制 active）
  if (isCreate || 'status' in result) {
    const status = String(result.status ?? (isCreate ? 'active' : '')).trim();
    if (status !== 'active' && status !== 'redeemed') {
      throw new CrudError('status 仅支持 active / redeemed', 400);
    }
    result.status = status;
  }

  if (isCreate && !('redeemed_at' in result)) {
    result.redeemed_at = null;
  }

  if (isCreate && result.sort_order == null) {
    result.sort_order = 1000;
  }
}

function normalizePointsLedgerWrite(result: Record<string, unknown>, isCreate: boolean): void {
  if (isCreate || 'delta' in result) {
    const n = typeof result.delta === 'number' ? result.delta : Number(result.delta);
    // 允许负 delta（*_undo / wish_redeem / points_reset 等扣回）
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new CrudError('delta 必须为整数', 400);
    }
    result.delta = n;
  }
  if (isCreate || 'balance_after' in result) {
    result.balance_after = normalizeNonNegativeInt(result.balance_after, 'balance_after');
  }
  if (isCreate || 'reason' in result) {
    const reason = String(result.reason ?? '').trim();
    if (!reason) throw new CrudError('reason 必填', 400);
    if (reason.length > 64) throw new CrudError('reason 最多 64 字', 400);
    result.reason = reason;
  }
}

/** 艾森豪威尔优先级：0 未设，1–4 四象限；非法值钳制到 0 */
function clampEisenhowerPriority(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  const i = Math.trunc(n);
  if (i < 0 || i > 4) return 0;
  return i;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 保留整包 JSON；校验 reward_points(0~99999)；移除历史 completion_reward */
function normalizeRewardPointsExtraData(extraData: unknown): unknown {
  if (extraData == null || extraData === '') return extraData;
  try {
    const parsed =
      typeof extraData === 'string' ? (JSON.parse(extraData) as unknown) : extraData;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return extraData;
    const obj = { ...(parsed as Record<string, unknown>) };
    let changed = false;

    if ('completion_reward' in obj) {
      delete obj.completion_reward;
      changed = true;
    }

    if ('reward_points' in obj) {
      const raw = obj.reward_points;
      const n =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string' && raw.trim() !== ''
            ? Number(raw)
            : NaN;
      if (!Number.isFinite(n)) {
        throw new CrudError('reward_points 必须为 0~99999 的整数', 400);
      }
      const clamped = Math.min(99999, Math.max(0, Math.round(n)));
      if (obj.reward_points !== clamped) {
        obj.reward_points = clamped;
        changed = true;
      }
    }

    if (!changed) return extraData;
    return typeof extraData === 'string' ? JSON.stringify(obj) : obj;
  } catch (err) {
    if (err instanceof CrudError) throw err;
    return extraData;
  }
}

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

function listOrderBySql(table: AllowedTable, primaryKey: string): string {
  // 流水按时间倒序，便于客户端拼「已兑换」；UUID 主键无时间语义
  if (table === 'points_ledger') {
    return `${quoteIdent('created_at')} DESC, ${quoteIdent(primaryKey)} DESC`;
  }
  return `${quoteIdent(primaryKey)} DESC`;
}

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
     ORDER BY ${listOrderBySql(table, meta.primaryKey)}
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
     ORDER BY ${listOrderBySql(table, meta.primaryKey)}
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
  const maxUpdatedAtRaw = row?.max_updated_at != null ? String(row.max_updated_at) : null;
  const minUpdatedAtRaw = row?.min_updated_at != null ? String(row.min_updated_at) : null;
  const mode = getDbNaiveDateTimeModeForTable(table);

  return {
    count,
    maxUpdatedAt: maxUpdatedAtRaw ? formatDbDateTimeForApi(maxUpdatedAtRaw, mode) : null,
    version: buildSnapshotVersion(count, maxUpdatedAtRaw, minUpdatedAtRaw),
  };
}

export async function getTableSnapshotMeta(tableName: string): Promise<TableSnapshotMeta> {
  return getTableFilteredSnapshotMeta(tableName);
}

export async function getRecord(tableName: string, pkValue: string) {
  const table = assertTable(tableName);

  // 缺省钱包：不存在则自动创建 balance=0
  if (table === 'points_wallet' && pkValue === 'default') {
    const { getOrCreateDefaultWallet } = await import('./wish-board.js');
    return getOrCreateDefaultWallet();
  }

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

  // 流水权威：同步追加（含负 delta 扣回）后按 SUM(delta) 校正钱包
  if (table === 'points_ledger' && !options.adminPanel) {
    const { reconcilePointsWalletFromLedger } = await import('./wish-board.js');
    await reconcilePointsWalletFromLedger();
  }

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

  if (table === 'wish_board_items') {
    await assertWishBoardItemMutable(pkValue, data);
  }

  if (table === 'points_wallet' && !options.adminPanel) {
    await assertPointsWalletNotStale(pkValue, data);
  }

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

/** 禁止用过期/无时间戳的更高余额覆盖服务端（避免取消扣回后积分被写回去） */
async function assertPointsWalletNotStale(
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!('balance' in data)) return;

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT balance, updated_at FROM points_wallet WHERE id = ? LIMIT 1`,
    [id],
  );
  const serverRow = rows[0];
  if (!serverRow) return;

  const serverBalance = Number(serverRow.balance ?? 0);
  const clientBalanceRaw =
    typeof data.balance === 'number' ? data.balance : Number(data.balance);
  const clientBalance = Number.isFinite(clientBalanceRaw) ? clientBalanceRaw : serverBalance;

  const clientRaw = data.updated_at;
  if (clientRaw == null || clientRaw === '') {
    if (clientBalance > serverBalance) {
      throw new CrudError('积分钱包缺少 updated_at，拒绝用更高余额覆盖', 409);
    }
    return;
  }

  const serverInstant = parseDbDateTimeToInstant(serverRow.updated_at);
  const clientInstant = parseDbDateTimeToInstant(clientRaw);
  if (!serverInstant || !clientInstant) return;

  if (clientInstant.getTime() < serverInstant.getTime()) {
    throw new CrudError('积分钱包已有更新版本，拒绝用过期数据覆盖', 409);
  }
}

/** 一次性已兑换：禁止改 title / cost_points / wish_type→repeat（同值回写允许，便于多端同步） */
async function assertWishBoardItemMutable(
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT status, wish_type, title, cost_points FROM wish_board_items WHERE id = ? LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) return;

  const isRedeemedOnce = row.status === 'redeemed' && (row.wish_type ?? 'once') === 'once';
  if (!isRedeemedOnce) return;

  if (Object.prototype.hasOwnProperty.call(data, 'title')) {
    const nextTitle = String(data.title ?? '').trim();
    if (nextTitle !== String(row.title ?? '').trim()) {
      throw new CrudError('已兑换的心愿不可修改 title / cost_points', 400);
    }
  }

  if (Object.prototype.hasOwnProperty.call(data, 'cost_points')) {
    const nextCost = Number(data.cost_points);
    const serverCost = Number(row.cost_points ?? 0);
    if (!Number.isFinite(nextCost) || Math.trunc(nextCost) !== serverCost) {
      throw new CrudError('已兑换的心愿不可修改 title / cost_points', 400);
    }
  }

  if (Object.prototype.hasOwnProperty.call(data, 'wish_type')) {
    const nextType = String(data.wish_type ?? '').trim();
    if (nextType === 'repeat') {
      throw new CrudError('已兑换的一次性心愿不可改为重复性', 400);
    }
  }
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
