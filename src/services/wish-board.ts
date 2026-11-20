import { randomUUID } from 'crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { db } from '../db/index.js';
import { formatDbDateTimeForApi } from './calendar/logical-day.js';
import {
  POINTS_WALLET_ID,
  applyWalletDeltaOnConnection,
  asPoints,
  lockOrCreateWallet,
  nowUtcMysql,
} from './points-wallet.js';
import {
  appendChangeLog,
  discardPendingSyncPublish,
  flushPendingSyncPublish,
  withSyncTransaction,
  type ChangeLogEvent,
  type SyncWriteOptions,
} from './sync-change-log.js';
import { deleteLiveWithRevision, stampLiveUpsert, throwTombstoneConflict } from './sync-revision.js';

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

const REDEEM_CONDITIONS_KEY = 'redeem_conditions';
const NET_WORTH_CHECK_ID = 'min_net_worth';
const AVAILABLE_FROM_CHECK_ID = 'available_from';

export type WishBoardRedeemConditions = {
  project_ids: string[];
  task_ids: string[];
  todo_ids: string[];
  /** 养成/戒除周期目标已达成的小习惯；周期配额不纳入 */
  habit_ids: string[];
  /** 当前净资产须 ≥ 该值；null 表示不限制 */
  min_net_worth: number | null;
  /** 本地墙上时钟 `YYYY-MM-DD HH:mm:00`；到达后才可兑换 */
  available_from: string | null;
};

/** Agent / API 写入兑换条件（字段均可选；null 表示清除该项） */
export type WishBoardRedeemConditionsInput = {
  project_ids?: string[] | null;
  task_ids?: string[] | null;
  todo_ids?: string[] | null;
  habit_ids?: string[] | null;
  min_net_worth?: number | null;
  available_from?: string | null;
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

function normalizeMinNetWorth(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function truncMoneyToFen(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 100;
  return value >= 0
    ? Math.floor(value * factor + 1e-9) / factor
    : Math.ceil(value * factor - 1e-9) / factor;
}

function isNetWorthAtLeast(current: number, min: number): boolean {
  return truncMoneyToFen(current) >= truncMoneyToFen(min);
}

function formatMoneyLabel(value: number): string {
  const truncated = truncMoneyToFen(value);
  const abs = Math.abs(truncated);
  const prefix = truncated < 0 ? '-¥' : '¥';
  return `${prefix}${abs.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function normalizeAvailableFrom(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim();
  if (!text) return null;
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (!match) return null;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  const hh = match[4] != null ? Number(match[4]) : 0;
  const mm = match[5] != null ? Number(match[5]) : 0;
  if (
    !Number.isFinite(y) ||
    !Number.isFinite(mo) ||
    !Number.isFinite(d) ||
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > 31 ||
    hh < 0 ||
    hh > 23 ||
    mm < 0 ||
    mm > 59
  ) {
    return null;
  }
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
}

function emptyWishBoardRedeemConditions(): WishBoardRedeemConditions {
  return {
    project_ids: [],
    task_ids: [],
    todo_ids: [],
    habit_ids: [],
    min_net_worth: null,
    available_from: null,
  };
}

export function normalizeWishBoardRedeemConditionsInput(
  raw: unknown,
): WishBoardRedeemConditions {
  if (raw == null || raw === '') return emptyWishBoardRedeemConditions();
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WishBoardError('redeem_conditions 无效', 400, {
      ok: false,
      error: 'redeem_conditions 无效',
    });
  }
  const obj = raw as Record<string, unknown>;
  return {
    project_ids: normalizeIdList(obj.project_ids),
    task_ids: normalizeIdList(obj.task_ids),
    todo_ids: normalizeIdList(obj.todo_ids),
    habit_ids: normalizeIdList(obj.habit_ids),
    min_net_worth: normalizeMinNetWorth(obj.min_net_worth),
    available_from: normalizeAvailableFrom(obj.available_from),
  };
}

/** 将 redeem_conditions 合并进 extra_data（空条件则删除该键） */
export function mergeWishBoardRedeemConditions(
  extraData: unknown,
  conditions: WishBoardRedeemConditions | WishBoardRedeemConditionsInput | null | undefined,
): Record<string, unknown> | null {
  const base = parseExtraObject(extraData);
  const next = conditions
    ? normalizeWishBoardRedeemConditionsInput(conditions)
    : emptyWishBoardRedeemConditions();

  const empty =
    next.project_ids.length === 0 &&
    next.task_ids.length === 0 &&
    next.todo_ids.length === 0 &&
    next.habit_ids.length === 0 &&
    next.min_net_worth == null &&
    next.available_from == null;

  if (empty) {
    delete base[REDEEM_CONDITIONS_KEY];
  } else {
    const payload: Record<string, unknown> = {
      project_ids: next.project_ids,
      task_ids: next.task_ids,
      todo_ids: next.todo_ids,
      habit_ids: next.habit_ids,
    };
    if (next.min_net_worth != null) payload.min_net_worth = next.min_net_worth;
    if (next.available_from != null) payload.available_from = next.available_from;
    base[REDEEM_CONDITIONS_KEY] = payload;
  }

  return Object.keys(base).length === 0 ? null : base;
}

function isAvailableFromMet(availableFrom: string | null, now = new Date()): boolean {
  if (!availableFrom) return true;
  const m = availableFrom.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return false;
  const date = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
  if (Number.isNaN(date.getTime())) return false;
  return now.getTime() >= date.getTime();
}

function formatAvailableFromLabel(availableFrom: string): string {
  const m = availableFrom.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):/);
  if (!m) return availableFrom;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日 ${m[4]}:${m[5]}`;
}

function parseHabitKind(extraData: unknown): 'build' | 'break' | 'task' {
  const extra = parseExtraObject(extraData);
  if (extra.habitKind === 'break') return 'break';
  if (extra.habitKind === 'task') return 'task';
  return 'build';
}

function parseQuantifyRaw(extraData: unknown): Record<string, unknown> | null {
  const extra = parseExtraObject(extraData);
  const q = extra.quantify;
  if (!q || typeof q !== 'object' || Array.isArray(q)) return null;
  return q as Record<string, unknown>;
}

/** 养成：quantify.expectedGoal 已设 */
function hasBuildHabitExpectedGoal(extraData: unknown): boolean {
  const raw = parseQuantifyRaw(extraData)?.expectedGoal;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const obj = raw as { type?: unknown; value?: unknown };
  if (obj.type !== 'days' && obj.type !== 'times' && obj.type !== 'consecutive_days') return false;
  return typeof obj.value === 'number' && Number.isFinite(obj.value) && Math.round(obj.value) >= 1;
}

/** 戒除：quantify.consecutiveTargetDays 已设 */
function hasBreakHabitConsecutiveTarget(extraData: unknown): boolean {
  const v = parseQuantifyRaw(extraData)?.consecutiveTargetDays;
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  return Math.round(v) >= 1;
}

function isHabitEligibleForWishRedeem(extraData: unknown): boolean {
  const kind = parseHabitKind(extraData);
  if (kind === 'build') return hasBuildHabitExpectedGoal(extraData);
  if (kind === 'break') return hasBreakHabitConsecutiveTarget(extraData);
  return false;
}

function isBuildHabitSucceeded(extraData: unknown): boolean {
  const cycle = parseExtraObject(extraData).buildHabitCycle;
  if (!cycle || typeof cycle !== 'object' || Array.isArray(cycle)) return false;
  const completedAt = (cycle as Record<string, unknown>).completedAt;
  return typeof completedAt === 'string' && completedAt.trim().length > 0;
}

function isBreakHabitSucceeded(extraData: unknown): boolean {
  const cycle = parseExtraObject(extraData).breakHabitCycle;
  if (!cycle || typeof cycle !== 'object' || Array.isArray(cycle)) return false;
  const completedAt = (cycle as Record<string, unknown>).completedAt;
  return typeof completedAt === 'string' && completedAt.trim().length > 0;
}

function isHabitWishRedeemConditionMet(extraData: unknown): boolean {
  const kind = parseHabitKind(extraData);
  if (kind === 'build') return isBuildHabitSucceeded(extraData);
  if (kind === 'break') return isBreakHabitSucceeded(extraData);
  return false;
}

export function parseWishBoardRedeemConditions(extraData: unknown): WishBoardRedeemConditions {
  const base = parseExtraObject(extraData);
  const raw = base[REDEEM_CONDITIONS_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyWishBoardRedeemConditions();
  }
  return normalizeWishBoardRedeemConditionsInput(raw);
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
 * 云端强制：积分之外的绑定项目 / 任务 / 待办 / 习惯 / 净资产 / 开放时间须全部满足才可兑换。
 * 项目：completed | archived | done | cancelled；任务与待办：done。缺失绑定目标视为未完成。
 */
async function assertWishBoardRedeemConditionsMet(
  conn: PoolConnection,
  extraData: unknown,
): Promise<void> {
  const conditions = parseWishBoardRedeemConditions(extraData);
  const pendingTitles: string[] = [];
  const pendingDetails: Array<{
    kind: 'project' | 'task' | 'todo' | 'habit' | 'available_from' | 'net_worth';
    id: string;
    title: string;
    missing: boolean;
    habit_kind?: 'build' | 'break' | null;
  }> = [];

  if (conditions.available_from && !isAvailableFromMet(conditions.available_from)) {
    const title = formatAvailableFromLabel(conditions.available_from);
    pendingTitles.push(`开放兑换时间（自 ${title} 起）`);
    pendingDetails.push({
      kind: 'available_from',
      id: AVAILABLE_FROM_CHECK_ID,
      title: conditions.available_from,
      missing: false,
    });
  }

  if (conditions.min_net_worth != null) {
    const { getFinanceNetWorth } = await import('./pages/finance.js');
    const current = await getFinanceNetWorth();
    if (!isNetWorthAtLeast(current, conditions.min_net_worth)) {
      const needLabel = formatMoneyLabel(conditions.min_net_worth);
      const currentLabel = formatMoneyLabel(current);
      pendingTitles.push(`净资产达到 ${needLabel}（当前 ${currentLabel}）`);
      pendingDetails.push({
        kind: 'net_worth',
        id: NET_WORTH_CHECK_ID,
        title: `净资产达到 ${needLabel}（当前 ${currentLabel}）`,
        missing: false,
      });
    }
  }

  if (conditions.habit_ids.length > 0) {
    const placeholders = conditions.habit_ids.map(() => '?').join(', ');
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT id, name, extra_data FROM habits WHERE id IN (${placeholders})`,
      conditions.habit_ids,
    );
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    for (const habitId of conditions.habit_ids) {
      const row = byId.get(habitId);
      if (!row) {
        pendingTitles.push('已删除的习惯');
        pendingDetails.push({
          kind: 'habit',
          id: habitId,
          title: '已删除的习惯',
          missing: true,
          habit_kind: null,
        });
        continue;
      }
      const extra = row.extra_data;
      const kind = parseHabitKind(extra);
      const habitKind = kind === 'build' || kind === 'break' ? kind : null;
      const name = row.name != null ? String(row.name).trim() || '未知习惯' : '未知习惯';
      const eligible = isHabitEligibleForWishRedeem(extra);
      const done = eligible && isHabitWishRedeemConditionMet(extra);
      if (!done) {
        if (!eligible) {
          pendingTitles.push(
            habitKind === 'break'
              ? `${name}（未设连续挑战目标）`
              : `${name}（未设周期目标）`,
          );
        } else if (habitKind === 'break') {
          pendingTitles.push(`${name}（连续挑战尚未完成）`);
        } else {
          pendingTitles.push(`${name}（养成目标尚未达成）`);
        }
        pendingDetails.push({
          kind: 'habit',
          id: habitId,
          title: name,
          missing: false,
          habit_kind: habitKind,
        });
      }
    }
  }

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
        row != null &&
        (row.status === 'done' ||
          row.status === 'cancelled' ||
          row.status === 'completed' ||
          row.status === 'archived');
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

  if (
    pendingDetails.length === 1 &&
    pendingDetails[0]?.kind === 'available_from' &&
    conditions.available_from
  ) {
    throw new WishBoardError(
      `尚未到开放兑换时间（自 ${formatAvailableFromLabel(conditions.available_from)} 起）`,
      400,
      {
        ok: false,
        error: '兑换条件未满足',
        pending: pendingDetails,
      },
    );
  }

  const names = pendingTitles.slice(0, 3).map((t) => `「${t}」`);
  const more = pendingTitles.length > 3 ? ` 等 ${pendingTitles.length} 项` : '';
  throw new WishBoardError(`尚有绑定项未完成：${names.join('、')}${more}`, 400, {
    ok: false,
    error: '兑换条件未满足',
    pending: pendingDetails,
  });
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
export async function redeemWishBoardItem(
  wishBoardItemId: string,
  options?: SyncWriteOptions,
): Promise<RedeemResult> {
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

    const now = nowUtcMysql();
    const nextStatus: 'active' | 'redeemed' = wishType === 'repeat' ? 'active' : 'redeemed';
    const redeemedAtApi = formatDbDateTimeForApi(now, 'utc') ?? now;

    // 钱包扣减走 points-wallet 单入口（与 adjust/grant 同一写路径）
    const wallet = await applyWalletDeltaOnConnection(conn, {
      balance,
      delta: asPoints(-costPoints),
      reason: 'wish_redeem',
      ref_type: 'wish_board_item',
      ref_id: id,
    });

    await conn.query<ResultSetHeader>(
      `UPDATE wish_board_items
       SET status = ?, redeemed_at = ?, updated_at = ?, sync_status = 'synced'
       WHERE id = ?`,
      [nextStatus, now, now, id],
    );

    const wishStamp = await stampLiveUpsert(conn, 'wish_board_items', id, {
      mode: 'update',
      skipOcc: true,
      mutationId: options?.mutationId,
    });
    const walletStamp = await stampLiveUpsert(conn, 'points_wallet', POINTS_WALLET_ID, {
      mode: 'update',
      skipOcc: true,
    });
    const ledgerStamp = wallet.ledger_id
      ? await stampLiveUpsert(conn, 'points_ledger', wallet.ledger_id, {
          mode: 'insert',
          skipOcc: true,
        })
      : null;

    await appendChangeLog(conn, [
      {
        tableName: 'wish_board_items',
        recordPk: id,
        op: 'upsert',
        updatedAt: now,
        deviceId: options?.deviceId,
        serverRev: wishStamp.serverRev,
        mutationId: wishStamp.mutationId,
      },
      {
        tableName: 'points_wallet',
        recordPk: POINTS_WALLET_ID,
        op: 'upsert',
        updatedAt: now,
        deviceId: options?.deviceId,
        serverRev: walletStamp.serverRev,
        mutationId: walletStamp.mutationId,
      },
      ...(ledgerStamp && wallet.ledger_id
        ? [
            {
              tableName: 'points_ledger',
              recordPk: wallet.ledger_id,
              op: 'upsert' as const,
              updatedAt: now,
              deviceId: options?.deviceId,
              serverRev: ledgerStamp.serverRev,
              mutationId: ledgerStamp.mutationId,
            },
          ]
        : []),
    ]);

    await conn.commit();
    await flushPendingSyncPublish(conn);

    return {
      ok: true,
      balance: wallet.balance,
      ledger_id: wallet.ledger_id,
      item: {
        id,
        status: nextStatus,
        redeemed_at: redeemedAtApi,
        wish_type: wishType,
        cost_points: costPoints,
      },
    };
  } catch (err) {
    discardPendingSyncPublish(conn);
    try {
      await conn.rollback();
    } catch {
      // ignore
    }
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
  /** 写入 extra_data.redeem_conditions（优先于 extra_data 内同名字段） */
  redeem_conditions?: WishBoardRedeemConditionsInput | null;
}

export interface UpdateWishBoardItemInput {
  title?: string | null;
  description?: string | null;
  cost_points?: number | null;
  note?: string | null;
  icon_key?: string | null;
  wish_type?: string | null;
  sort_order?: number | null;
  extra_data?: unknown;
  /** 写入 extra_data.redeem_conditions；传 null 清除全部附加条件 */
  redeem_conditions?: WishBoardRedeemConditionsInput | null;
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
  return asPoints(n);
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
  options?: SyncWriteOptions,
): Promise<WishBoardItemRecord> {
  const title = normalizeTitle(input.title);
  const costPoints = normalizeCostPoints(input.cost_points, 0);
  let description = normalizeOptionalText(input.description, 'description', 8000);
  let note = normalizeOptionalText(input.note, 'note', 8000);
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

  let extraPayload: unknown = Object.prototype.hasOwnProperty.call(input, 'extra_data')
    ? input.extra_data
    : null;
  if (Object.prototype.hasOwnProperty.call(input, 'redeem_conditions')) {
    extraPayload = mergeWishBoardRedeemConditions(extraPayload, input.redeem_conditions);
  }
  const extraData = serializeWishBoardExtraData(extraPayload);

  const now = nowUtcMysql();
  try {
    await withSyncTransaction(async (conn) => {
      await conn.query(
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
      const stamp = await stampLiveUpsert(conn, 'wish_board_items', id, {
        mode: 'insert',
        mutationId: options?.mutationId,
      });
      await appendChangeLog(conn, [
        {
          tableName: 'wish_board_items',
          recordPk: id,
          op: 'upsert',
          updatedAt: now,
          deviceId: options?.deviceId,
          serverRev: stamp.serverRev,
          mutationId: stamp.mutationId,
        },
      ]);
    });
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

/**
 * 更新心愿元数据（标题/积分/图标等）。
 * 禁止经此接口改 status / redeemed_at（兑换须走 redeem）。
 * 已兑换的 once 心愿不可再改名称、积分、兑换条件。
 */
export async function updateWishBoardItem(
  wishId: string,
  input: UpdateWishBoardItemInput,
  options?: SyncWriteOptions,
): Promise<WishBoardItemRecord> {
  const id = String(wishId ?? '').trim();
  if (!id) {
    throw new WishBoardError('参数缺失', 400, { ok: false, error: '参数缺失' });
  }

  const existing = await getWishBoardItem(id);
  if (!existing) {
    throw await throwTombstoneConflict(db, 'wish_board_items', id);
  }

  const patchingCore =
    input.title != null ||
    input.cost_points != null ||
    Object.prototype.hasOwnProperty.call(input, 'extra_data') ||
    Object.prototype.hasOwnProperty.call(input, 'redeem_conditions');
  if (existing.status === 'redeemed' && patchingCore) {
    throw new WishBoardError('已兑换的心愿不可再改名称、积分或兑换条件', 400, {
      ok: false,
      error: '已兑换的心愿不可再改名称、积分或兑换条件',
    });
  }

  const title =
    input.title !== undefined && input.title != null ? normalizeTitle(input.title) : existing.title;
  const costPoints =
    input.cost_points !== undefined && input.cost_points != null
      ? normalizeCostPoints(input.cost_points, existing.cost_points)
      : existing.cost_points;

  let description = existing.description;
  let note = existing.note;
  if (Object.prototype.hasOwnProperty.call(input, 'description')) {
    description = normalizeOptionalText(input.description, 'description', 8000);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'note')) {
    note = normalizeOptionalText(input.note, 'note', 8000);
  }
  if (
    Object.prototype.hasOwnProperty.call(input, 'description') &&
    !Object.prototype.hasOwnProperty.call(input, 'note')
  ) {
    note = description;
  } else if (
    Object.prototype.hasOwnProperty.call(input, 'note') &&
    !Object.prototype.hasOwnProperty.call(input, 'description')
  ) {
    description = note;
  }

  let iconKey = existing.icon_key ?? 'card-giftcard';
  if (Object.prototype.hasOwnProperty.call(input, 'icon_key')) {
    const iconRaw = input.icon_key == null ? '' : String(input.icon_key).trim();
    iconKey = iconRaw || 'card-giftcard';
    if (iconKey.length > 64) {
      throw new WishBoardError('icon_key 最多 64 字', 400, { ok: false, error: 'icon_key 最多 64 字' });
    }
  }

  let wishType = existing.wish_type;
  if (input.wish_type != null && String(input.wish_type).trim() !== '') {
    const wishTypeRaw = String(input.wish_type).trim();
    if (wishTypeRaw !== 'once' && wishTypeRaw !== 'repeat') {
      throw new WishBoardError('心愿类型无效', 400, { ok: false, error: '心愿类型无效' });
    }
    wishType = wishTypeRaw;
  }

  let sortOrder = existing.sort_order;
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

  let extraPayload: unknown = existing.extra_data;
  if (Object.prototype.hasOwnProperty.call(input, 'extra_data')) {
    extraPayload = input.extra_data;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'redeem_conditions')) {
    extraPayload = mergeWishBoardRedeemConditions(extraPayload, input.redeem_conditions);
  }
  const extraData =
    Object.prototype.hasOwnProperty.call(input, 'extra_data') ||
    Object.prototype.hasOwnProperty.call(input, 'redeem_conditions')
      ? serializeWishBoardExtraData(extraPayload)
      : existing.extra_data == null
        ? null
        : typeof existing.extra_data === 'string'
          ? existing.extra_data
          : JSON.stringify(existing.extra_data);

  const now = nowUtcMysql();
  await withSyncTransaction(async (conn) => {
    await conn.query(
      `UPDATE wish_board_items SET
         title = ?, description = ?, cost_points = ?, note = ?, icon_key = ?, wish_type = ?,
         sort_order = ?, extra_data = ?, updated_at = ?, sync_status = 'synced'
       WHERE id = ?`,
      [title, description, costPoints, note, iconKey, wishType, sortOrder, extraData, now, id],
    );
    const stamp = await stampLiveUpsert(conn, 'wish_board_items', id, {
      mode: 'update',
      mutationId: options?.mutationId,
      expectedRev: options?.expectedRev,
    });
    await appendChangeLog(conn, [
      {
        tableName: 'wish_board_items',
        recordPk: id,
        op: 'upsert',
        updatedAt: now,
        deviceId: options?.deviceId,
        serverRev: stamp.serverRev,
        mutationId: stamp.mutationId,
      },
    ]);
  });

  const item = await getWishBoardItem(id);
  if (!item) {
    throw new WishBoardError('更新失败', 500, { ok: false, error: '更新失败' });
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
export async function deleteWishBoardItem(
  wishId: string,
  options?: SyncWriteOptions,
): Promise<{ deleted: true; id: string }> {
  const id = wishId.trim();
  if (!id) {
    throw new WishBoardError('参数缺失', 400, { ok: false, error: '参数缺失' });
  }

  await withSyncTransaction(async (conn) => {
    const del = await deleteLiveWithRevision(conn, 'wish_board_items', id, {
      mutationId: options?.mutationId,
      expectedRev: options?.expectedRev,
    });
    if (del.kind === 'already_gone') {
      return;
    }
    await appendChangeLog(conn, [
      {
        tableName: 'wish_board_items',
        recordPk: id,
        op: 'delete',
        deviceId: options?.deviceId,
        serverRev: del.serverRev,
        mutationId: del.mutationId,
      },
    ]);
  });
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
  options?: SyncWriteOptions,
): Promise<{ deleted: number; ids: string[] }> {
  const id = wishId != null ? String(wishId).trim() : '';

  if (id) {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT id, status FROM wish_board_items WHERE id = ? LIMIT 1`,
      [id],
    );
    const row = rows[0];
    if (!row) {
      return { deleted: 0, ids: [] };
    }
    if (row.status !== 'redeemed') {
      throw new WishBoardError('仅可删除已兑换心愿', 400, {
        ok: false,
        error: '仅可删除已兑换心愿',
      });
    }
    const removed = await withSyncTransaction(async (conn) => {
      const del = await deleteLiveWithRevision(conn, 'wish_board_items', id, {
        mutationId: options?.mutationId,
        expectedRev: options?.expectedRev,
      });
      if (del.kind === 'already_gone') {
        return false;
      }
      await appendChangeLog(conn, [
        {
          tableName: 'wish_board_items',
          recordPk: id,
          op: 'delete',
          deviceId: options?.deviceId,
          serverRev: del.serverRev,
          mutationId: del.mutationId,
        },
      ]);
      return true;
    });
    return { deleted: removed ? 1 : 0, ids: removed ? [id] : [] };
  }

  const [existing] = await db.query<RowDataPacket[]>(
    `SELECT id FROM wish_board_items WHERE status = 'redeemed'`,
  );
  const ids = existing.map((r) => String(r.id));
  if (ids.length === 0) {
    return { deleted: 0, ids: [] };
  }

  await withSyncTransaction(async (conn) => {
    const events: ChangeLogEvent[] = [];
    for (const pk of ids) {
      const del = await deleteLiveWithRevision(conn, 'wish_board_items', pk, {
        skipOcc: true,
        mutationId: options?.mutationId,
      });
      if (del.kind === 'deleted') {
        events.push({
          tableName: 'wish_board_items',
          recordPk: pk,
          op: 'delete',
          deviceId: options?.deviceId,
          serverRev: del.serverRev,
          mutationId: del.mutationId,
        });
      }
    }
    if (events.length > 0) await appendChangeLog(conn, events);
  });
  return { deleted: ids.length, ids };
}

export type WishBoardEligibilityCheckKind =
  | 'project'
  | 'task'
  | 'todo'
  | 'habit'
  | 'net_worth'
  | 'available_from';

export type WishBoardEligibilityCheck = {
  kind: WishBoardEligibilityCheckKind;
  id: string;
  title: string;
  done: boolean;
  missing: boolean;
  habit_kind?: 'build' | 'break' | null;
  ineligible?: boolean;
};

export type WishBoardGapGuide = {
  kind: WishBoardEligibilityCheckKind | 'points';
  id: string;
  title: string;
  hint: string;
  action_label: string;
  module_id: string;
  route: string;
};

export type WishBoardEligibilityResult = {
  wish_id: string;
  title: string;
  wish_type: 'once' | 'repeat';
  status: 'active' | 'redeemed';
  ok: boolean;
  points_ok: boolean;
  conditions_ok: boolean;
  cost_points: number;
  balance: number;
  points_gap: number;
  current_net_worth: number | null;
  conditions: WishBoardRedeemConditions;
  checks: WishBoardEligibilityCheck[];
  pending: WishBoardEligibilityCheck[];
  message: string | null;
  /** 引导补齐缺口：跳转任务 / 习惯 / 资产 / 赚积分（不自动兑） */
  guides: WishBoardGapGuide[];
};

function kindLabelZh(kind: WishBoardEligibilityCheckKind): string {
  if (kind === 'project') return '项目';
  if (kind === 'todo') return '待办';
  if (kind === 'habit') return '小习惯';
  if (kind === 'net_worth') return '净资产';
  if (kind === 'available_from') return '开放时间';
  return '任务';
}

function buildEligibilityMessage(input: {
  pointsOk: boolean;
  costPoints: number;
  balance: number;
  pending: WishBoardEligibilityCheck[];
}): string | null {
  const { pointsOk, costPoints, balance, pending } = input;
  if (pointsOk && pending.length === 0) return null;

  if (pending.length === 1) {
    const only = pending[0]!;
    let single: string | null = null;
    if (only.kind === 'net_worth') single = `净资产不足（${only.title}）`;
    else if (only.kind === 'available_from') {
      single = `尚未到开放兑换时间（自 ${formatAvailableFromLabel(only.title)} 起）`;
    } else if (only.kind === 'habit') {
      if (only.missing) single = `绑定的小习惯「${only.title}」已删除`;
      else if (only.ineligible) single = `小习惯「${only.title}」未设周期目标`;
      else if (only.habit_kind === 'break') {
        single = `戒除习惯「${only.title}」连续挑战尚未完成`;
      } else {
        single = `养成习惯「${only.title}」周期目标尚未达成`;
      }
    }
    if (!pointsOk && single) {
      return `积分不足（需要 ${costPoints}，当前 ${balance}），且${single}`;
    }
    if (!pointsOk) {
      return `积分不足（需要 ${costPoints}，当前 ${balance}），且仍有未完成的绑定项`;
    }
    if (single) return single;
  }

  if (!pointsOk && pending.length > 0) {
    return `积分不足（需要 ${costPoints}，当前 ${balance}），且仍有未完成的绑定项`;
  }
  if (!pointsOk) {
    return `积分不足（需要 ${costPoints}，当前 ${balance}）`;
  }
  const names = pending.slice(0, 3).map((p) => {
    if (p.kind === 'available_from') return '「开放兑换时间」';
    const title = p.missing ? `已删除的${kindLabelZh(p.kind)}` : p.title;
    return `「${title}」`;
  });
  const more = pending.length > 3 ? ` 等 ${pending.length} 项` : '';
  return `尚有绑定项未完成：${names.join('、')}${more}`;
}

function guideForCheck(check: WishBoardEligibilityCheck): WishBoardGapGuide {
  if (check.kind === 'net_worth') {
    return {
      kind: 'net_worth',
      id: check.id,
      title: check.title,
      hint: '去资产页攒净资产',
      action_label: '去攒钱',
      module_id: 'finance.assets',
      route: '/assets',
    };
  }
  if (check.kind === 'available_from') {
    return {
      kind: 'available_from',
      id: check.id,
      title: check.title,
      hint: '等到开放兑换时间后再来',
      action_label: '稍后再来',
      module_id: 'wish.home',
      route: '/wish-board',
    };
  }
  if (check.kind === 'habit') {
    return {
      kind: 'habit',
      id: check.id,
      title: check.title,
      hint: check.habit_kind === 'break' ? '去完成连续挑战' : '去打卡达成周期目标',
      action_label: '去打卡',
      module_id: 'habit.detail',
      route: `/habit-detail?habitId=${encodeURIComponent(check.id)}`,
    };
  }
  if (check.kind === 'project') {
    return {
      kind: 'project',
      id: check.id,
      title: check.title,
      hint: '去完成绑定项目',
      action_label: '去完成',
      module_id: 'project.edit',
      route: `/edit-project?id=${encodeURIComponent(check.id)}`,
    };
  }
  if (check.kind === 'todo') {
    return {
      kind: 'todo',
      id: check.id,
      title: check.title,
      hint: '去完成绑定待办',
      action_label: '去完成',
      module_id: 'task.detail',
      route: `/add-task?standalone=1&id=${encodeURIComponent(check.id)}`,
    };
  }
  return {
    kind: 'task',
    id: check.id,
    title: check.title,
    hint: '去完成绑定任务',
    action_label: '去完成',
    module_id: 'task.detail',
    route: `/task/${encodeURIComponent(check.id)}`,
  };
}

function pointsGapGuide(pointsGap: number): WishBoardGapGuide {
  return {
    kind: 'points',
    id: 'points',
    title: `再攒 ${pointsGap} 分`,
    hint: '去完成任务 / 习惯赚积分',
    action_label: '去赚积分',
    module_id: 'wish.home',
    route: '/wish-board',
  };
}

export type EvaluateWishBoardEligibilityOptions = {
  /** 已取到的心愿行，避免重复查库 */
  item?: WishBoardItemRecord;
  /** 已取到的积分余额 */
  balance?: number;
  /** 已取到的当前净资产 */
  currentNetWorth?: number;
};

/**
 * 只读评估兑换资格与缺口（含净资产门槛；不执行兑换）。
 * Agent「查看兑换资格 / 查看兑换缺口 / 引导补齐缺口」共用此结果。
 */
export async function evaluateWishBoardEligibility(
  wishId: string,
  options: EvaluateWishBoardEligibilityOptions = {},
): Promise<WishBoardEligibilityResult> {
  const id = String(wishId ?? '').trim();
  if (!id) {
    throw new WishBoardError('参数缺失', 400, { ok: false, error: '参数缺失' });
  }

  const item = options.item ?? (await getWishBoardItem(id));
  if (!item) {
    throw new WishBoardError('心愿不存在', 404, { ok: false, error: '心愿不存在' });
  }

  let balance: number;
  let currentNetWorth: number;
  if (options.balance != null && options.currentNetWorth != null) {
    balance = asPoints(options.balance);
    currentNetWorth = options.currentNetWorth;
  } else {
    const { getPointsBalance } = await import('./points.js');
    const { getFinanceNetWorth } = await import('./pages/finance.js');
    const [balanceRes, netWorth] = await Promise.all([
      options.balance != null ? Promise.resolve(null) : getPointsBalance(),
      options.currentNetWorth != null ? Promise.resolve(null) : getFinanceNetWorth(),
    ]);
    balance = options.balance != null ? asPoints(options.balance) : asPoints(balanceRes!.balance);
    currentNetWorth =
      options.currentNetWorth != null ? options.currentNetWorth : (netWorth as number);
  }
  const costPoints = asPoints(item.cost_points);
  const pointsOk = costPoints <= 0 || balance >= costPoints;
  const pointsGap = Math.max(0, costPoints - balance);
  const conditions = parseWishBoardRedeemConditions(item.extra_data);
  const checks: WishBoardEligibilityCheck[] = [];

  if (conditions.project_ids.length > 0) {
    const placeholders = conditions.project_ids.map(() => '?').join(', ');
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT id, name, status FROM projects WHERE id IN (${placeholders})`,
      conditions.project_ids,
    );
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    for (const projectId of conditions.project_ids) {
      const row = byId.get(projectId);
      const done =
        row != null &&
        (row.status === 'done' ||
          row.status === 'cancelled' ||
          row.status === 'completed' ||
          row.status === 'archived');
      checks.push({
        kind: 'project',
        id: projectId,
        title: row?.name != null ? String(row.name).trim() || '未知项目' : '已删除的项目',
        done,
        missing: !row,
      });
    }
  }

  const taskLike: Array<{ kind: 'task' | 'todo'; id: string }> = [
    ...conditions.task_ids.map((tid) => ({ kind: 'task' as const, id: tid })),
    ...conditions.todo_ids.map((tid) => ({ kind: 'todo' as const, id: tid })),
  ];
  if (taskLike.length > 0) {
    const uniqueIds = [...new Set(taskLike.map((t) => t.id))];
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT id, title, status FROM tasks WHERE id IN (${placeholders})`,
      uniqueIds,
    );
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    for (const entry of taskLike) {
      const row = byId.get(entry.id);
      const done = row != null && row.status === 'done';
      const fallback = entry.kind === 'todo' ? '已删除的待办' : '已删除的任务';
      const unknown = entry.kind === 'todo' ? '未知待办' : '未知任务';
      checks.push({
        kind: entry.kind,
        id: entry.id,
        title: row?.title != null ? String(row.title).trim() || unknown : fallback,
        done,
        missing: !row,
      });
    }
  }

  if (conditions.habit_ids.length > 0) {
    const placeholders = conditions.habit_ids.map(() => '?').join(', ');
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT id, name, extra_data FROM habits WHERE id IN (${placeholders})`,
      conditions.habit_ids,
    );
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    for (const habitId of conditions.habit_ids) {
      const row = byId.get(habitId);
      if (!row) {
        checks.push({
          kind: 'habit',
          id: habitId,
          title: '已删除的习惯',
          done: false,
          missing: true,
          habit_kind: null,
        });
        continue;
      }
      const extra = row.extra_data;
      const kind = parseHabitKind(extra);
      const habitKind = kind === 'build' || kind === 'break' ? kind : null;
      const name = row.name != null ? String(row.name).trim() || '未知习惯' : '未知习惯';
      const eligible = isHabitEligibleForWishRedeem(extra);
      const done = eligible && isHabitWishRedeemConditionMet(extra);
      checks.push({
        kind: 'habit',
        id: habitId,
        title: name,
        done,
        missing: false,
        habit_kind: habitKind,
        ineligible: !eligible,
      });
    }
  }

  if (conditions.min_net_worth != null) {
    const done = isNetWorthAtLeast(currentNetWorth, conditions.min_net_worth);
    const needLabel = formatMoneyLabel(conditions.min_net_worth);
    const currentLabel = formatMoneyLabel(currentNetWorth);
    checks.push({
      kind: 'net_worth',
      id: NET_WORTH_CHECK_ID,
      title: `净资产达到 ${needLabel}（当前 ${currentLabel}）`,
      done,
      missing: false,
    });
  }

  if (conditions.available_from != null) {
    checks.push({
      kind: 'available_from',
      id: AVAILABLE_FROM_CHECK_ID,
      title: conditions.available_from,
      done: isAvailableFromMet(conditions.available_from),
      missing: !isAvailableFromMet(conditions.available_from) && !conditions.available_from,
    });
  }

  const pending = checks.filter((c) => !c.done);
  const conditionsOk = pending.length === 0;
  const ok = pointsOk && conditionsOk;
  const guides: WishBoardGapGuide[] = [
    ...pending.map(guideForCheck),
    ...(pointsOk ? [] : [pointsGapGuide(pointsGap)]),
  ];

  return {
    wish_id: item.id,
    title: item.title,
    wish_type: item.wish_type,
    status: item.status,
    ok,
    points_ok: pointsOk,
    conditions_ok: conditionsOk,
    cost_points: costPoints,
    balance,
    points_gap: pointsGap,
    current_net_worth: currentNetWorth,
    conditions,
    checks,
    pending,
    message: ok
      ? null
      : buildEligibilityMessage({ pointsOk, costPoints, balance, pending }),
    guides,
  };
}

/** 仅设置 / 清除兑换条件（写入 extra_data.redeem_conditions） */
export async function updateWishBoardRedeemConditions(
  wishId: string,
  conditions: WishBoardRedeemConditionsInput | null,
  options?: SyncWriteOptions,
): Promise<WishBoardItemRecord> {
  return updateWishBoardItem(
    wishId,
    { redeem_conditions: conditions },
    options,
  );
}
