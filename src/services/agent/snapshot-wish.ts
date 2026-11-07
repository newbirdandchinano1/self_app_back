/**
 * Agent 只读心愿板快照：余额、可兑/缺口、近期已兑（不含兑奖写）。
 * 挂载：GET /api/app/agent/snapshot/wish
 */
import type { RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import { getPointsBalance } from '../points.js';
import {
  WishBoardError,
  listActiveWishBoardItems,
  listRedeemedWishBoardItems,
} from '../wish-board.js';
import { formatLocalYmdFromDate } from '../calendar/logical-day.js';

const ACTIVE_LIMIT = 40;
const REDEEMED_LIMIT = 12;

export type AgentWishSnapshotParams = {
  limit?: number;
};

export { WishBoardError as WishSnapshotError };

function asPoints(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

async function monthEarnedPoints(monthKey: string): Promise<number> {
  // 本月正向 delta 之和（与 App 本地口径一致）
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COALESCE(SUM(delta), 0) AS earned
     FROM points_ledger
     WHERE delta > 0
       AND (sync_status IS NULL OR sync_status != 'pending_delete')
       AND DATE_FORMAT(created_at, '%Y-%m') = ?`,
    [monthKey],
  );
  return asPoints(rows[0]?.earned);
}

function trimActive(
  row: {
    id: string;
    title: string;
    cost_points: number;
    wish_type: string;
    icon_key: string | null;
    description: string | null;
  },
  balance: number,
) {
  const cost = asPoints(row.cost_points);
  const gap = Math.max(0, cost - balance);
  return {
    id: row.id,
    title: String(row.title || '').trim() || '未命名心愿',
    cost_points: cost,
    wish_type: row.wish_type === 'repeat' ? 'repeat' : 'once',
    icon_key: row.icon_key,
    points_gap: gap,
    redeemable_by_points: gap <= 0,
    has_description: Boolean(row.description && String(row.description).trim()),
  };
}

export async function getAgentWishSnapshot(params: AgentWishSnapshotParams = {}) {
  const lim = Math.max(1, Math.min(Number(params.limit) || ACTIVE_LIMIT, 60));
  const today = formatLocalYmdFromDate(new Date());
  const monthKey = today.slice(0, 7);

  const [balanceRes, active, redeemed, monthEarned] = await Promise.all([
    getPointsBalance(),
    listActiveWishBoardItems(),
    listRedeemedWishBoardItems(),
    monthEarnedPoints(monthKey),
  ]);

  const balance = asPoints(balanceRes.balance);
  const activeTrimmed = active.slice(0, lim).map((row) => trimActive(row, balance));
  const redeemable = activeTrimmed.filter((r) => r.redeemable_by_points);
  const waiting = activeTrimmed.filter((r) => !r.redeemable_by_points);

  const recentRedeemed = redeemed.slice(0, REDEEMED_LIMIT).map((row) => ({
    ledger_id: row.ledger_id,
    wish_id: row.wish_id,
    title: (row.title || '').trim() || '已删除的心愿',
    cost_points:
      row.cost_points != null ? asPoints(row.cost_points) : Math.abs(asPoints(row.delta)),
    wish_type: row.wish_type === 'repeat' ? 'repeat' : row.wish_type === 'once' ? 'once' : null,
    redeemed_at: row.redeemed_at,
  }));

  return {
    domain: 'wish',
    today_ymd: today,
    month_key: monthKey,
    balance,
    month_earned: monthEarned,
    active_count: active.length,
    redeemable_count: redeemable.length,
    waiting_count: waiting.length,
    redeemable,
    waiting,
    active_wishes: activeTrimmed,
    recent_redeemed: recentRedeemed,
    note:
      '心愿板只读摘要（余额/可兑/缺口）。兑换与扣分只能在心愿页由用户确认；助手禁止声称已兑换。',
  };
}
