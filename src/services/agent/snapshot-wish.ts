/**
 * Agent 只读心愿板快照：余额、可兑/缺口（含绑定条件）、近期已兑（不含兑奖写）。
 * 挂载：GET /api/app/agent/snapshot/wish
 */
import type { RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import { getPointsBalance } from '../points.js';
import { getFinanceNetWorth } from '../pages/finance.js';
import {
  WishBoardError,
  evaluateWishBoardEligibility,
  listActiveWishBoardItems,
  listRedeemedWishBoardItems,
  parseWishBoardRedeemConditions,
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

export async function getAgentWishSnapshot(params: AgentWishSnapshotParams = {}) {
  const lim = Math.max(1, Math.min(Number(params.limit) || ACTIVE_LIMIT, 60));
  const today = formatLocalYmdFromDate(new Date());
  const monthKey = today.slice(0, 7);

  const [balanceRes, active, redeemed, monthEarned, currentNetWorth] = await Promise.all([
    getPointsBalance(),
    listActiveWishBoardItems(),
    listRedeemedWishBoardItems(),
    monthEarnedPoints(monthKey),
    getFinanceNetWorth(),
  ]);

  const balance = asPoints(balanceRes.balance);
  const sliced = active.slice(0, lim);

  // 完整资格（含条件缺口）；失败时降级为仅积分缺口
  const eligibilityRows = await Promise.all(
    sliced.map(async (row) => {
      const conditions = parseWishBoardRedeemConditions(row.extra_data);
      const hasRedeemConditions =
        conditions.project_ids.length > 0 ||
        conditions.task_ids.length > 0 ||
        conditions.todo_ids.length > 0 ||
        conditions.habit_ids.length > 0 ||
        conditions.min_net_worth != null ||
        conditions.available_from != null;
      try {
        const elig = await evaluateWishBoardEligibility(row.id, {
          item: row,
          balance,
          currentNetWorth,
        });
        return {
          id: row.id,
          title: String(row.title || '').trim() || '未命名心愿',
          cost_points: asPoints(row.cost_points),
          wish_type: row.wish_type === 'repeat' ? 'repeat' : 'once',
          icon_key: row.icon_key,
          points_gap: elig.points_gap,
          redeemable_by_points: elig.points_ok,
          redeemable: elig.ok,
          conditions_ok: elig.conditions_ok,
          pending_count: elig.pending.length,
          pending_kinds: [...new Set(elig.pending.map((p) => p.kind))],
          has_description: Boolean(row.description && String(row.description).trim()),
          has_redeem_conditions: hasRedeemConditions,
        };
      } catch {
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
          redeemable: gap <= 0,
          conditions_ok: true,
          pending_count: 0,
          pending_kinds: [] as string[],
          has_description: Boolean(row.description && String(row.description).trim()),
          has_redeem_conditions: hasRedeemConditions,
        };
      }
    }),
  );

  const redeemable = eligibilityRows.filter((r) => r.redeemable);
  const waiting = eligibilityRows.filter((r) => !r.redeemable);

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
    current_net_worth: currentNetWorth,
    active_count: active.length,
    redeemable_count: redeemable.length,
    waiting_count: waiting.length,
    redeemable,
    waiting,
    active_wishes: eligibilityRows,
    recent_redeemed: recentRedeemed,
    note:
      '心愿板只读摘要（余额/可兑/完整条件缺口）。兑换与扣分只能在心愿页由用户确认；助手禁止声称已兑换。详情缺口见 GET /wish-board/items/:id/gap。',
  };
}
