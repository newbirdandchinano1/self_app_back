import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';
import { db } from '../db/index.js';

/** 单租户默认账号；多用户时再改为真实 user id */
export const DEFAULT_SYNC_USER_ID = 'default';

export type ChangeLogOp = 'upsert' | 'delete';

export type ChangeLogEvent = {
  tableName: string;
  recordPk: string;
  op: ChangeLogOp;
  /** 业务行时间或服务端写入时间；可空 */
  updatedAt?: string | Date | null;
  deviceId?: string | null;
  userId?: string | null;
  hint?: Record<string, unknown> | null;
};

/** 事务内待广播信号（commit 后投递 SSE） */
type PendingSyncPublish = {
  userId: string;
  deviceId: string | null;
  cursor: number;
  dirtyTables: Set<string>;
};

const pendingPublishByConn = new WeakMap<PoolConnection, PendingSyncPublish>();

/**
 * 参与多端 Change Log 的业务表（Phase 1 任务域 + Phase 4 其余域）。
 * 不含 admin_users / users / app_meta / 整表 app_settings（避免广播配置或敏感字段）。
 * 日界相关 app_settings 键由 CRUD 单独选择性写入 Change Log（见 `isDayBoundaryAppSettingKey`）。
 */
export const SYNC_CHANGE_LOG_TABLES = new Set<string>([
  // Phase 1 — 任务域
  'tasks',
  'task_items',
  'habits',
  'habit_contexts',
  'habit_check_ins',
  'projects',
  'project_categories',
  'task_categories',
  'frog_completion_events',
  'schedule_placements',
  'schedule_week_axis_snapshot',
  'task_execution_events',
  'project_completion_logs',
  // Phase 4 — 财务
  'finance_transactions',
  'finance_accounts',
  'finance_account_types',
  'finance_flow_categories',
  'finance_scheduled_expenses',
  'cash_flow_profile',
  'cash_flow_incomes',
  'cash_flow_holdings',
  'cash_flow_expense_lines',
  'savings_plans',
  'savings_plan_deposits',
  // Phase 4 — 积分 / 心愿
  'points_wallet',
  'points_ledger',
  'wish_board_items',
  // Phase 4 — 备忘 / 标签
  'memos',
  'memo_dimensions',
  'tags',
  'tag_links',
  // Phase 4 — 菜谱
  'recipe_categories',
  'recipe_items',
  // Phase 4 — 健康
  'health_records',
  'health_daily_targets',
  // Phase 4 — 复盘
  'daily_review_journal',
  'weekly_review_journal',
  'monthly_review_journal',
  'review_dimensions',
  'review_columns',
]);

/** @deprecated 使用 SYNC_CHANGE_LOG_TABLES */
export const PHASE1_CHANGE_LOG_TABLES = SYNC_CHANGE_LOG_TABLES;

export function isChangeLogTable(table: string): boolean {
  return SYNC_CHANGE_LOG_TABLES.has(table);
}

/** @deprecated 使用 isChangeLogTable */
export function isPhase1ChangeLogTable(table: string): boolean {
  return isChangeLogTable(table);
}

/**
 * 与 App `AppSettingKey.tasksCompletionDayStart` / `dayBoundaryPages` 对齐。
 * 仅这两项进入 Change Log，供桌面与其它端对齐逻辑日。
 */
export const DAY_BOUNDARY_APP_SETTING_KEYS = new Set<string>([
  '@tasks_completion_day_start_v1',
  '@selfapp/day_boundary_pages_v1',
]);

export function isDayBoundaryAppSettingKey(pk: string): boolean {
  return DAY_BOUNDARY_APP_SETTING_KEYS.has(String(pk ?? '').trim());
}

export type SyncWriteOptions = {
  deviceId?: string | null;
};

function normalizeUpdatedAt(value: string | Date | null | undefined): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return value.toISOString().slice(0, 23).replace('T', ' ');
  }
  const s = String(value).trim();
  if (!s) return null;
  // ISO → MySQL DATETIME(3) 近似
  if (s.includes('T')) {
    return s.replace('T', ' ').replace(/Z$/, '').slice(0, 23);
  }
  return s.slice(0, 23);
}

/**
 * 在同一业务事务连接上追加 Change Log。
 * 失败会抛错 → 调用方 rollback，避免脏 log。
 */
export async function appendChangeLog(
  conn: PoolConnection,
  events: ChangeLogEvent[],
): Promise<void> {
  if (events.length === 0) return;

  const cols =
    'user_id, device_id, table_name, record_pk, op, updated_at, created_at, hint';
  const placeholders = events.map(() => '(?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), ?)').join(', ');
  const values: unknown[] = [];

  for (const ev of events) {
    const tableName = String(ev.tableName ?? '').trim();
    const recordPk = String(ev.recordPk ?? '').trim();
    if (!tableName || !recordPk) {
      throw new Error('appendChangeLog: tableName / recordPk 不能为空');
    }
    if (ev.op !== 'upsert' && ev.op !== 'delete') {
      throw new Error(`appendChangeLog: 非法 op ${String(ev.op)}`);
    }
    values.push(
      (ev.userId && String(ev.userId).trim()) || DEFAULT_SYNC_USER_ID,
      ev.deviceId == null || ev.deviceId === '' ? null : String(ev.deviceId).slice(0, 64),
      tableName.slice(0, 64),
      recordPk.slice(0, 255),
      ev.op,
      normalizeUpdatedAt(ev.updatedAt),
      ev.hint == null ? null : JSON.stringify(ev.hint),
    );
  }

  const [result] = await conn.query<ResultSetHeader>(
    `INSERT INTO sync_change_log (${cols}) VALUES ${placeholders}`,
    values,
  );

  // 多行 INSERT：insertId 为首条，affectedRows 为条数
  const firstId = Number(result.insertId);
  const count = Number(result.affectedRows) || events.length;
  if (Number.isFinite(firstId) && firstId > 0 && count > 0) {
    const cursor = firstId + count - 1;
    const userId =
      (events[0]?.userId && String(events[0].userId).trim()) || DEFAULT_SYNC_USER_ID;
    const deviceId =
      events.find((e) => e.deviceId != null && String(e.deviceId).trim())?.deviceId ?? null;
    const dirty = events.map((e) => String(e.tableName).trim()).filter(Boolean);

    const existing = pendingPublishByConn.get(conn);
    if (existing) {
      existing.cursor = Math.max(existing.cursor, cursor);
      for (const t of dirty) existing.dirtyTables.add(t);
      if (!existing.deviceId && deviceId) {
        existing.deviceId = String(deviceId).slice(0, 64);
      }
    } else {
      pendingPublishByConn.set(conn, {
        userId,
        deviceId: deviceId == null || deviceId === '' ? null : String(deviceId).slice(0, 64),
        cursor,
        dirtyTables: new Set(dirty),
      });
    }
  }
}

/** 自管事务 rollback 时丢弃待广播 */
export function discardPendingSyncPublish(conn: PoolConnection): void {
  pendingPublishByConn.delete(conn);
}

/** 自管事务 commit 后调用，投递 SSE（与 withSyncTransaction 同路径） */
export async function flushPendingSyncPublish(conn: PoolConnection): Promise<void> {
  const pending = pendingPublishByConn.get(conn);
  pendingPublishByConn.delete(conn);
  if (!pending || pending.dirtyTables.size === 0) return;
  try {
    const { publishSyncSignal } = await import('./sync-sse-hub.js');
    publishSyncSignal({
      userId: pending.userId,
      skipDeviceId: pending.deviceId,
      cursor: pending.cursor,
      dirtyTables: [...pending.dirtyTables],
    });
  } catch (err) {
    console.warn('[sync] SSE publish 失败（不影响写成功）', err);
  }
}

/** 业务写 + Change Log 共用事务；commit 后广播 SSE */
export async function withSyncTransaction<T>(
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    await flushPendingSyncPublish(conn);
    return result;
  } catch (err) {
    discardPendingSyncPublish(conn);
    try {
      await conn.rollback();
    } catch {
      // ignore rollback errors
    }
    throw err;
  } finally {
    conn.release();
  }
}

export function resolveDeviceIdFromHeader(
  header: string | string[] | undefined,
): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 64);
}
