import { randomUUID } from 'crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { db } from '../db/index.js';
import { formatDbDateTimeForApi, formatUtcMySQLDateTime } from './calendar/logical-day.js';

const WALLET_ID = 'default';

const POINTS_LEDGER_REASON_LABELS: Record<string, string> = {
  habit_check_in: '习惯打卡',
  habit_check_in_undo: '撤销习惯打卡',
  habit_goal_complete: '完成习惯目标',
  habit_goal_complete_undo: '撤销习惯目标',
  task_complete: '完成任务',
  task_complete_undo: '撤销任务完成',
  project_complete: '完成项目',
  project_complete_undo: '撤销项目完成',
  wish_redeem: '兑换心愿',
  points_reset: '重置积分',
  manual_adjust: '手动调整',
  break_habit_penalty: '破戒扣分',
  break_habit_penalty_undo: '撤销破戒扣分',
  break_habit_clean: '未破戒加分',
  break_habit_clean_undo: '撤销未破戒加分',
  break_habit_goal: '戒除目标达成',
  break_habit_goal_undo: '撤销戒除目标',
  health_metric_complete: '健康指标达标',
  health_metric_complete_undo: '撤销健康指标达标',
  health_metric_over_penalty: '热量超额扣分',
  health_metric_over_penalty_undo: '撤销热量超额扣分',
};

const HEALTH_METRIC_NAME_ZH: Record<string, string> = {
  hydration: '水分',
  protein: '蛋白质',
  carbohydrate: '碳水',
  calories: '热量',
};

export class PointsError extends Error {
  constructor(
    message: string,
    public status = 400,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'PointsError';
  }
}

function newLedgerId(): string {
  return `plg_${randomUUID().replace(/-/g, '')}`;
}

function nowUtcMysql(): string {
  return formatUtcMySQLDateTime(new Date());
}

function asPoints(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

async function lockOrCreateWallet(conn: PoolConnection): Promise<number> {
  const now = nowUtcMysql();
  await conn.query(
    `INSERT INTO points_wallet (id, balance, created_at, updated_at, sync_status)
     VALUES (?, 0, ?, ?, 'synced')
     ON DUPLICATE KEY UPDATE id = id`,
    [WALLET_ID, now, now],
  );

  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT balance FROM points_wallet WHERE id = ? FOR UPDATE`,
    [WALLET_ID],
  );
  return asPoints(rows[0]?.balance ?? 0);
}

export function pointsLedgerReasonLabel(reason: string): string {
  const key = String(reason ?? '').trim();
  if (!key) return '积分变动';
  if (POINTS_LEDGER_REASON_LABELS[key]) return POINTS_LEDGER_REASON_LABELS[key];
  if (key.endsWith('_undo')) {
    const base = key.slice(0, -'_undo'.length);
    const baseLabel = POINTS_LEDGER_REASON_LABELS[base];
    if (baseLabel) return `撤销${baseLabel}`;
  }
  return key;
}

/** 健康指标流水 ref_id：`YYYY-MM-DD:metric` → 可读标题 */
function healthMetricRefTitle(refType: unknown, refId: unknown): string | null {
  if (String(refType ?? '').trim() !== 'health_metric') return null;
  const raw = String(refId ?? '').trim();
  if (!raw) return null;
  const colon = raw.lastIndexOf(':');
  if (colon <= 0 || colon >= raw.length - 1) return raw;
  const ymd = raw.slice(0, colon).trim();
  const metric = raw.slice(colon + 1).trim();
  const metricZh = HEALTH_METRIC_NAME_ZH[metric] ?? metric;
  if (!ymd) return metricZh;
  return `${ymd} · ${metricZh}`;
}

export type PointsLedgerHistoryItem = {
  id: string;
  delta: number;
  balance_after: number;
  reason: string;
  reason_label: string;
  ref_type: string | null;
  ref_id: string | null;
  ref_title: string | null;
  note: string | null;
  created_at: string;
};

export type PointsLedgerHistoryResult = {
  items: PointsLedgerHistoryItem[];
  balance: number;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

function clampLedgerPage(page?: number, limit?: number): { page: number; limit: number; offset: number } {
  const p = Number.isFinite(page) && (page as number) > 0 ? Math.floor(page as number) : 1;
  const rawLimit = Number.isFinite(limit) && (limit as number) > 0 ? Math.floor(limit as number) : 50;
  const l = Math.min(200, Math.max(1, rawLimit));
  return { page: p, limit: l, offset: (p - 1) * l };
}

/**
 * 积分流水（全部来源）：分页按时间倒序。
 * 左连习惯/任务/项目带回关联标题；reason_label 供前端直接展示。
 */
export async function listPointsLedgerHistory(params?: {
  page?: number;
  limit?: number;
}): Promise<PointsLedgerHistoryResult> {
  const { page, limit, offset } = clampLedgerPage(params?.page, params?.limit);

  const [[countRows], [rows], balanceResult] = await Promise.all([
    db.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM points_ledger`),
    db.query<RowDataPacket[]>(
      `SELECT
          l.id,
          l.delta,
          l.balance_after,
          l.reason,
          l.ref_type,
          l.ref_id,
          l.created_at,
          l.extra_data,
          COALESCE(t.title, p.name, h.name) AS ref_title
       FROM points_ledger l
       LEFT JOIN tasks t
         ON l.ref_type COLLATE utf8mb4_unicode_ci = 'task'
        AND t.id COLLATE utf8mb4_unicode_ci = l.ref_id COLLATE utf8mb4_unicode_ci
       LEFT JOIN projects p
         ON l.ref_type COLLATE utf8mb4_unicode_ci = 'project'
        AND p.id COLLATE utf8mb4_unicode_ci = l.ref_id COLLATE utf8mb4_unicode_ci
       LEFT JOIN habits h
         ON l.ref_type COLLATE utf8mb4_unicode_ci = 'habit'
        AND h.id COLLATE utf8mb4_unicode_ci = l.ref_id COLLATE utf8mb4_unicode_ci
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT ? OFFSET ?`,
      [limit, offset],
    ),
    getPointsBalance(),
  ]);

  const total = Math.max(0, Math.floor(Number(countRows[0]?.total) || 0));
  const items: PointsLedgerHistoryItem[] = rows.map((row) => {
    const reason = String(row.reason ?? '');
    let note: string | null = null;
    const extra = row.extra_data;
    if (extra != null) {
      try {
        const parsed =
          typeof extra === 'string'
            ? (JSON.parse(extra) as Record<string, unknown>)
            : (extra as Record<string, unknown>);
        if (parsed && typeof parsed.note === 'string' && parsed.note.trim()) {
          note = parsed.note.trim();
        }
      } catch {
        // ignore malformed extra_data
      }
    }
    return {
      id: String(row.id),
      delta: asPoints(row.delta),
      balance_after: asPoints(row.balance_after),
      reason,
      reason_label: pointsLedgerReasonLabel(reason),
      ref_type: row.ref_type == null ? null : String(row.ref_type),
      ref_id: row.ref_id == null ? null : String(row.ref_id),
      ref_title: (() => {
        const joined =
          row.ref_title == null || String(row.ref_title).trim() === ''
            ? null
            : String(row.ref_title).trim();
        if (joined) return joined;
        return healthMetricRefTitle(row.ref_type, row.ref_id);
      })(),
      note,
      created_at: formatDbDateTimeForApi(row.created_at, 'utc') ?? String(row.created_at),
    };
  });

  return {
    items,
    balance: balanceResult.balance,
    pagination: {
      page,
      limit,
      total,
      totalPages: total > 0 ? Math.ceil(total / limit) : 0,
    },
  };
}

export type DeletePointsLedgerResult = {
  deleted: true;
  id: string;
  delta: number;
  /** 回退到钱包的增量（= -原 delta，可能因余额封顶被截断） */
  rollback_delta: number;
  balance: number;
  reason: string;
  ref_type: string | null;
  ref_id: string | null;
};

/**
 * 删除一条积分流水并回退其对钱包的影响：
 * newBalance = max(0, balance - row.delta)
 *  */
export async function deletePointsLedgerEntry(ledgerId: string): Promise<DeletePointsLedgerResult> {
  const id = String(ledgerId ?? '').trim();
  if (!id) {
    throw new PointsError('参数缺失', 400, { ok: false, error: '参数缺失' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const balance = await lockOrCreateWallet(conn);

    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT id, delta, reason, ref_type, ref_id
       FROM points_ledger
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [id],
    );
    const row = rows[0];
    if (!row) {
      throw new PointsError('流水不存在', 404, { ok: false, error: '流水不存在' });
    }

    const delta = asPoints(row.delta);
    const reason = String(row.reason ?? '');
    const refType = row.ref_type == null ? null : String(row.ref_type);
    const refId = row.ref_id == null ? null : String(row.ref_id);

    await conn.query(`DELETE FROM points_ledger WHERE id = ?`, [id]);

    // 回退：去掉该笔 delta 的影响；余额允许为负（负奖励扣除场景）
    const newBalance = asPoints(balance - delta);
    const rollbackDelta = newBalance - balance;
    const now = nowUtcMysql();

    await conn.query<ResultSetHeader>(
      `UPDATE points_wallet
       SET balance = ?, updated_at = ?, sync_status = 'synced'
       WHERE id = ?`,
      [newBalance, now, WALLET_ID],
    );

    // 删除 wish_redeem 流水时：一次性心愿恢复为可兑换
    if (
      reason === 'wish_redeem' &&
      refType === 'wish_board_item' &&
      refId &&
      String(refId).trim()
    ) {
      await conn.query(
        `UPDATE wish_board_items
         SET status = 'active',
             redeemed_at = NULL,
             updated_at = ?,
             sync_status = 'synced'
         WHERE id = ?
           AND wish_type = 'once'
           AND status = 'redeemed'`,
        [now, String(refId).trim()],
      );
    }

    await conn.commit();

    return {
      deleted: true,
      id,
      delta,
      rollback_delta: rollbackDelta,
      balance: newBalance,
      reason,
      ref_type: refType,
      ref_id: refId,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export interface AdjustPointsInput {
  delta: number;
  /** 如 task_complete / project_complete / habit_check_in */
  reason: string;
  /** 如 task / project / habit / points_wallet */
  ref_type?: string | null;
  ref_id?: string | null;
  note?: string | null;
}

export interface AdjustPointsResult {
  ok: true;
  balance: number;
  ledger_id: string;
  delta: number;
}

/** 原子调账：锁钱包 → 改余额 → 写流水 */
export async function adjustPoints(input: AdjustPointsInput): Promise<AdjustPointsResult> {
  let delta = asPoints(input.delta);
  if (!Number.isFinite(delta)) {
    throw new PointsError('delta 必须为数字', 400, {
      ok: false,
      error: 'delta 必须为数字',
    });
  }

  // delta=0：不写流水，直接返回当前余额
  if (delta === 0) {
    const { balance } = await getPointsBalance();
    return { ok: true, balance, ledger_id: '', delta: 0 };
  }

  const reason = String(input.reason ?? '').trim() || 'manual_adjust';
  if (reason.length > 64) {
    throw new PointsError('reason 最多 64 字', 400, { ok: false, error: 'reason 最多 64 字' });
  }

  const refType =
    input.ref_type != null && String(input.ref_type).trim() !== ''
      ? String(input.ref_type).trim()
      : null;
  const refId =
    input.ref_id != null && String(input.ref_id).trim() !== ''
      ? String(input.ref_id).trim()
      : null;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const balance = await lockOrCreateWallet(conn);

    // *_undo：按同一 ref 流水净额钳制，避免超额扣回 / 支持幂等
    if (delta < 0 && reason.endsWith('_undo') && refType && refId) {
      const [netRows] = await conn.query<RowDataPacket[]>(
        `SELECT COALESCE(SUM(delta), 0) AS net
         FROM points_ledger
         WHERE ref_type = ? AND ref_id = ?`,
        [refType, refId],
      );
      const netEarned = Math.max(0, asPoints(netRows[0]?.net ?? 0));
      const maxUndo = netEarned;
      if (maxUndo <= 0) {
        await conn.commit();
        return { ok: true, balance, ledger_id: '', delta: 0 };
      }
      if (Math.abs(delta) > maxUndo) {
        delta = asPoints(-maxUndo);
      }
    }

    const newBalance = asPoints(balance + delta);

    const now = nowUtcMysql();
    const ledgerId = newLedgerId();
    const extraData =
      input.note != null && String(input.note).trim() !== ''
        ? JSON.stringify({ note: String(input.note).trim() })
        : null;

    await conn.query<ResultSetHeader>(
      `UPDATE points_wallet
       SET balance = ?, updated_at = ?, sync_status = 'synced'
       WHERE id = ?`,
      [newBalance, now, WALLET_ID],
    );

    await conn.query(
      `INSERT INTO points_ledger
        (id, delta, balance_after, reason, ref_type, ref_id, created_at, updated_at, sync_status, extra_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?)`,
      [
        ledgerId,
        delta,
        newBalance,
        reason,
        refType,
        refId,
        now,
        now,
        extraData,
      ],
    );

    await conn.commit();

    return {
      ok: true,
      balance: newBalance,
      ledger_id: ledgerId,
      delta,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export interface ResetPointsResult {
  balance: 0;
  delta: number;
  ledger_id: string | null;
}

/**
 * 重置积分：事务内清零钱包并追加 points_reset 负向流水。
 * 余额已为 0 时 no-op（不写流水），返回 delta=0、ledger_id=null。
 */
export async function resetPoints(): Promise<ResetPointsResult> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const balance = await lockOrCreateWallet(conn);
    if (balance === 0) {
      await conn.commit();
      return { balance: 0, delta: 0, ledger_id: null };
    }

    const delta = asPoints(-balance);
    const now = nowUtcMysql();
    const ledgerId = newLedgerId();

    await conn.query<ResultSetHeader>(
      `UPDATE points_wallet
       SET balance = 0, updated_at = ?, sync_status = 'synced'
       WHERE id = ?`,
      [now, WALLET_ID],
    );

    await conn.query(
      `INSERT INTO points_ledger
        (id, delta, balance_after, reason, ref_type, ref_id, created_at, updated_at, sync_status)
       VALUES (?, ?, 0, 'points_reset', 'points_wallet', ?, ?, ?, 'synced')`,
      [ledgerId, delta, WALLET_ID, now, now],
    );

    await conn.commit();

    return { balance: 0, delta, ledger_id: ledgerId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function getPointsBalance(): Promise<{ balance: number }> {
  const wallet = await getOrCreateDefaultWallet();
  return { balance: wallet.balance };
}

export interface PointsWalletRecord {
  id: string;
  balance: number;
  created_at: string;
  updated_at: string;
  sync_status?: string;
  extra_data: unknown;
}

/** 确保 default 钱包存在并返回完整行（供 GET / CRUD / bootstrap） */
export async function getOrCreateDefaultWallet(): Promise<PointsWalletRecord> {
  const [existing] = await db.query<RowDataPacket[]>(
    `SELECT id, balance, created_at, updated_at, sync_status, extra_data
     FROM points_wallet WHERE id = ? LIMIT 1`,
    [WALLET_ID],
  );
  if (existing[0]) {
    const row = existing[0];
    return {
      id: String(row.id),
      balance: asPoints(row.balance ?? 0),
      created_at: formatDbDateTimeForApi(row.created_at, 'utc') ?? String(row.created_at),
      updated_at: formatDbDateTimeForApi(row.updated_at, 'utc') ?? String(row.updated_at),
      sync_status: row.sync_status == null ? undefined : String(row.sync_status),
      extra_data: row.extra_data ?? null,
    };
  }

  const now = nowUtcMysql();
  await db.query(
    `INSERT INTO points_wallet (id, balance, created_at, updated_at, sync_status)
     VALUES (?, 0, ?, ?, 'synced')
     ON DUPLICATE KEY UPDATE id = id`,
    [WALLET_ID, now, now],
  );

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, balance, created_at, updated_at, sync_status, extra_data
     FROM points_wallet WHERE id = ? LIMIT 1`,
    [WALLET_ID],
  );
  const row = rows[0];
  return {
    id: WALLET_ID,
    balance: Number(row?.balance ?? 0),
    created_at: formatDbDateTimeForApi(row?.created_at ?? now, 'utc') ?? now,
    updated_at: formatDbDateTimeForApi(row?.updated_at ?? now, 'utc') ?? now,
    sync_status: row?.sync_status == null ? 'synced' : String(row.sync_status),
    extra_data: row?.extra_data ?? null,
  };
}

/**
 * 流水权威：用 SUM(points_ledger.delta) 校正 default 钱包余额。
 * 通用同步追加 task_complete_undo 等负流水后调用，避免旧钱包快照把余额写回去。
 */
export async function reconcilePointsWalletFromLedger(): Promise<{ balance: number }> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const balance = await lockOrCreateWallet(conn);
    const [sumRows] = await conn.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(delta), 0) AS total FROM points_ledger`,
    );
    const total = asPoints(sumRows[0]?.total ?? 0);

    if (total !== balance) {
      const now = nowUtcMysql();
      await conn.query<ResultSetHeader>(
        `UPDATE points_wallet
         SET balance = ?, updated_at = ?, sync_status = 'synced'
         WHERE id = ?`,
        [total, now, WALLET_ID],
      );
    }

    await conn.commit();
    return { balance: total };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

