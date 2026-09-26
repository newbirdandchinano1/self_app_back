import { randomUUID } from 'crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { db } from '../db/index.js';
import { formatDbDateTimeForApi } from './calendar/logical-day.js';
import {
  applyWalletDeltaOnConnection,
  asPoints,
  lockOrCreateWallet,
  nowUtcMysql,
} from './points-wallet.js';

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

    await conn.commit();

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

export interface UpdateWishBoardItemInput {
  title?: string | null;
  description?: string | null;
  cost_points?: number | null;
  note?: string | null;
  icon_key?: string | null;
  wish_type?: string | null;
  sort_order?: number | null;
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

/**
 * 更新心愿元数据（标题/积分/图标等）。
 * 禁止经此接口改 status / redeemed_at（兑换须走 redeem）。
 * 已兑换的 once 心愿不可再改名称、积分、兑换条件。
 */
export async function updateWishBoardItem(
  wishId: string,
  input: UpdateWishBoardItemInput,
): Promise<WishBoardItemRecord> {
  const id = String(wishId ?? '').trim();
  if (!id) {
    throw new WishBoardError('参数缺失', 400, { ok: false, error: '参数缺失' });
  }

  const existing = await getWishBoardItem(id);
  if (!existing) {
    throw new WishBoardError('心愿不存在', 404, { ok: false, error: '心愿不存在' });
  }

  const patchingCore =
    input.title != null ||
    input.cost_points != null ||
    Object.prototype.hasOwnProperty.call(input, 'extra_data');
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
    description = normalizeOptionalText(input.description, 'description', 500);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'note')) {
    note = normalizeOptionalText(input.note, 'note', 500);
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

  let extraData: string | null =
    existing.extra_data == null
      ? null
      : typeof existing.extra_data === 'string'
        ? existing.extra_data
        : JSON.stringify(existing.extra_data);
  if (Object.prototype.hasOwnProperty.call(input, 'extra_data')) {
    extraData = serializeWishBoardExtraData(input.extra_data);
  }

  const now = nowUtcMysql();
  await db.query(
    `UPDATE wish_board_items SET
       title = ?, description = ?, cost_points = ?, note = ?, icon_key = ?, wish_type = ?,
       sort_order = ?, extra_data = ?, updated_at = ?, sync_status = 'synced'
     WHERE id = ?`,
    [title, description, costPoints, note, iconKey, wishType, sortOrder, extraData, now, id],
  );

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
