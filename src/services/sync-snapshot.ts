import type { RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import { SYNC_CHANGE_LOG_TABLES, DEFAULT_SYNC_USER_ID } from './sync-change-log.js';
import { isAllowedTable, getPrimaryKey } from '../config/tables.js';

function escIdent(name: string): string {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

/** 会话开始时读一次 cursor0；后续分页原样回传，禁止每页重读 MAX(id) */
export async function getSnapshotCursor0(): Promise<number> {
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT MAX(id) AS max_id FROM sync_change_log WHERE user_id = ?',
      [DEFAULT_SYNC_USER_ID],
    );
    const v = rows[0]?.max_id;
    return v == null ? 0 : Number(v);
  } catch {
    return 0;
  }
}

export type SnapshotPage = {
  table: string;
  rows: Record<string, unknown>[];
  nextAfter: string | null;
  done: boolean;
  meta: { syncCursor: number; snapshotComplete: false };
};

const SNAPSHOT_LIMIT_MAX = 500;

/** 通用全量分页：ORDER BY pk ASC，无日期过滤，可分页；10万行截断改为显式分页 */
export async function pullSnapshotTable(
  table: string,
  after: string | null,
  limit: number,
  cursor0: number,
): Promise<SnapshotPage> {
  const t = String(table ?? '').trim();
  if (!SYNC_CHANGE_LOG_TABLES.has(t) || !isAllowedTable(t)) {
    throw new Error(`snapshot 不支持表 ${t}`);
  }
  const lim = Math.min(Math.max(1, Math.floor(limit || 200)), SNAPSHOT_LIMIT_MAX);
  const pkCol = getPrimaryKey(t as never);
  const params: unknown[] = [];
  let where = '';
  if (after) {
    where = `WHERE ${escIdent(pkCol)} > ?`;
    params.push(after);
  }
  params.push(lim + 1);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT * FROM ${escIdent(t)} ${where} ORDER BY ${escIdent(pkCol)} ASC LIMIT ?`,
    params,
  );
  const hasMore = rows.length > lim;
  const page = hasMore ? rows.slice(0, lim) : rows;
  const last = page[page.length - 1] as Record<string, unknown> | undefined;
  return {
    table: t,
    rows: page as Record<string, unknown>[],
    nextAfter: hasMore && last ? String((last as Record<string, unknown>)[pkCol] ?? '') : null,
    done: !hasMore,
    meta: { syncCursor: cursor0, snapshotComplete: false },
  };
}
