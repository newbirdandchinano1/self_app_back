/**
 * 体重日志：同日覆盖；写入时同步更新 users.weight（最新日）。
 * 挂载：/api/app/health/weight-logs
 */
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import { isValidYmd } from '../utils/ymd.js';
import {
  addDaysToYmd,
  formatLocalYmdFromDate,
  formatMySQLWallClockDateTime,
} from './calendar/logical-day.js';
import {
  appendChangeLog,
  withSyncTransaction,
  type SyncWriteOptions,
} from './sync-change-log.js';
import { stampLiveUpsert } from './sync-revision.js';

export class WeightLogError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'WeightLogError';
  }
}

export type WeightLogRow = {
  id: string;
  recorded_ymd: string;
  weight_kg: number;
  created_at: string;
  updated_at: string;
  sync_status: string;
};

function asTrimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clampWeightKg(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 500) {
    throw new WeightLogError('weight_kg 须为 0～500 之间的正数');
  }
  return Math.round(n * 10) / 10;
}

function requireYmd(raw: unknown, field = 'ymd'): string {
  const text = asTrimmed(raw);
  if (!text || !isValidYmd(text)) {
    throw new WeightLogError(`请传有效 ${field}（YYYY-MM-DD）`);
  }
  return text;
}

function weightLogId(ymd: string): string {
  return `wl_${ymd.replace(/-/g, '')}`;
}

function formatRow(row: RowDataPacket): WeightLogRow {
  return {
    id: String(row.id),
    recorded_ymd: String(row.recorded_ymd),
    weight_kg: Number(row.weight_kg) || 0,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
    sync_status: String(row.sync_status ?? 'synced'),
  };
}

const SELECT_COLS = `id, recorded_ymd, weight_kg, created_at, updated_at, sync_status`;

/** 近 N 天体重点（含 endYmd；默认今天） */
export async function listWeightLogs(params: {
  days?: unknown;
  start_ymd?: unknown;
  end_ymd?: unknown;
}) {
  const endRaw = asTrimmed(params.end_ymd);
  const endYmd =
    endRaw && isValidYmd(endRaw) ? endRaw : formatLocalYmdFromDate(new Date());

  let startYmd: string;
  const startRaw = asTrimmed(params.start_ymd);
  if (startRaw && isValidYmd(startRaw)) {
    startYmd = startRaw;
  } else {
    const daysRaw = params.days == null || params.days === '' ? 30 : Number(params.days);
    const days = Number.isFinite(daysRaw) ? Math.trunc(daysRaw) : 30;
    if (days < 1 || days > 366) {
      throw new WeightLogError('days 须在 1～366');
    }
    startYmd = addDaysToYmd(endYmd, -(days - 1));
  }

  if (startYmd > endYmd) {
    throw new WeightLogError('start_ymd 不能晚于 end_ymd');
  }

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${SELECT_COLS}
     FROM weight_logs
     WHERE recorded_ymd >= ? AND recorded_ymd <= ?
       AND (sync_status IS NULL OR sync_status != 'pending_delete')
     ORDER BY recorded_ymd ASC`,
    [startYmd, endYmd],
  );

  const items = rows.map(formatRow);
  const latest = items.length ? items[items.length - 1]! : null;
  const deltaKg =
    items.length >= 2
      ? Math.round((items[items.length - 1]!.weight_kg - items[0]!.weight_kg) * 10) / 10
      : null;

  return {
    start_ymd: startYmd,
    end_ymd: endYmd,
    items,
    total: items.length,
    latest_kg: latest?.weight_kg ?? null,
    last_record_ymd: latest?.recorded_ymd ?? null,
    delta_kg: deltaKg,
    points: items.map((r) => ({ ymd: r.recorded_ymd, weight_kg: r.weight_kg })),
  };
}

/**
 * 同日 upsert；若该日是最新记录日则回写 users.weight。
 */
export async function upsertWeightLog(
  input: {
    id?: unknown;
    recorded_ymd?: unknown;
    ymd?: unknown;
    weight_kg?: unknown;
    weight?: unknown;
  },
  syncOpts: SyncWriteOptions = {},
) {
  const ymd = requireYmd(input.recorded_ymd ?? input.ymd, 'recorded_ymd');
  const kg = clampWeightKg(input.weight_kg ?? input.weight);
  const idRaw = asTrimmed(input.id);
  const id = idRaw || weightLogId(ymd);
  const now = formatMySQLWallClockDateTime(new Date());

  return withSyncTransaction(async (conn) => {
    const [existing] = await conn.query<RowDataPacket[]>(
      `SELECT id, recorded_ymd FROM weight_logs WHERE recorded_ymd = ? LIMIT 1`,
      [ymd],
    );
    const prev = existing[0];
    const rowId = prev ? String(prev.id) : id;

    if (prev) {
      await conn.query<ResultSetHeader>(
        `UPDATE weight_logs
         SET weight_kg = ?, updated_at = ?, sync_status = 'synced'
         WHERE recorded_ymd = ?`,
        [kg, now, ymd],
      );
      const stamp = await stampLiveUpsert(conn, 'weight_logs', rowId, {
        mode: 'update',
        mutationId: syncOpts.mutationId,
        skipOcc: true,
      });
      await appendChangeLog(conn, [
        {
          tableName: 'weight_logs',
          recordPk: rowId,
          op: 'upsert',
          updatedAt: now,
          deviceId: syncOpts.deviceId,
          serverRev: stamp.serverRev,
          mutationId: stamp.mutationId,
        },
      ]);
    } else {
      await conn.query<ResultSetHeader>(
        `INSERT INTO weight_logs
           (id, recorded_ymd, weight_kg, created_at, updated_at, sync_status, server_rev, mutation_id)
         VALUES (?, ?, ?, ?, ?, 'synced', 1, NULL)`,
        [rowId, ymd, kg, now, now],
      );
      const stamp = await stampLiveUpsert(conn, 'weight_logs', rowId, {
        mode: 'insert',
        mutationId: syncOpts.mutationId,
      });
      await appendChangeLog(conn, [
        {
          tableName: 'weight_logs',
          recordPk: rowId,
          op: 'upsert',
          updatedAt: now,
          deviceId: syncOpts.deviceId,
          serverRev: stamp.serverRev,
          mutationId: stamp.mutationId,
        },
      ]);
    }

    // 仅当该日 ≥ 当前最新日志日时回写 users.weight
    const [latestRows] = await conn.query<RowDataPacket[]>(
      `SELECT recorded_ymd FROM weight_logs
       WHERE sync_status IS NULL OR sync_status != 'pending_delete'
       ORDER BY recorded_ymd DESC LIMIT 1`,
    );
    const latestYmd = latestRows[0] ? String(latestRows[0].recorded_ymd) : ymd;
    if (ymd >= latestYmd) {
      const [userRows] = await conn.query<RowDataPacket[]>(
        `SELECT id FROM users
         WHERE (deleted_at IS NULL OR deleted_at = '')
           AND (sync_status IS NULL OR sync_status != 'pending_delete')
         ORDER BY updated_at DESC
         LIMIT 1`,
      );
      const userId = userRows[0] ? String(userRows[0].id) : null;
      if (userId) {
        await conn.query<ResultSetHeader>(
          `UPDATE users SET weight = ?, updated_at = ? WHERE id = ?`,
          [kg, now, userId],
        );
      }
    }

    const [out] = await conn.query<RowDataPacket[]>(
      `SELECT ${SELECT_COLS} FROM weight_logs WHERE id = ? LIMIT 1`,
      [rowId],
    );
    if (!out[0]) throw new WeightLogError('写入后读取失败', 500);
    return formatRow(out[0]);
  });
}
