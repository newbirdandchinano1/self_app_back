import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import { DEFAULT_SYNC_USER_ID } from './sync-change-log.js';

export type PurgeSyncChangeLogOptions = {
  /** 按 created_at 保留最近 N 天；默认 14 */
  retainDays?: number;
  /** 每个 user 最多保留最近 M 条（按 id）；0/省略表示不按条数裁剪 */
  retainMaxRows?: number;
  userId?: string | null;
};

export type PurgeSyncChangeLogResult = {
  deletedByAge: number;
  deletedByCount: number;
  minIdAfter: number | null;
  maxIdAfter: number | null;
};

const DEFAULT_RETAIN_DAYS = 14;
const DEFAULT_RETAIN_MAX_ROWS = 100_000;

/**
 * 清理过期 Change Log。
 * 先按时间删，再按条数保留最新 M 条。
 * 客户端游标若落在已删窗口前，pull 会返回 needFullSync。
 */
export async function purgeSyncChangeLog(
  options: PurgeSyncChangeLogOptions = {},
): Promise<PurgeSyncChangeLogResult> {
  const userId = (options.userId && String(options.userId).trim()) || DEFAULT_SYNC_USER_ID;
  const retainDays =
    options.retainDays != null && Number.isFinite(options.retainDays)
      ? Math.max(1, Math.floor(options.retainDays))
      : DEFAULT_RETAIN_DAYS;
  const retainMaxRows =
    options.retainMaxRows != null && Number.isFinite(options.retainMaxRows)
      ? Math.max(0, Math.floor(options.retainMaxRows))
      : DEFAULT_RETAIN_MAX_ROWS;

  let deletedByAge = 0;
  let deletedByCount = 0;

  const [ageResult] = await db.query<ResultSetHeader>(
    `DELETE FROM sync_change_log
     WHERE user_id = ?
       AND created_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)`,
    [userId, retainDays],
  );
  deletedByAge = Number(ageResult.affectedRows) || 0;

  if (retainMaxRows > 0) {
    const [countRows] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM sync_change_log WHERE user_id = ?`,
      [userId],
    );
    const cnt = Number(countRows[0]?.cnt ?? 0);
    if (cnt > retainMaxRows) {
      // 保留最新 retainMaxRows 条：删 id < 第 retainMaxRows 新的那条 id
      const offset = retainMaxRows - 1;
      const [keepRows] = await db.query<RowDataPacket[]>(
        `SELECT id AS min_keep FROM sync_change_log
         WHERE user_id = ?
         ORDER BY id DESC
         LIMIT 1 OFFSET ?`,
        [userId, offset],
      );
      const minKeep = keepRows[0]?.min_keep == null ? null : Number(keepRows[0].min_keep);
      if (minKeep != null && Number.isFinite(minKeep)) {
        const [countResult] = await db.query<ResultSetHeader>(
          `DELETE FROM sync_change_log
           WHERE user_id = ? AND id < ?`,
          [userId, minKeep],
        );
        deletedByCount = Number(countResult.affectedRows) || 0;
      }
    }
  }

  const [bounds] = await db.query<RowDataPacket[]>(
    `SELECT MIN(id) AS min_id, MAX(id) AS max_id
     FROM sync_change_log WHERE user_id = ?`,
    [userId],
  );
  const minIdAfter = bounds[0]?.min_id == null ? null : Number(bounds[0].min_id);
  const maxIdAfter = bounds[0]?.max_id == null ? null : Number(bounds[0].max_id);

  if (deletedByAge > 0 || deletedByCount > 0) {
    const purged = deletedByAge + deletedByCount;
    try {
      const { syncMetricInc } = await import('./sync-metrics.js');
      syncMetricInc('changeLogPurgedRows', purged);
    } catch {
      /* ignore */
    }
    console.log(
      `[sync-cleanup] user=${userId} deletedByAge=${deletedByAge} deletedByCount=${deletedByCount} minId=${minIdAfter} maxId=${maxIdAfter}`,
    );
  }

  return { deletedByAge, deletedByCount, minIdAfter, maxIdAfter };
}

export const SYNC_CLEANUP_DEFAULTS = {
  retainDays: DEFAULT_RETAIN_DAYS,
  retainMaxRows: DEFAULT_RETAIN_MAX_ROWS,
  /** 启动后首次延迟，再按 interval 周期跑 */
  firstDelayMs: 60_000,
  intervalMs: 6 * 60 * 60 * 1000,
} as const;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let cleanupStarted = false;

/** 进程内定时清理；重复调用无副作用 */
export function startSyncChangeLogCleanupScheduler(
  options: PurgeSyncChangeLogOptions & { intervalMs?: number; firstDelayMs?: number } = {},
): void {
  if (cleanupStarted) return;
  cleanupStarted = true;

  const intervalMs = options.intervalMs ?? SYNC_CLEANUP_DEFAULTS.intervalMs;
  const firstDelayMs = options.firstDelayMs ?? SYNC_CLEANUP_DEFAULTS.firstDelayMs;
  const purgeOpts: PurgeSyncChangeLogOptions = {
    retainDays: options.retainDays,
    retainMaxRows: options.retainMaxRows,
    userId: options.userId,
  };

  const run = () => {
    void purgeSyncChangeLog(purgeOpts).catch((err) => {
      console.warn('[sync-cleanup] 清理失败', err);
    });
  };

  setTimeout(run, firstDelayMs);
  cleanupTimer = setInterval(run, intervalMs);
  // 不阻止进程退出
  if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    cleanupTimer.unref();
  }
  console.log(
    `[sync-cleanup] 已调度：首跑 ${firstDelayMs}ms 后，此后每 ${intervalMs}ms；retainDays=${purgeOpts.retainDays ?? DEFAULT_RETAIN_DAYS} retainMaxRows=${purgeOpts.retainMaxRows ?? DEFAULT_RETAIN_MAX_ROWS}`,
  );
}

/** 测试用 */
export function stopSyncChangeLogCleanupSchedulerForTests(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  cleanupStarted = false;
}
