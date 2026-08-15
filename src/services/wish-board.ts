import { randomUUID } from 'crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { db } from '../db/index.js';
import { formatDbDateTimeForApi, formatUtcMySQLDateTime } from './calendar/logical-day.js';

const WALLET_ID = 'default';

export class WishBoardError extends Error {
  constructor(
    message: string,
    public status = 400,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'WishBoardError';
  }
}

function newLedgerId(): string {
  return `plg_${randomUUID().replace(/-/g, '')}`;
}

function nowUtcMysql(): string {
  return formatUtcMySQLDateTime(new Date());
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
  return Number(rows[0]?.balance ?? 0);
}

export interface RedeemResult {
  ok: true;
  wish_board_item_id: string;
  wish_type: 'once' | 'repeat';
  cost_points: number;
  balance: number;
  status: 'active' | 'redeemed';
  ledger_id: string;
  redeemed_at: string;
}

/** 原子兑换：锁心愿 + 锁钱包 → 扣积分 → once 标兑换 / repeat 保持 active → 写流水 */
export async function redeemWishBoardItem(wishBoardItemId: string): Promise<RedeemResult> {
  const id = wishBoardItemId.trim();
  if (!id) {
    throw new WishBoardError('参数缺失', 400, { ok: false, error: '参数缺失' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [wishRows] = await conn.query<RowDataPacket[]>(
      `SELECT id, cost_points, status, wish_type FROM wish_board_items WHERE id = ? FOR UPDATE`,
      [id],
    );
    const wish = wishRows[0];
    if (!wish) {
      throw new WishBoardError('心愿不存在', 404, { ok: false, error: '心愿不存在' });
    }

    const wishType: 'once' | 'repeat' =
      wish.wish_type === 'repeat' ? 'repeat' : 'once';

    if (wishType === 'once' && wish.status === 'redeemed') {
      throw new WishBoardError('该心愿已兑换', 409, { ok: false, error: '该心愿已兑换' });
    }

    const costPoints = Number(wish.cost_points ?? 0);
    const balance = await lockOrCreateWallet(conn);
    if (balance < costPoints) {
      throw new WishBoardError(
        `积分不足（需要 ${costPoints}，当前 ${balance}）`,
        400,
        {
          ok: false,
          error: '积分不足',
          balance,
          cost_points: costPoints,
        },
      );
    }

    const newBalance = balance - costPoints;
    const now = nowUtcMysql();
    const ledgerId = newLedgerId();
    const nextStatus: 'active' | 'redeemed' = wishType === 'repeat' ? 'active' : 'redeemed';

    await conn.query<ResultSetHeader>(
      `UPDATE points_wallet
       SET balance = ?, updated_at = ?, sync_status = 'synced'
       WHERE id = ?`,
      [newBalance, now, WALLET_ID],
    );

    await conn.query<ResultSetHeader>(
      `UPDATE wish_board_items
       SET status = ?, redeemed_at = ?, updated_at = ?, sync_status = 'synced'
       WHERE id = ?`,
      [nextStatus, now, now, id],
    );

    await conn.query(
      `INSERT INTO points_ledger
        (id, delta, balance_after, reason, ref_type, ref_id, created_at, updated_at, sync_status)
       VALUES (?, ?, ?, 'wish_redeem', 'wish_board_item', ?, ?, ?, 'synced')`,
      [ledgerId, -costPoints, newBalance, id, now, now],
    );

    await conn.commit();

    return {
      ok: true,
      wish_board_item_id: id,
      wish_type: wishType,
      cost_points: costPoints,
      balance: newBalance,
      status: nextStatus,
      ledger_id: ledgerId,
      redeemed_at: formatDbDateTimeForApi(now, 'utc') ?? now,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * 积分流水常见 reason（adjust 不强制白名单，长度 ≤64 即可）。
 * habit_* / task_* / project_* / wish_redeem 与 APP 约定一致。
 */
export const POINTS_LEDGER_REASONS = [
  'habit_check_in',
  'habit_check_in_undo',
  'task_complete',
  'task_complete_undo',
  'project_complete',
  'project_complete_undo',
  'wish_redeem',
  'manual_adjust',
] as const;

export type PointsLedgerReason = (typeof POINTS_LEDGER_REASONS)[number];

export interface AdjustPointsInput {
  delta: number;
  /** 如 task_complete / project_complete / habit_check_in / wish_redeem */
  reason: string;
  /** 如 task / project / habit / wish_board_item */
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
  let delta = input.delta;
  if (!Number.isFinite(delta) || !Number.isInteger(delta)) {
    throw new WishBoardError('delta 必须为整数', 400, {
      ok: false,
      error: 'delta 必须为整数',
    });
  }

  // delta=0：不写流水，直接返回当前余额
  if (delta === 0) {
    const { balance } = await getPointsBalance();
    return { ok: true, balance, ledger_id: '', delta: 0 };
  }

  const reason = String(input.reason ?? '').trim() || 'manual_adjust';
  if (reason.length > 64) {
    throw new WishBoardError('reason 最多 64 字', 400, { ok: false, error: 'reason 最多 64 字' });
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
      const netEarned = Math.max(0, Math.trunc(Number(netRows[0]?.net ?? 0)));
      const maxUndo = Math.min(netEarned, balance);
      if (maxUndo <= 0) {
        await conn.commit();
        return { ok: true, balance, ledger_id: '', delta: 0 };
      }
      if (Math.abs(delta) > maxUndo) {
        delta = -maxUndo;
      }
    }

    const newBalance = balance + delta;
    if (newBalance < 0) {
      throw new WishBoardError(`积分不足（需要 ${Math.abs(delta)}，当前 ${balance}）`, 400, {
        ok: false,
        error: '积分不足',
        balance,
        delta,
        needed: Math.abs(delta),
      });
    }

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
      balance: Number(row.balance ?? 0),
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
    const total = Math.max(0, Math.trunc(Number(sumRows[0]?.total ?? 0)));

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
