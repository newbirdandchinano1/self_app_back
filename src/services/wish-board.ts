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

function asPoints(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

const REDEEM_CONDITIONS_KEY = 'redeem_conditions';

type WishBoardRedeemConditions = {
  project_ids: string[];
  task_ids: string[];
  todo_ids: string[];
};

function parseExtraObject(raw: unknown): Record<string, unknown> {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* ignore */
    }
  }
  return {};
}

function normalizeIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function parseWishBoardRedeemConditions(extraData: unknown): WishBoardRedeemConditions {
  const base = parseExtraObject(extraData);
  const raw = base[REDEEM_CONDITIONS_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { project_ids: [], task_ids: [], todo_ids: [] };
  }
  const obj = raw as Record<string, unknown>;
  return {
    project_ids: normalizeIdList(obj.project_ids),
    task_ids: normalizeIdList(obj.task_ids),
    todo_ids: normalizeIdList(obj.todo_ids),
  };
}

function serializeWishBoardExtraData(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      throw new WishBoardError('extra_data 无效', 400, { ok: false, error: 'extra_data 无效' });
    }
  }
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw);
    } catch {
      throw new WishBoardError('extra_data 无效', 400, { ok: false, error: 'extra_data 无效' });
    }
  }
  throw new WishBoardError('extra_data 无效', 400, { ok: false, error: 'extra_data 无效' });
}

/**
 * 云端强制：积分之外的绑定项目 / 任务 / 待办须全部完成才可兑换。
 * 项目：completed | archived；任务与待办：done。缺失绑定目标视为未完成。
 */
async function assertWishBoardRedeemConditionsMet(
  conn: PoolConnection,
  extraData: unknown,
): Promise<void> {
  const conditions = parseWishBoardRedeemConditions(extraData);
  const pendingTitles: string[] = [];
  const pendingDetails: Array<{
    kind: 'project' | 'task' | 'todo';
    id: string;
    title: string;
    missing: boolean;
  }> = [];

  if (conditions.project_ids.length > 0) {
    const placeholders = conditions.project_ids.map(() => '?').join(', ');
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT id, name, status FROM projects WHERE id IN (${placeholders})`,
      conditions.project_ids,
    );
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    for (const projectId of conditions.project_ids) {
      const row = byId.get(projectId);
      const done =
        row != null && (row.status === 'completed' || row.status === 'archived');
      if (!done) {
        const title = row?.name != null ? String(row.name).trim() || '未知项目' : '已删除的项目';
        pendingTitles.push(title);
        pendingDetails.push({
          kind: 'project',
          id: projectId,
          title,
          missing: !row,
        });
      }
    }
  }

  const taskLike: Array<{ kind: 'task' | 'todo'; id: string }> = [
    ...conditions.task_ids.map((id) => ({ kind: 'task' as const, id })),
    ...conditions.todo_ids.map((id) => ({ kind: 'todo' as const, id })),
  ];
  if (taskLike.length > 0) {
    const uniqueIds = [...new Set(taskLike.map((t) => t.id))];
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT id, title, status FROM tasks WHERE id IN (${placeholders})`,
      uniqueIds,
    );
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    for (const item of taskLike) {
      const row = byId.get(item.id);
      const done = row != null && row.status === 'done';
      if (!done) {
        const fallback = item.kind === 'todo' ? '已删除的待办' : '已删除的任务';
        const unknown = item.kind === 'todo' ? '未知待办' : '未知任务';
        const title =
          row?.title != null ? String(row.title).trim() || unknown : fallback;
        pendingTitles.push(title);
        pendingDetails.push({
          kind: item.kind,
          id: item.id,
          title,
          missing: !row,
        });
      }
    }
  }

  if (pendingDetails.length === 0) return;

  const names = pendingTitles.slice(0, 3).map((t) => `「${t}」`);
  const more = pendingTitles.length > 3 ? ` 等 ${pendingTitles.length} 项` : '';
  throw new WishBoardError(`尚有绑定项未完成：${names.join('、')}${more}`, 400, {
    ok: false,
    error: '兑换条件未满足',
    pending: pendingDetails,
  });
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

export interface RedeemResultItem {
  id: string;
  status: 'active' | 'redeemed';
  redeemed_at: string;
  wish_type: 'once' | 'repeat';
  cost_points: number;
}

export interface RedeemResult {
  ok: true;
  balance: number;
  ledger_id: string;
  /** 合并本地心愿行；「已兑换」列表以 wish_redeem 流水为准（含 repeat 每次兑换） */
  item: RedeemResultItem;
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
      `SELECT id, cost_points, status, wish_type, extra_data FROM wish_board_items WHERE id = ? FOR UPDATE`,
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

    // 绑定项目 / 任务 / 待办完成情况（与 APP 本地规则一致）
    await assertWishBoardRedeemConditionsMet(conn, wish.extra_data);

    const costPoints = asPoints(wish.cost_points);
    const balance = await lockOrCreateWallet(conn);
    if (costPoints > 0 && balance < costPoints) {
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
    const redeemedAtApi = formatDbDateTimeForApi(now, 'utc') ?? now;

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
      balance: newBalance,
      ledger_id: ledgerId,
      item: {
        id,
        status: nextStatus,
        redeemed_at: redeemedAtApi,
        wish_type: wishType,
        cost_points: costPoints,
      },
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
 * habit_* / task_* / project_* / wish_redeem / points_reset 与 APP 约定一致。
 */
export const POINTS_LEDGER_REASONS = [
  'habit_check_in',
  'habit_check_in_undo',
  'habit_goal_complete',
  'habit_goal_complete_undo',
  'task_complete',
  'task_complete_undo',
  'project_complete',
  'project_complete_undo',
  'wish_redeem',
  'points_reset',
  'manual_adjust',
] as const;

export type PointsLedgerReason = (typeof POINTS_LEDGER_REASONS)[number];

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
 * 左连习惯/任务/项目/心愿带回关联标题；reason_label 供前端直接展示。
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
          COALESCE(w.title, t.title, p.name, h.name) AS ref_title
       FROM points_ledger l
       LEFT JOIN wish_board_items w
         ON l.ref_type COLLATE utf8mb4_unicode_ci = 'wish_board_item'
        AND w.id COLLATE utf8mb4_unicode_ci = l.ref_id COLLATE utf8mb4_unicode_ci
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
 * 若为 wish_redeem 且对应 once 心愿已兑完，恢复为可兑换。
 */
export async function deletePointsLedgerEntry(ledgerId: string): Promise<DeletePointsLedgerResult> {
  const id = String(ledgerId ?? '').trim();
  if (!id) {
    throw new WishBoardError('参数缺失', 400, { ok: false, error: '参数缺失' });
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
      throw new WishBoardError('流水不存在', 404, { ok: false, error: '流水不存在' });
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

    // 兑换流水回退后：一次性已兑完心愿恢复可兑换
    if (
      reason === 'wish_redeem' &&
      refType === 'wish_board_item' &&
      refId &&
      refId.trim()
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
        [now, refId.trim()],
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
  let delta = asPoints(input.delta);
  if (!Number.isFinite(delta)) {
    throw new WishBoardError('delta 必须为数字', 400, {
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
 * 心愿板「重置积分」：事务内清零钱包并追加 points_reset 负向流水。
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

export interface WishBoardItemRecord {
  id: string;
  title: string;
  description: string | null;
  cost_points: number;
  note: string | null;
  icon_key: string | null;
  wish_type: 'once' | 'repeat';
  status: 'active' | 'redeemed';
  redeemed_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  sync_status: string;
  extra_data: unknown;
}

export interface CreateWishBoardItemInput {
  id?: string | null;
  title: string;
  description?: string | null;
  cost_points?: number | null;
  note?: string | null;
  icon_key?: string | null;
  wish_type?: string | null;
  sort_order?: number | null;
  /** 含 redeem_conditions 等扩展字段 */
  extra_data?: unknown;
}

export interface RedeemedWishRecord {
  ledger_id: string;
  wish_id: string;
  delta: number;
  balance_after: number;
  redeemed_at: string;
  title: string | null;
  description: string | null;
  cost_points: number | null;
  note: string | null;
  icon_key: string | null;
  wish_type: 'once' | 'repeat' | null;
  status: 'active' | 'redeemed' | null;
}

function newWishId(): string {
  return randomUUID();
}

function normalizeTitle(raw: unknown): string {
  const title = String(raw ?? '').trim();
  if (!title || [...title].length > 80) {
    throw new WishBoardError('心愿名称无效', 400, { ok: false, error: '心愿名称无效' });
  }
  return title;
}

function normalizeCostPoints(raw: unknown, fallback = 0): number {
  const value = raw == null || raw === '' ? fallback : raw;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new WishBoardError('所需积分无效', 400, { ok: false, error: '所需积分无效' });
  }
  return Math.round(n * 100) / 100;
}

function normalizeOptionalText(raw: unknown, field: string, maxChars: number): string | null {
  if (raw == null || raw === '') return null;
  const text = String(raw);
  if ([...text].length > maxChars) {
    throw new WishBoardError(`${field} 最多 ${maxChars} 字`, 400, {
      ok: false,
      error: `${field} 最多 ${maxChars} 字`,
    });
  }
  return text;
}

function mapWishRow(row: RowDataPacket): WishBoardItemRecord {
  const wishType: 'once' | 'repeat' = row.wish_type === 'repeat' ? 'repeat' : 'once';
  const status: 'active' | 'redeemed' = row.status === 'redeemed' ? 'redeemed' : 'active';
  return {
    id: String(row.id),
    title: String(row.title ?? ''),
    description: row.description == null ? null : String(row.description),
    cost_points: Number(row.cost_points ?? 0),
    note: row.note == null ? null : String(row.note),
    icon_key: row.icon_key == null ? null : String(row.icon_key),
    wish_type: wishType,
    status,
    redeemed_at: formatDbDateTimeForApi(row.redeemed_at, 'utc'),
    sort_order: Number(row.sort_order ?? 1000),
    created_at: formatDbDateTimeForApi(row.created_at, 'utc') ?? String(row.created_at),
    updated_at: formatDbDateTimeForApi(row.updated_at, 'utc') ?? String(row.updated_at),
    sync_status: row.sync_status == null ? 'synced' : String(row.sync_status),
    extra_data: row.extra_data ?? null,
  };
}

const WISH_SELECT = `SELECT id, title, description, cost_points, note, icon_key, wish_type,
        status, redeemed_at, sort_order, created_at, updated_at, sync_status, extra_data
     FROM wish_board_items`;

/** 添加新心愿（id 可选；未传则服务端生成 UUID） */
export async function createWishBoardItem(
  input: CreateWishBoardItemInput,
): Promise<WishBoardItemRecord> {
  const title = normalizeTitle(input.title);
  const costPoints = normalizeCostPoints(input.cost_points, 0);
  let description = normalizeOptionalText(input.description, 'description', 500);
  let note = normalizeOptionalText(input.note, 'note', 500);
  if (description == null && note != null) description = note;
  else if (note == null && description != null) note = description;

  const iconRaw = input.icon_key == null ? '' : String(input.icon_key).trim();
  const iconKey = iconRaw || 'card-giftcard';
  if (iconKey.length > 64) {
    throw new WishBoardError('icon_key 最多 64 字', 400, { ok: false, error: 'icon_key 最多 64 字' });
  }

  const wishTypeRaw = String(input.wish_type ?? 'once').trim() || 'once';
  if (wishTypeRaw !== 'once' && wishTypeRaw !== 'repeat') {
    throw new WishBoardError('心愿类型无效', 400, { ok: false, error: '心愿类型无效' });
  }

  let sortOrder = 1000;
  if (input.sort_order != null && input.sort_order !== ('' as unknown)) {
    const n = typeof input.sort_order === 'number' ? input.sort_order : Number(input.sort_order);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new WishBoardError('sort_order 必须为整数', 400, {
        ok: false,
        error: 'sort_order 必须为整数',
      });
    }
    sortOrder = n;
  }

  const id =
    input.id != null && String(input.id).trim() !== ''
      ? String(input.id).trim()
      : newWishId();
  if (id.length > 36) {
    throw new WishBoardError('id 最多 36 字', 400, { ok: false, error: 'id 最多 36 字' });
  }

  const extraData = serializeWishBoardExtraData(
    Object.prototype.hasOwnProperty.call(input, 'extra_data') ? input.extra_data : null,
  );

  const now = nowUtcMysql();
  try {
    await db.query(
      `INSERT INTO wish_board_items
        (id, title, description, cost_points, note, icon_key, wish_type, status,
         redeemed_at, sort_order, created_at, updated_at, sync_status, extra_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, 'synced', ?)`,
      [
        id,
        title,
        description,
        costPoints,
        note,
        iconKey,
        wishTypeRaw,
        sortOrder,
        now,
        now,
        extraData,
      ],
    );
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      throw new WishBoardError('心愿已存在', 409, { ok: false, error: '心愿已存在' });
    }
    throw err;
  }

  const item = await getWishBoardItem(id);
  if (!item) {
    throw new WishBoardError('创建失败', 500, { ok: false, error: '创建失败' });
  }
  return item;
}

export async function getWishBoardItem(id: string): Promise<WishBoardItemRecord | null> {
  const [rows] = await db.query<RowDataPacket[]>(`${WISH_SELECT} WHERE id = ? LIMIT 1`, [
    id.trim(),
  ]);
  const row = rows[0];
  return row ? mapWishRow(row) : null;
}

/** 心愿列表：status=active（含可重复兑换的 repeat 心愿） */
export async function listActiveWishBoardItems(): Promise<WishBoardItemRecord[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `${WISH_SELECT}
     WHERE status = 'active'
     ORDER BY sort_order ASC, updated_at DESC, id ASC`,
  );
  return rows.map(mapWishRow);
}

/**
 * 已兑换列表：以 wish_redeem 流水为准（含 repeat 每次兑换）。
 * 左连心愿表以带回标题等信息；心愿已删时 title 等为 null。
 */
export async function listRedeemedWishBoardItems(): Promise<RedeemedWishRecord[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT
        l.id AS ledger_id,
        l.ref_id AS wish_id,
        l.delta,
        l.balance_after,
        l.created_at AS redeemed_at,
        w.title,
        w.description,
        w.cost_points,
        w.note,
        w.icon_key,
        w.wish_type,
        w.status
     FROM points_ledger l
     LEFT JOIN wish_board_items w ON w.id = l.ref_id
     WHERE l.reason = 'wish_redeem'
     ORDER BY l.created_at DESC, l.id DESC`,
  );

  return rows.map((row) => {
    const wishType =
      row.wish_type == null
        ? null
        : row.wish_type === 'repeat'
          ? ('repeat' as const)
          : ('once' as const);
    const status =
      row.status == null
        ? null
        : row.status === 'redeemed'
          ? ('redeemed' as const)
          : ('active' as const);
    return {
      ledger_id: String(row.ledger_id),
      wish_id: String(row.wish_id ?? ''),
      delta: Number(row.delta ?? 0),
      balance_after: Number(row.balance_after ?? 0),
      redeemed_at: formatDbDateTimeForApi(row.redeemed_at, 'utc') ?? String(row.redeemed_at),
      title: row.title == null ? null : String(row.title),
      description: row.description == null ? null : String(row.description),
      cost_points: row.cost_points == null ? null : Number(row.cost_points),
      note: row.note == null ? null : String(row.note),
      icon_key: row.icon_key == null ? null : String(row.icon_key),
      wish_type: wishType,
      status,
    };
  });
}

/** 删除心愿（按 id；不退回积分） */
export async function deleteWishBoardItem(wishId: string): Promise<{ deleted: true; id: string }> {
  const id = wishId.trim();
  if (!id) {
    throw new WishBoardError('参数缺失', 400, { ok: false, error: '参数缺失' });
  }

  const [result] = await db.query<ResultSetHeader>(
    `DELETE FROM wish_board_items WHERE id = ?`,
    [id],
  );
  if (result.affectedRows <= 0) {
    throw new WishBoardError('心愿不存在', 404, { ok: false, error: '心愿不存在' });
  }
  return { deleted: true, id };
}

/**
 * 删除已兑换心愿：
 * - 未传 id：清空所有 status=redeemed 的一次性已兑完心愿
 * - 传 id：仅删除该条（须为 redeemed）
 * 不删 wish_redeem 流水，避免破坏积分对账；已兑换列表仍可由流水查出。
 */
export async function deleteRedeemedWishBoardItems(
  wishId?: string | null,
): Promise<{ deleted: number; ids: string[] }> {
  const id = wishId != null ? String(wishId).trim() : '';

  if (id) {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT id, status FROM wish_board_items WHERE id = ? LIMIT 1`,
      [id],
    );
    const row = rows[0];
    if (!row) {
      throw new WishBoardError('心愿不存在', 404, { ok: false, error: '心愿不存在' });
    }
    if (row.status !== 'redeemed') {
      throw new WishBoardError('仅可删除已兑换心愿', 400, {
        ok: false,
        error: '仅可删除已兑换心愿',
      });
    }
    await db.query(`DELETE FROM wish_board_items WHERE id = ?`, [id]);
    return { deleted: 1, ids: [id] };
  }

  const [existing] = await db.query<RowDataPacket[]>(
    `SELECT id FROM wish_board_items WHERE status = 'redeemed'`,
  );
  const ids = existing.map((r) => String(r.id));
  if (ids.length === 0) {
    return { deleted: 0, ids: [] };
  }

  const [result] = await db.query<ResultSetHeader>(
    `DELETE FROM wish_board_items WHERE status = 'redeemed'`,
  );
  return { deleted: result.affectedRows, ids };
}
