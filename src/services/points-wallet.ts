/**
 * 积分钱包公共原语（P1-09 / P1-03）：
 * asPoints、钱包锁、流水 ID、连接内写余额。
 * points 调账与 wish-board 兑换共用，避免两套精度/锁策略。
 */
import { randomUUID } from 'crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { formatUtcMySQLDateTime } from './calendar/logical-day.js';

export const POINTS_WALLET_ID = 'default';

export function asPoints(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

export function newPointsLedgerId(): string {
  return `plg_${randomUUID().replace(/-/g, '')}`;
}

export function nowUtcMysql(): string {
  return formatUtcMySQLDateTime(new Date());
}

/** 确保 default 钱包存在并 FOR UPDATE 锁定，返回当前余额 */
export async function lockOrCreateWallet(conn: PoolConnection): Promise<number> {
  const now = nowUtcMysql();
  await conn.query(
    `INSERT INTO points_wallet (id, balance, created_at, updated_at, sync_status)
     VALUES (?, 0, ?, ?, 'synced')
     ON DUPLICATE KEY UPDATE id = id`,
    [POINTS_WALLET_ID, now, now],
  );

  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT balance FROM points_wallet WHERE id = ? FOR UPDATE`,
    [POINTS_WALLET_ID],
  );
  return asPoints(rows[0]?.balance ?? 0);
}

export type ApplyWalletDeltaInput = {
  /** 调用方须已持有钱包行锁；传入当前余额避免二次 SELECT */
  balance: number;
  delta: number;
  reason: string;
  ref_type?: string | null;
  ref_id?: string | null;
  note?: string | null;
};

export type ApplyWalletDeltaResult = {
  balance: number;
  ledger_id: string;
  delta: number;
};

/**
 * 在已开启的事务内改余额并写流水。
 * 调用方负责 begin/commit；须先 lockOrCreateWallet。
 */
export async function applyWalletDeltaOnConnection(
  conn: PoolConnection,
  input: ApplyWalletDeltaInput,
): Promise<ApplyWalletDeltaResult> {
  const delta = asPoints(input.delta);
  const balance = asPoints(input.balance);
  const newBalance = asPoints(balance + delta);
  const now = nowUtcMysql();
  const ledgerId = newPointsLedgerId();
  const reason = String(input.reason ?? '').trim() || 'manual_adjust';
  const refType =
    input.ref_type != null && String(input.ref_type).trim() !== ''
      ? String(input.ref_type).trim()
      : null;
  const refId =
    input.ref_id != null && String(input.ref_id).trim() !== ''
      ? String(input.ref_id).trim()
      : null;
  const extraData =
    input.note != null && String(input.note).trim() !== ''
      ? JSON.stringify({ note: String(input.note).trim() })
      : null;

  await conn.query<ResultSetHeader>(
    `UPDATE points_wallet
     SET balance = ?, updated_at = ?, sync_status = 'synced'
     WHERE id = ?`,
    [newBalance, now, POINTS_WALLET_ID],
  );

  await conn.query(
    `INSERT INTO points_ledger
      (id, delta, balance_after, reason, ref_type, ref_id, created_at, updated_at, sync_status, extra_data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?)`,
    [ledgerId, delta, newBalance, reason, refType, refId, now, now, extraData],
  );

  return { balance: newBalance, ledger_id: ledgerId, delta };
}
