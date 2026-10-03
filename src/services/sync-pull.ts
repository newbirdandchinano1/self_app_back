import type { RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import { DEFAULT_SYNC_USER_ID } from './sync-change-log.js';

export type SyncChangeEventDto = {
  id: number;
  table: string;
  pk: string;
  op: 'upsert' | 'delete';
  updatedAt: string | null;
  deviceId: string | null;
  serverRev: number | null;
  mutationId: string | null;
  row: Record<string, unknown> | null;
};

export type SyncChangesResult = {
  serverTime: string;
  cursor: number;
  hasMore: boolean;
  needFullSync: boolean;
  events: SyncChangeEventDto[];
  dirtyTables: string[];
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export type PullSyncChangesInput = {
  since?: number | string | null;
  limit?: number | string | null;
  userId?: string | null;
};

function parseNonNegInt(raw: unknown, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * 按游标拉取 Change Log 增量。
 * - since=0：从最早保留事件开始
 * - since 落在已清理窗口之前：needFullSync=true（客户端应全量兜底后重置 cursor）
 */
export async function pullSyncChanges(
  input: PullSyncChangesInput = {},
): Promise<SyncChangesResult> {
  const userId = (input.userId && String(input.userId).trim()) || DEFAULT_SYNC_USER_ID;
  const since = parseNonNegInt(input.since, 0);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseNonNegInt(input.limit, DEFAULT_LIMIT)),
  );

  const [boundsRows] = await db.query<RowDataPacket[]>(
    `SELECT MIN(id) AS min_id, MAX(id) AS max_id
     FROM sync_change_log
     WHERE user_id = ?`,
    [userId],
  );
  const minId =
    boundsRows[0]?.min_id == null ? null : Number(boundsRows[0].min_id);
  const maxId =
    boundsRows[0]?.max_id == null ? null : Number(boundsRows[0].max_id);

  const serverTime = new Date().toISOString();

  // 游标落后于保留窗口：丢失中间事件，要求全量（禁止把 cursor 跳到 maxId，必须保留 since 等 bootstrap 成功后才推进）
  if (since > 0 && minId != null && since + 1 < minId) {
    return {
      serverTime,
      cursor: since,
      hasMore: false,
      needFullSync: true,
      events: [],
      dirtyTables: [],
    };
  }

  if (maxId == null || since >= maxId) {
    return {
      serverTime,
      cursor: maxId ?? since,
      hasMore: false,
      needFullSync: false,
      events: [],
      dirtyTables: [],
    };
  }

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, table_name, record_pk, op, updated_at, device_id, server_rev, mutation_id
     FROM sync_change_log
     WHERE user_id = ? AND id > ?
     ORDER BY id ASC
     LIMIT ?`,
    [userId, since, limit + 1],
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  // 同页同 pk 折叠：只保留最后一条（用其 serverRev/mutationId/op）
  const folded = new Map<string, RowDataPacket>();
  for (const r of page) folded.set(`${r.table_name}||${r.record_pk}`, r);
  // 批量取 upsert 当前行（按表分组 IN 查询，避免 N+1）
  const upsertsByTable = new Map<string, string[]>();
  for (const r of folded.values()) {
    if (String(r.op) !== 'delete') {
      const t = String(r.table_name);
      const arr = upsertsByTable.get(t) ?? [];
      arr.push(String(r.record_pk));
      upsertsByTable.set(t, arr);
    }
  }
  const rowMap = new Map<string, Record<string, unknown>>();
  for (const [table, pks] of upsertsByTable) {
    try {
      const uniq = [...new Set(pks)].slice(0, 500);
      if (uniq.length === 0) continue;
      const placeholders = uniq.map(() => '?').join(',');
      // 表名白名单校验：非允许表跳过行体（仍返回事件，row=null）
      const { isAllowedTable, getPrimaryKey } = await import('../config/tables.js');
      if (!isAllowedTable(table)) continue;
      const pkCol = getPrimaryKey(table as never);
      const [liveRows] = await db.query<RowDataPacket[]>(
        `SELECT * FROM \`${table.replace(/`/g, '``')}\` WHERE \`${pkCol.replace(/`/g, '``')}\` IN (${placeholders})`,
        uniq,
      );
      for (const lr of liveRows) {
        const pkVal = String((lr as Record<string, unknown>)[pkCol] ?? '');
        if (pkVal) rowMap.set(`${table}||${pkVal}`, { ...(lr as Record<string, unknown>) });
      }
    } catch {
      // 单表取行失败不阻塞整页；对应 row 置 null，客户端按旧脏表路径兜底
    }
  }
  const events: SyncChangeEventDto[] = [...folded.values()]
    .map((r) => ({
      id: Number(r.id),
      table: String(r.table_name),
      pk: String(r.record_pk),
      op: r.op === 'delete' ? 'delete' : 'upsert',
      updatedAt: r.updated_at == null ? null : String(r.updated_at),
      deviceId: r.device_id == null ? null : String(r.device_id),
      serverRev: r.server_rev == null ? null : Number(r.server_rev),
      mutationId: r.mutation_id == null ? null : String(r.mutation_id),
      row: (rowMap.get(`${String(r.table_name)}||${String(r.record_pk)}`) ?? null) as Record<string, unknown> | null,
    }))
    .sort((a, b) => a.id - b.id);

  const dirtySet = new Set<string>();
  for (const ev of events) dirtySet.add(ev.table);
  const dirtyTables = [...dirtySet].sort();

  const cursor =
    events.length > 0 ? events[events.length - 1]!.id : since;

  return {
    serverTime,
    cursor,
    hasMore,
    needFullSync: false,
    events,
    dirtyTables,
  };
}
