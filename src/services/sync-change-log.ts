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
 * Phase 1 任务域高频表：经 CRUD / frog / task-delete 写入时追加 Change Log。
 * 其余业务域在 Phase 4 再覆盖。
 */
export const PHASE1_CHANGE_LOG_TABLES = new Set<string>([
  'tasks',
  'task_items',
  'habits',
  'habit_check_ins',
  'projects',
  'frog_completion_events',
  'schedule_placements',
  'schedule_week_axis_snapshot',
  'task_execution_events',
  'project_completion_logs',
]);

export function isPhase1ChangeLogTable(table: string): boolean {
  return PHASE1_CHANGE_LOG_TABLES.has(table);
}

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

/** 业务写 + Change Log 共用事务；commit 后广播 SSE */
export async function withSyncTransaction<T>(
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();

    const pending = pendingPublishByConn.get(conn);
    pendingPublishByConn.delete(conn);
    if (pending && pending.dirtyTables.size > 0) {
      try {
        // 动态 import，避免与 sync-sse-hub 循环依赖
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

    return result;
  } catch (err) {
    pendingPublishByConn.delete(conn);
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
