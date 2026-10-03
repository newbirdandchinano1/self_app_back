import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { getPrimaryKey, isAllowedTable } from '../config/tables.js';
import { DEFAULT_SYNC_USER_ID } from './sync-change-log.js';

type Queryable = { query: PoolConnection['query'] };

export type SyncWriteMeta = {
  mutationId?: string | null;
  expectedRev?: number | null;
};

export type SyncOccConflictKind = 'row' | 'tombstone';

export type SyncOccConflictPayload = {
  conflict: true;
  kind: SyncOccConflictKind;
  table: string;
  pk: string;
  serverRev: number | null;
  mutationId: string | null;
  row: Record<string, unknown> | null;
};

/** Push OCC 失败：HTTP 409，body 为当前行或 tombstone */
export class SyncOccConflictError extends Error {
  readonly status = 409;
  readonly payload: SyncOccConflictPayload;

  constructor(payload: Omit<SyncOccConflictPayload, 'conflict'>, message?: string) {
    super(
      message ??
        (payload.kind === 'tombstone' ? '记录已删除（tombstone）' : '版本冲突（expected_rev 不匹配）'),
    );
    this.name = 'SyncOccConflictError';
    this.payload = { conflict: true, ...payload };
  }
}

export function isSyncOccConflictError(err: unknown): err is SyncOccConflictError {
  return err instanceof SyncOccConflictError;
}

export function parseMutationId(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.slice(0, 36);
}

export function parseExpectedRev(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < 0) return null;
  return i;
}

/** 从请求体抽出协议字段；不把 expected_rev 当业务列 */
export function extractSyncWriteMeta(data: Record<string, unknown> | null | undefined): {
  meta: SyncWriteMeta;
  rest: Record<string, unknown>;
} {
  const src = data && typeof data === 'object' ? { ...data } : {};
  const mutationId = parseMutationId(src.mutation_id ?? src.mutationId);
  const expectedRev = parseExpectedRev(src.expected_rev ?? src.expectedRev);
  delete src.expected_rev;
  delete src.expectedRev;
  delete src.last_pushed_mutation_id;
  // server_rev 由服务端分配，忽略客户端写入
  delete src.server_rev;
  delete src.serverRev;
  return { meta: { mutationId, expectedRev }, rest: src };
}

function quoteIdent(name: string): string {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

function pkColumn(table: string): string {
  if (isAllowedTable(table)) return getPrimaryKey(table);
  return 'id';
}

function userIdOf(raw?: string | null): string {
  return (raw && String(raw).trim()) || DEFAULT_SYNC_USER_ID;
}

export async function readLiveServerRev(
  conn: Queryable,
  table: string,
  recordPk: string,
): Promise<number | null> {
  const pk = pkColumn(table);
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT server_rev AS serverRev FROM ${quoteIdent(table)}
     WHERE ${quoteIdent(pk)} = ? LIMIT 1`,
    [recordPk],
  );
  if (!rows[0]) return null;
  const n = Number(rows[0].serverRev);
  return Number.isFinite(n) ? n : 0;
}

export async function readTombstone(
  conn: Queryable,
  table: string,
  recordPk: string,
  userId?: string | null,
): Promise<{ serverRev: number; mutationId: string | null } | null> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT server_rev AS serverRev, mutation_id AS mutationId
     FROM sync_tombstones
     WHERE user_id = ? AND table_name = ? AND record_pk = ?
     LIMIT 1`,
    [userIdOf(userId), table, recordPk],
  );
  if (!rows[0]) return null;
  const n = Number(rows[0].serverRev);
  return {
    serverRev: Number.isFinite(n) ? n : 0,
    mutationId: rows[0].mutationId == null ? null : String(rows[0].mutationId),
  };
}

/** 不变量 R1：next = max(活行, tombstone, 0)+1 */
export function nextServerRev(liveRev: number | null | undefined, tombRev: number | null | undefined): number {
  return Math.max(liveRev ?? 0, tombRev ?? 0) + 1;
}

/**
 * 同一 PK 跨删除/重建严格单调：max(活行, tombstone, 0)+1
 */
export async function allocateRev(
  conn: Queryable,
  table: string,
  recordPk: string,
  userId?: string | null,
): Promise<number> {
  const live = await readLiveServerRev(conn, table, recordPk);
  const tomb = await readTombstone(conn, table, recordPk, userId);
  return nextServerRev(live, tomb?.serverRev);
}

async function loadLiveRow(
  conn: Queryable,
  table: string,
  recordPk: string,
): Promise<Record<string, unknown> | null> {
  const pk = pkColumn(table);
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent(pk)} = ? LIMIT 1`,
    [recordPk],
  );
  const row = rows[0];
  if (!row) return null;
  return { ...(row as Record<string, unknown>) };
}

async function throwRowConflict(
  conn: Queryable,
  table: string,
  recordPk: string,
  liveRev: number,
): Promise<never> {
  const row = await loadLiveRow(conn, table, recordPk);
  const mutationId =
    row && row.mutation_id != null && String(row.mutation_id).trim()
      ? String(row.mutation_id).slice(0, 36)
      : null;
  throw new SyncOccConflictError({
    kind: 'row',
    table,
    pk: recordPk,
    serverRev: liveRev,
    mutationId,
    row,
  });
}

export async function throwTombstoneConflict(
  conn: Queryable,
  table: string,
  recordPk: string,
  userId?: string | null,
): Promise<never> {
  const tomb = await readTombstone(conn, table, recordPk, userId);
  throw new SyncOccConflictError({
    kind: 'tombstone',
    table,
    pk: recordPk,
    serverRev: tomb?.serverRev ?? null,
    mutationId: tomb?.mutationId ?? null,
    row: null,
  });
}

async function writeTombstone(
  conn: Queryable,
  table: string,
  recordPk: string,
  serverRev: number,
  mutationId: string | null,
  userId?: string | null,
): Promise<void> {
  const uid = userIdOf(userId);
  await conn.query(
    `INSERT INTO sync_tombstones (user_id, table_name, record_pk, server_rev, mutation_id, created_at)
     VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE
       server_rev = VALUES(server_rev),
       mutation_id = VALUES(mutation_id),
       created_at = VALUES(created_at)`,
    [uid, table.slice(0, 64), recordPk.slice(0, 255), serverRev, mutationId],
  );
}

async function deleteTombstone(
  conn: Queryable,
  table: string,
  recordPk: string,
  userId?: string | null,
): Promise<void> {
  await conn.query(
    `DELETE FROM sync_tombstones
     WHERE user_id = ? AND table_name = ? AND record_pk = ?`,
    [userIdOf(userId), table, recordPk],
  );
}

export type StampLiveOpts = {
  mutationId?: string | null;
  expectedRev?: number | null;
  /** 级联 / 服务端副作用：不校验 expected_rev */
  skipOcc?: boolean;
  userId?: string | null;
  /**
   * insert：next = (tombstone ?? 0)+1（忽略刚插入的 DEFAULT 1）
   * update：活行 +1，缺行则 409 tombstone
   * upsert：allocateRev（活行已存在）
   */
  mode: 'insert' | 'update' | 'upsert';
};

export type StampResult = {
  serverRev: number;
  mutationId: string | null;
};

export async function stampLiveUpsert(
  conn: Queryable,
  table: string,
  recordPk: string,
  opts: StampLiveOpts,
): Promise<StampResult> {
  const mutationId = parseMutationId(opts.mutationId);
  const pk = pkColumn(table);
  let serverRev: number;

  if (opts.mode === 'insert') {
    const tomb = await readTombstone(conn, table, recordPk, opts.userId);
    serverRev = (tomb?.serverRev ?? 0) + 1;
  } else if (opts.mode === 'update') {
    const live = await readLiveServerRev(conn, table, recordPk);
    if (live == null) {
      throw await throwTombstoneConflict(conn, table, recordPk, opts.userId);
    }
    if (!opts.skipOcc && opts.expectedRev != null && opts.expectedRev !== live) {
      throw await throwRowConflict(conn, table, recordPk, live);
    }
    serverRev = live + 1;
  } else {
    const live = await readLiveServerRev(conn, table, recordPk);
    if (live == null) {
      throw await throwTombstoneConflict(conn, table, recordPk, opts.userId);
    }
    if (!opts.skipOcc && opts.expectedRev != null && opts.expectedRev !== live) {
      throw await throwRowConflict(conn, table, recordPk, live);
    }
    serverRev = await allocateRev(conn, table, recordPk, opts.userId);
  }

  const [result] = await conn.query<ResultSetHeader>(
    `UPDATE ${quoteIdent(table)}
     SET server_rev = ?, mutation_id = ?
     WHERE ${quoteIdent(pk)} = ?`,
    [serverRev, mutationId, recordPk],
  );
  if (result.affectedRows <= 0) {
    throw await throwTombstoneConflict(conn, table, recordPk, opts.userId);
  }
  await deleteTombstone(conn, table, recordPk, opts.userId);
  return { serverRev, mutationId };
}

export type DeleteRevResult =
  | { kind: 'deleted'; serverRev: number; mutationId: string | null }
  | {
      kind: 'already_gone';
      tombstone: { serverRev: number; mutationId: string | null } | null;
    };

/**
 * 删除活行并写 tombstone。已无活行则幂等 already_gone（不新分配 rev）。
 * expected_rev 不匹配且行仍在 → 409 当前行。
 */
export async function deleteLiveWithRevision(
  conn: Queryable,
  table: string,
  recordPk: string,
  opts: {
    mutationId?: string | null;
    expectedRev?: number | null;
    skipOcc?: boolean;
    userId?: string | null;
  } = {},
): Promise<DeleteRevResult> {
  const live = await readLiveServerRev(conn, table, recordPk);
  if (live == null) {
    const tomb = await readTombstone(conn, table, recordPk, opts.userId);
    return { kind: 'already_gone', tombstone: tomb };
  }
  if (!opts.skipOcc && opts.expectedRev != null && opts.expectedRev !== live) {
    throw await throwRowConflict(conn, table, recordPk, live);
  }

  const mutationId = parseMutationId(opts.mutationId);
  const serverRev = live + 1;
  await writeTombstone(conn, table, recordPk, serverRev, mutationId, opts.userId);

  const pk = pkColumn(table);
  await conn.query<ResultSetHeader>(
    `DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent(pk)} = ?`,
    [recordPk],
  );
  return { kind: 'deleted', serverRev, mutationId };
}

/** 批量：先 tombstone 再删（级联，跳过 OCC） */
export async function deleteManyWithRevision(
  conn: Queryable,
  table: string,
  recordPks: string[],
  opts: { mutationId?: string | null; userId?: string | null } = {},
): Promise<Array<{ recordPk: string; serverRev: number; mutationId: string | null }>> {
  const out: Array<{ recordPk: string; serverRev: number; mutationId: string | null }> = [];
  for (const pk of recordPks) {
    const result = await deleteLiveWithRevision(conn, table, pk, {
      mutationId: opts.mutationId ?? null,
      skipOcc: true,
      userId: opts.userId,
    });
    if (result.kind === 'deleted') {
      out.push({ recordPk: pk, serverRev: result.serverRev, mutationId: result.mutationId });
    }
  }
  return out;
}
