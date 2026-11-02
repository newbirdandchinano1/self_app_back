import { randomUUID } from 'crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { db } from '../db/index.js';
import { WARDROBE_DEFAULT_CLOSET_ID } from '../db/ensure-wardrobe.js';
import { isValidYmd, addDaysToYmd as addDaysLocal } from '../utils/ymd.js';
import {
  addDaysToYmd,
  formatDbDateTimeForApi,
  formatLocalYmdFromDate,
  formatRecordDateTimesForApi,
  formatUtcMySQLDateTime,
} from './calendar/logical-day.js';
import {
  appendChangeLog,
  discardPendingSyncPublish,
  flushPendingSyncPublish,
  withSyncTransaction,
  type ChangeLogEvent,
  type SyncWriteOptions,
} from './sync-change-log.js';
import { deleteLiveWithRevision, stampLiveUpsert, throwTombstoneConflict } from './sync-revision.js';

export class WardrobeError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'WardrobeError';
  }
}

/** 软删口径：sync_status = pending_delete */
const ACTIVE_SQL = `(sync_status IS NULL OR sync_status != 'pending_delete')`;

const UNCATEGORIZED_CATEGORY_ID = 'wcat_uncategorized';

const ITEM_STATUSES = new Set(['active', 'archived', 'disposed']);
const OUTFIT_STATUSES = new Set(['active', 'archived']);

const CLOSET_COLS = `id, name, sort_order, is_default, note, created_at, updated_at, sync_status, server_rev, mutation_id`;
const CATEGORY_COLS = `id, closet_id, name, sort_order, tint, tint2, tone, is_builtin, created_at, updated_at, sync_status, server_rev, mutation_id`;
const OCCASION_COLS = `id, name, sort_order, is_builtin, created_at, updated_at, sync_status, server_rev, mutation_id`;
const ITEM_COLS = `id, closet_id, category_id, name, brand, color, season, price_cents, currency,
  fit, warmth, sku_code, art_key, tint, tint2, line, tags_json, image_uri, cutout_uri,
  purchased_on, status, wear_count, last_worn_on, note, extra_data,
  created_at, updated_at, sync_status, server_rev, mutation_id`;
const OUTFIT_COLS = `id, closet_id, name, occasion_id, note, cover_item_id, wear_count, last_worn_on,
  status, created_at, updated_at, sync_status, server_rev, mutation_id`;
const OUTFIT_ITEM_COLS = `id, outfit_id, item_id, sort_order, created_at, updated_at, sync_status, server_rev, mutation_id`;
const WEAR_LOG_COLS = `id, closet_id, worn_on, source, item_id, outfit_id, note,
  created_at, updated_at, sync_status, server_rev, mutation_id`;

type ClosetRow = {
  id: string;
  name: string;
  sort_order: number;
  is_default: number;
  note: string | null;
  created_at: string;
  updated_at: string;
  sync_status: string;
  server_rev?: number;
  mutation_id?: string | null;
};

type CategoryRow = {
  id: string;
  closet_id: string;
  name: string;
  sort_order: number;
  tint: string | null;
  tint2: string | null;
  tone: string | null;
  is_builtin: number;
  created_at: string;
  updated_at: string;
  sync_status: string;
  server_rev?: number;
  mutation_id?: string | null;
};

type OccasionRow = {
  id: string;
  name: string;
  sort_order: number;
  is_builtin: number;
  created_at: string;
  updated_at: string;
  sync_status: string;
  server_rev?: number;
  mutation_id?: string | null;
};

type ItemRow = {
  id: string;
  closet_id: string;
  category_id: string;
  name: string;
  brand: string | null;
  color: string | null;
  season: string | null;
  price_cents: number | null;
  currency: string;
  fit: string | null;
  warmth: string | null;
  sku_code: string | null;
  art_key: string | null;
  tint: string | null;
  tint2: string | null;
  line: string | null;
  tags_json: string | null;
  image_uri: string | null;
  cutout_uri: string | null;
  purchased_on: string | null;
  status: string;
  wear_count: number;
  last_worn_on: string | null;
  note: string | null;
  extra_data: string | null;
  created_at: string;
  updated_at: string;
  sync_status: string;
  server_rev?: number;
  mutation_id?: string | null;
};

type OutfitRow = {
  id: string;
  closet_id: string;
  name: string;
  occasion_id: string | null;
  note: string | null;
  cover_item_id: string | null;
  wear_count: number;
  last_worn_on: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  sync_status: string;
  server_rev?: number;
  mutation_id?: string | null;
};

type OutfitItemRow = {
  id: string;
  outfit_id: string;
  item_id: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  sync_status: string;
  server_rev?: number;
  mutation_id?: string | null;
};

type WearLogRow = {
  id: string;
  closet_id: string;
  worn_on: string;
  source: string;
  item_id: string | null;
  outfit_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  sync_status: string;
  server_rev?: number;
  mutation_id?: string | null;
};

function nowUtcMysql(): string {
  return formatUtcMySQLDateTime(new Date());
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asOptionalString(value: unknown): string | null {
  if (value == null) return null;
  const s = asTrimmedString(value);
  return s || null;
}

function asInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function asOptionalInt(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function parseJsonField(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return raw;
  }
}

function tagsToJsonText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      throw new WardrobeError('tags_json 必须是合法 JSON');
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    throw new WardrobeError('tags_json 无法序列化');
  }
}

function normalizeWornOn(raw: unknown): string {
  if (raw == null || raw === '') return formatLocalYmdFromDate(new Date());
  const s = asTrimmedString(raw);
  if (!isValidYmd(s)) throw new WardrobeError('worn_on 须为 YYYY-MM-DD');
  return s;
}

function mondayOf(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00`);
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  return addDaysLocal(ymd, diff);
}

function pushEvent(
  events: ChangeLogEvent[],
  tableName: string,
  recordPk: string,
  op: 'upsert' | 'delete',
  updatedAt: string,
  options: SyncWriteOptions | undefined,
  stamp: { serverRev: number; mutationId: string | null },
) {
  events.push({
    tableName,
    recordPk,
    op,
    updatedAt,
    deviceId: options?.deviceId,
    serverRev: stamp.serverRev,
    mutationId: stamp.mutationId,
  });
}

function formatCloset(row: ClosetRow) {
  return formatRecordDateTimesForApi(
    {
      id: row.id,
      name: row.name,
      sort_order: Number(row.sort_order) || 0,
      is_default: Number(row.is_default) ? 1 : 0,
      note: row.note,
      created_at: row.created_at,
      updated_at: row.updated_at,
      sync_status: row.sync_status,
      server_rev: row.server_rev ?? 1,
      mutation_id: row.mutation_id ?? null,
      version: 1,
    },
    'wardrobe_closets',
  );
}

function formatCategory(row: CategoryRow) {
  return formatRecordDateTimesForApi(
    {
      id: row.id,
      closet_id: row.closet_id,
      name: row.name,
      sort_order: Number(row.sort_order) || 0,
      tint: row.tint,
      tint2: row.tint2,
      tone: row.tone,
      is_builtin: Number(row.is_builtin) ? 1 : 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
      sync_status: row.sync_status,
      server_rev: row.server_rev ?? 1,
      mutation_id: row.mutation_id ?? null,
      version: 1,
    },
    'wardrobe_categories',
  );
}

function formatOccasion(row: OccasionRow) {
  return formatRecordDateTimesForApi(
    {
      id: row.id,
      name: row.name,
      sort_order: Number(row.sort_order) || 0,
      is_builtin: Number(row.is_builtin) ? 1 : 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
      sync_status: row.sync_status,
      server_rev: row.server_rev ?? 1,
      mutation_id: row.mutation_id ?? null,
      version: 1,
    },
    'wardrobe_occasions',
  );
}

function formatItem(row: ItemRow, { parseJson = true }: { parseJson?: boolean } = {}) {
  return formatRecordDateTimesForApi(
    {
      id: row.id,
      closet_id: row.closet_id,
      category_id: row.category_id,
      name: row.name,
      brand: row.brand,
      color: row.color,
      season: row.season,
      price_cents: row.price_cents == null ? null : Number(row.price_cents),
      currency: row.currency || 'CNY',
      fit: row.fit,
      warmth: row.warmth,
      sku_code: row.sku_code,
      art_key: row.art_key,
      tint: row.tint,
      tint2: row.tint2,
      line: row.line,
      tags_json: parseJson ? parseJsonField(row.tags_json) : row.tags_json,
      image_uri: row.image_uri,
      cutout_uri: row.cutout_uri,
      purchased_on: row.purchased_on,
      status: row.status,
      wear_count: Number(row.wear_count) || 0,
      last_worn_on: row.last_worn_on,
      note: row.note,
      extra_data: parseJson ? parseJsonField(row.extra_data) : row.extra_data,
      created_at: row.created_at,
      updated_at: row.updated_at,
      sync_status: row.sync_status,
      server_rev: row.server_rev ?? 1,
      mutation_id: row.mutation_id ?? null,
      version: 1,
    },
    'wardrobe_items',
  );
}

function formatOutfit(row: OutfitRow) {
  return formatRecordDateTimesForApi(
    {
      id: row.id,
      closet_id: row.closet_id,
      name: row.name,
      occasion_id: row.occasion_id,
      note: row.note,
      cover_item_id: row.cover_item_id,
      wear_count: Number(row.wear_count) || 0,
      last_worn_on: row.last_worn_on,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      sync_status: row.sync_status,
      server_rev: row.server_rev ?? 1,
      mutation_id: row.mutation_id ?? null,
      version: 1,
    },
    'wardrobe_outfits',
  );
}

function formatOutfitItem(row: OutfitItemRow) {
  return formatRecordDateTimesForApi(
    {
      id: row.id,
      outfit_id: row.outfit_id,
      item_id: row.item_id,
      sort_order: Number(row.sort_order) || 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
      sync_status: row.sync_status,
      server_rev: row.server_rev ?? 1,
      mutation_id: row.mutation_id ?? null,
      version: 1,
    },
    'wardrobe_outfit_items',
  );
}

function formatWearLog(row: WearLogRow) {
  return formatRecordDateTimesForApi(
    {
      id: row.id,
      closet_id: row.closet_id,
      worn_on: row.worn_on,
      source: row.source,
      item_id: row.item_id,
      outfit_id: row.outfit_id,
      note: row.note,
      created_at: row.created_at,
      updated_at: row.updated_at,
      sync_status: row.sync_status,
      server_rev: row.server_rev ?? 1,
      mutation_id: row.mutation_id ?? null,
      version: 1,
    },
    'wardrobe_wear_logs',
  );
}

async function getActiveCloset(id: string): Promise<ClosetRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${CLOSET_COLS} FROM wardrobe_closets WHERE id = ? AND ${ACTIVE_SQL} LIMIT 1`,
    [id],
  );
  return (rows[0] as ClosetRow | undefined) ?? null;
}

async function getActiveCategory(id: string): Promise<CategoryRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${CATEGORY_COLS} FROM wardrobe_categories WHERE id = ? AND ${ACTIVE_SQL} LIMIT 1`,
    [id],
  );
  return (rows[0] as CategoryRow | undefined) ?? null;
}

async function getActiveOccasion(id: string): Promise<OccasionRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${OCCASION_COLS} FROM wardrobe_occasions WHERE id = ? AND ${ACTIVE_SQL} LIMIT 1`,
    [id],
  );
  return (rows[0] as OccasionRow | undefined) ?? null;
}

async function getActiveItem(id: string): Promise<ItemRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${ITEM_COLS} FROM wardrobe_items WHERE id = ? AND ${ACTIVE_SQL} LIMIT 1`,
    [id],
  );
  return (rows[0] as ItemRow | undefined) ?? null;
}

async function getActiveOutfit(id: string): Promise<OutfitRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${OUTFIT_COLS} FROM wardrobe_outfits WHERE id = ? AND ${ACTIVE_SQL} LIMIT 1`,
    [id],
  );
  return (rows[0] as OutfitRow | undefined) ?? null;
}

async function getActiveWearLog(id: string): Promise<WearLogRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${WEAR_LOG_COLS} FROM wardrobe_wear_logs WHERE id = ? AND ${ACTIVE_SQL} LIMIT 1`,
    [id],
  );
  return (rows[0] as WearLogRow | undefined) ?? null;
}

async function resolveDefaultClosetId(closetIdRaw?: unknown): Promise<string> {
  const id = asTrimmedString(closetIdRaw);
  if (id) {
    const closet = await getActiveCloset(id);
    if (!closet) throw new WardrobeError('衣橱不存在', 404);
    return closet.id;
  }
  const preferred = await getActiveCloset(WARDROBE_DEFAULT_CLOSET_ID);
  if (preferred) return preferred.id;
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id FROM wardrobe_closets
     WHERE ${ACTIVE_SQL}
     ORDER BY is_default DESC, sort_order ASC, created_at ASC
     LIMIT 1`,
  );
  const fallback = rows[0]?.id ? String(rows[0].id) : '';
  if (!fallback) throw new WardrobeError('尚无可用衣橱，请先创建', 404);
  return fallback;
}

// —— Closets ——

export async function listClosets() {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${CLOSET_COLS} FROM wardrobe_closets
     WHERE ${ACTIVE_SQL}
     ORDER BY sort_order ASC, created_at ASC, id ASC`,
  );
  return (rows as ClosetRow[]).map(formatCloset);
}

export async function createCloset(
  input: { id?: unknown; name: unknown; sort_order?: unknown; is_default?: unknown; note?: unknown },
  options?: SyncWriteOptions,
) {
  const name = asTrimmedString(input.name);
  if (!name) throw new WardrobeError('name 不能为空');
  const id = asTrimmedString(input.id) || randomUUID();
  const sortOrder = asInt(input.sort_order, 1000);
  const isDefault = input.is_default ? 1 : 0;
  const note = asOptionalString(input.note);
  const now = nowUtcMysql();

  try {
    await withSyncTransaction(async (conn) => {
      if (isDefault) {
        await conn.query(
          `UPDATE wardrobe_closets SET is_default = 0, updated_at = ?
           WHERE is_default = 1 AND ${ACTIVE_SQL}`,
          [now],
        );
      }
      await conn.query(
        `INSERT INTO wardrobe_closets
           (id, name, sort_order, is_default, note, created_at, updated_at, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'synced')`,
        [id, name, sortOrder, isDefault, note, now, now],
      );
      const stamp = await stampLiveUpsert(conn, 'wardrobe_closets', id, {
        mode: 'insert',
        mutationId: options?.mutationId,
      });
      await appendChangeLog(conn, [
        {
          tableName: 'wardrobe_closets',
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
      throw new WardrobeError('衣橱已存在', 409);
    }
    throw err;
  }

  const created = await getActiveCloset(id);
  if (!created) throw new WardrobeError('创建衣橱失败', 500);
  return formatCloset(created);
}

export async function updateCloset(
  closetId: string,
  input: { name?: unknown; sort_order?: unknown; is_default?: unknown; note?: unknown },
  options?: SyncWriteOptions,
) {
  const id = closetId.trim();
  if (!id) throw new WardrobeError('id 不能为空');
  const existing = await getActiveCloset(id);
  if (!existing) throw await throwTombstoneConflict(db, 'wardrobe_closets', id);

  const updates: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) {
    const name = asTrimmedString(input.name);
    if (!name) throw new WardrobeError('name 不能为空');
    updates.push('name = ?');
    values.push(name);
  }
  if (input.sort_order !== undefined) {
    updates.push('sort_order = ?');
    values.push(asInt(input.sort_order, existing.sort_order));
  }
  if (input.note !== undefined) {
    updates.push('note = ?');
    values.push(asOptionalString(input.note));
  }
  const setDefault = input.is_default !== undefined ? (input.is_default ? 1 : 0) : null;
  if (setDefault !== null) {
    updates.push('is_default = ?');
    values.push(setDefault);
  }
  if (updates.length === 0) throw new WardrobeError('没有可更新的字段');

  const now = nowUtcMysql();
  updates.push(`updated_at = ?`, `sync_status = 'synced'`);
  values.push(now, id);

  await withSyncTransaction(async (conn) => {
    if (setDefault === 1) {
      await conn.query(
        `UPDATE wardrobe_closets SET is_default = 0, updated_at = ?
         WHERE id != ? AND is_default = 1 AND ${ACTIVE_SQL}`,
        [now, id],
      );
    }
    const [result] = await conn.query<ResultSetHeader>(
      `UPDATE wardrobe_closets SET ${updates.join(', ')} WHERE id = ? AND ${ACTIVE_SQL}`,
      values,
    );
    if (result.affectedRows === 0) throw new WardrobeError('衣橱不存在', 404);
    const stamp = await stampLiveUpsert(conn, 'wardrobe_closets', id, {
      mode: 'update',
      mutationId: options?.mutationId,
      expectedRev: options?.expectedRev,
    });
    await appendChangeLog(conn, [
      {
        tableName: 'wardrobe_closets',
        recordPk: id,
        op: 'upsert',
        updatedAt: now,
        deviceId: options?.deviceId,
        serverRev: stamp.serverRev,
        mutationId: stamp.mutationId,
      },
    ]);
  });

  const updated = await getActiveCloset(id);
  if (!updated) throw new WardrobeError('衣橱不存在', 404);
  return formatCloset(updated);
}

export async function deleteCloset(closetId: string, options?: SyncWriteOptions) {
  const id = closetId.trim();
  if (!id) throw new WardrobeError('id 不能为空');
  const existing = await getActiveCloset(id);
  if (!existing) {
    return { id, deleted_at: formatDbDateTimeForApi(nowUtcMysql(), 'utc') ?? nowUtcMysql() };
  }

  const [countRows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM wardrobe_closets WHERE ${ACTIVE_SQL}`,
  );
  if (Number(countRows[0]?.c ?? 0) <= 1) {
    throw new WardrobeError('不能删除最后一个衣橱');
  }

  const now = nowUtcMysql();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const events: ChangeLogEvent[] = [];

    const softDeleteIds = async (table: string, ids: string[]) => {
      for (const pk of ids) {
        const del = await deleteLiveWithRevision(conn, table, pk, { skipOcc: true });
        if (del.kind === 'deleted') {
          pushEvent(events, table, pk, 'delete', now, options, del);
        }
      }
    };

    const [outfitRows] = await conn.query<RowDataPacket[]>(
      `SELECT id FROM wardrobe_outfits WHERE closet_id = ? AND ${ACTIVE_SQL}`,
      [id],
    );
    const outfitIds = outfitRows.map((r) => String(r.id));
    if (outfitIds.length) {
      const placeholders = outfitIds.map(() => '?').join(',');
      const [linkRows] = await conn.query<RowDataPacket[]>(
        `SELECT id FROM wardrobe_outfit_items
         WHERE outfit_id IN (${placeholders}) AND ${ACTIVE_SQL}`,
        outfitIds,
      );
      await softDeleteIds(
        'wardrobe_outfit_items',
        linkRows.map((r) => String(r.id)),
      );
      await softDeleteIds('wardrobe_outfits', outfitIds);
    }

    const [itemRows] = await conn.query<RowDataPacket[]>(
      `SELECT id FROM wardrobe_items WHERE closet_id = ? AND ${ACTIVE_SQL}`,
      [id],
    );
    await softDeleteIds(
      'wardrobe_items',
      itemRows.map((r) => String(r.id)),
    );

    const [catRows] = await conn.query<RowDataPacket[]>(
      `SELECT id FROM wardrobe_categories WHERE closet_id = ? AND ${ACTIVE_SQL}`,
      [id],
    );
    await softDeleteIds(
      'wardrobe_categories',
      catRows.map((r) => String(r.id)),
    );

    const [wearRows] = await conn.query<RowDataPacket[]>(
      `SELECT id FROM wardrobe_wear_logs WHERE closet_id = ? AND ${ACTIVE_SQL}`,
      [id],
    );
    await softDeleteIds(
      'wardrobe_wear_logs',
      wearRows.map((r) => String(r.id)),
    );

    const closetDel = await deleteLiveWithRevision(conn, 'wardrobe_closets', id, {
      mutationId: options?.mutationId,
      expectedRev: options?.expectedRev,
    });
    if (closetDel.kind === 'deleted') {
      events.unshift({
        tableName: 'wardrobe_closets',
        recordPk: id,
        op: 'delete',
        updatedAt: now,
        deviceId: options?.deviceId,
        serverRev: closetDel.serverRev,
        mutationId: closetDel.mutationId,
      });
    }

    if (events.length) await appendChangeLog(conn, events);
    await conn.commit();
    await flushPendingSyncPublish(conn);
    return { id, deleted_at: formatDbDateTimeForApi(now, 'utc') ?? now };
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

// —— Categories ——

export async function listCategories(closetIdRaw?: unknown) {
  const closetId = await resolveDefaultClosetId(closetIdRaw);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${CATEGORY_COLS} FROM wardrobe_categories
     WHERE closet_id = ? AND ${ACTIVE_SQL}
     ORDER BY sort_order ASC, created_at ASC, id ASC`,
    [closetId],
  );
  return (rows as CategoryRow[]).map(formatCategory);
}

export async function listCategoriesWithItems(closetIdRaw?: unknown) {
  const closetId = await resolveDefaultClosetId(closetIdRaw);
  const categories = await listCategories(closetId);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${ITEM_COLS} FROM wardrobe_items
     WHERE closet_id = ? AND ${ACTIVE_SQL} AND status = 'active'
     ORDER BY updated_at DESC, created_at DESC, id ASC`,
    [closetId],
  );
  const items = (rows as ItemRow[]).map((r) => formatItem(r));
  const byCat = new Map<string, ReturnType<typeof formatItem>[]>();
  for (const item of items) {
    const cid = String((item as { category_id: string }).category_id);
    const list = byCat.get(cid) ?? [];
    list.push(item);
    byCat.set(cid, list);
  }
  return categories.map((category) => ({
    category,
    items: byCat.get(String((category as { id: string }).id)) ?? [],
  }));
}

export async function createCategory(
  input: {
    id?: unknown;
    closet_id?: unknown;
    name: unknown;
    sort_order?: unknown;
    tint?: unknown;
    tint2?: unknown;
    tone?: unknown;
  },
  options?: SyncWriteOptions,
) {
  const name = asTrimmedString(input.name);
  if (!name) throw new WardrobeError('name 不能为空');
  const closetId = await resolveDefaultClosetId(input.closet_id);
  const id = asTrimmedString(input.id) || randomUUID();
  const now = nowUtcMysql();

  try {
    await withSyncTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO wardrobe_categories
           (id, closet_id, name, sort_order, tint, tint2, tone, is_builtin,
            created_at, updated_at, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'synced')`,
        [
          id,
          closetId,
          name,
          asInt(input.sort_order, 1000),
          asOptionalString(input.tint),
          asOptionalString(input.tint2),
          asOptionalString(input.tone),
          now,
          now,
        ],
      );
      const stamp = await stampLiveUpsert(conn, 'wardrobe_categories', id, {
        mode: 'insert',
        mutationId: options?.mutationId,
      });
      await appendChangeLog(conn, [
        {
          tableName: 'wardrobe_categories',
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
      throw new WardrobeError('分类已存在', 409);
    }
    throw err;
  }

  const created = await getActiveCategory(id);
  if (!created) throw new WardrobeError('创建分类失败', 500);
  return formatCategory(created);
}

export async function updateCategory(
  categoryId: string,
  input: {
    name?: unknown;
    sort_order?: unknown;
    tint?: unknown;
    tint2?: unknown;
    tone?: unknown;
  },
  options?: SyncWriteOptions,
) {
  const id = categoryId.trim();
  if (!id) throw new WardrobeError('id 不能为空');
  const existing = await getActiveCategory(id);
  if (!existing) throw await throwTombstoneConflict(db, 'wardrobe_categories', id);

  const updates: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) {
    const name = asTrimmedString(input.name);
    if (!name) throw new WardrobeError('name 不能为空');
    updates.push('name = ?');
    values.push(name);
  }
  if (input.sort_order !== undefined) {
    updates.push('sort_order = ?');
    values.push(asInt(input.sort_order, existing.sort_order));
  }
  if (input.tint !== undefined) {
    updates.push('tint = ?');
    values.push(asOptionalString(input.tint));
  }
  if (input.tint2 !== undefined) {
    updates.push('tint2 = ?');
    values.push(asOptionalString(input.tint2));
  }
  if (input.tone !== undefined) {
    updates.push('tone = ?');
    values.push(asOptionalString(input.tone));
  }
  if (updates.length === 0) throw new WardrobeError('没有可更新的字段');

  const now = nowUtcMysql();
  updates.push(`updated_at = ?`, `sync_status = 'synced'`);
  values.push(now, id);

  await withSyncTransaction(async (conn) => {
    const [result] = await conn.query<ResultSetHeader>(
      `UPDATE wardrobe_categories SET ${updates.join(', ')} WHERE id = ? AND ${ACTIVE_SQL}`,
      values,
    );
    if (result.affectedRows === 0) throw new WardrobeError('分类不存在', 404);
    const stamp = await stampLiveUpsert(conn, 'wardrobe_categories', id, {
      mode: 'update',
      mutationId: options?.mutationId,
      expectedRev: options?.expectedRev,
    });
    await appendChangeLog(conn, [
      {
        tableName: 'wardrobe_categories',
        recordPk: id,
        op: 'upsert',
        updatedAt: now,
        deviceId: options?.deviceId,
        serverRev: stamp.serverRev,
        mutationId: stamp.mutationId,
      },
    ]);
  });

  const updated = await getActiveCategory(id);
  if (!updated) throw new WardrobeError('分类不存在', 404);
  return formatCategory(updated);
}

/** 删除分类：单品迁入「未分类」；禁止删内置未分类 */
export async function deleteCategory(categoryId: string, options?: SyncWriteOptions) {
  const id = categoryId.trim();
  if (!id) throw new WardrobeError('id 不能为空');
  if (id === UNCATEGORIZED_CATEGORY_ID) {
    throw new WardrobeError('不能删除「未分类」');
  }
  const existing = await getActiveCategory(id);
  if (!existing) {
    return { id, deleted_at: formatDbDateTimeForApi(nowUtcMysql(), 'utc') ?? nowUtcMysql() };
  }

  const uncategorized = await getActiveCategory(UNCATEGORIZED_CATEGORY_ID);
  if (!uncategorized) throw new WardrobeError('未分类不存在，无法迁移单品', 500);

  const now = nowUtcMysql();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const events: ChangeLogEvent[] = [];

    const [itemRows] = await conn.query<RowDataPacket[]>(
      `SELECT id FROM wardrobe_items WHERE category_id = ? AND ${ACTIVE_SQL}`,
      [id],
    );
    for (const row of itemRows) {
      const itemId = String(row.id);
      await conn.query(
        `UPDATE wardrobe_items
         SET category_id = ?, updated_at = ?, sync_status = 'synced'
         WHERE id = ? AND ${ACTIVE_SQL}`,
        [UNCATEGORIZED_CATEGORY_ID, now, itemId],
      );
      const stamp = await stampLiveUpsert(conn, 'wardrobe_items', itemId, {
        mode: 'update',
        skipOcc: true,
      });
      pushEvent(events, 'wardrobe_items', itemId, 'upsert', now, options, stamp);
    }

    const del = await deleteLiveWithRevision(conn, 'wardrobe_categories', id, {
      mutationId: options?.mutationId,
      expectedRev: options?.expectedRev,
    });
    if (del.kind === 'deleted') {
      events.unshift({
        tableName: 'wardrobe_categories',
        recordPk: id,
        op: 'delete',
        updatedAt: now,
        deviceId: options?.deviceId,
        serverRev: del.serverRev,
        mutationId: del.mutationId,
      });
    }
    if (events.length) await appendChangeLog(conn, events);
    await conn.commit();
    await flushPendingSyncPublish(conn);
    return { id, deleted_at: formatDbDateTimeForApi(now, 'utc') ?? now };
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

// —— Items ——

export type ListItemsQuery = {
  closet_id?: unknown;
  category_id?: unknown;
  season?: unknown;
  status?: unknown;
  updatedSince?: unknown;
  limit?: unknown;
  offset?: unknown;
};

export async function listItems(query: ListItemsQuery = {}) {
  const closetId = await resolveDefaultClosetId(query.closet_id);
  const where = [`closet_id = ?`, ACTIVE_SQL];
  const values: unknown[] = [closetId];

  const categoryId = asTrimmedString(query.category_id);
  if (categoryId) {
    where.push('category_id = ?');
    values.push(categoryId);
  }
  const season = asTrimmedString(query.season);
  if (season) {
    where.push('season = ?');
    values.push(season);
  }
  const status = asTrimmedString(query.status);
  if (status) {
    if (!ITEM_STATUSES.has(status)) throw new WardrobeError('status 无效');
    where.push('status = ?');
    values.push(status);
  }
  const updatedSince = asTrimmedString(query.updatedSince);
  if (updatedSince) {
    where.push('updated_at >= ?');
    values.push(updatedSince);
  }

  const limit = Math.min(Math.max(asInt(query.limit, 200), 1), 500);
  const offset = Math.max(asInt(query.offset, 0), 0);

  const [countRows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM wardrobe_items WHERE ${where.join(' AND ')}`,
    values,
  );
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${ITEM_COLS} FROM wardrobe_items
     WHERE ${where.join(' AND ')}
     ORDER BY updated_at DESC, created_at DESC, id ASC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset],
  );

  return {
    total: Number(countRows[0]?.c ?? 0),
    limit,
    offset,
    items: (rows as ItemRow[]).map((r) => formatItem(r)),
  };
}

export async function countItems(closetIdRaw?: unknown, statusRaw?: unknown) {
  const closetId = await resolveDefaultClosetId(closetIdRaw);
  const status = asTrimmedString(statusRaw);
  const where = [`closet_id = ?`, ACTIVE_SQL];
  const values: unknown[] = [closetId];
  if (status) {
    if (!ITEM_STATUSES.has(status)) throw new WardrobeError('status 无效');
    where.push('status = ?');
    values.push(status);
  }
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM wardrobe_items WHERE ${where.join(' AND ')}`,
    values,
  );
  return { count: Number(rows[0]?.c ?? 0) };
}

export async function getItemDetail(itemId: string, includeHistory = true) {
  const id = itemId.trim();
  if (!id) throw new WardrobeError('id 不能为空');
  const item = await getActiveItem(id);
  if (!item) throw new WardrobeError('单品不存在', 404);

  const category = await getActiveCategory(item.category_id);
  const result: Record<string, unknown> = {
    ...formatItem(item),
    category: category ? formatCategory(category) : null,
  };
  if (includeHistory) {
    result.wear_history_28d = await getItemWearHistory(id, 28);
  }
  return result;
}

export type CreateItemInput = {
  id?: unknown;
  closet_id?: unknown;
  category_id: unknown;
  name: unknown;
  brand?: unknown;
  color?: unknown;
  season?: unknown;
  price_cents?: unknown;
  currency?: unknown;
  fit?: unknown;
  warmth?: unknown;
  sku_code?: unknown;
  art_key?: unknown;
  tint?: unknown;
  tint2?: unknown;
  line?: unknown;
  tags_json?: unknown;
  image_uri?: unknown;
  cutout_uri?: unknown;
  purchased_on?: unknown;
  status?: unknown;
  note?: unknown;
  extra_data?: unknown;
};

export async function createItem(input: CreateItemInput, options?: SyncWriteOptions) {
  const name = asTrimmedString(input.name);
  if (!name) throw new WardrobeError('name 不能为空');
  const categoryId = asTrimmedString(input.category_id) || UNCATEGORIZED_CATEGORY_ID;
  const category = await getActiveCategory(categoryId);
  if (!category) throw new WardrobeError('分类不存在', 404);

  const closetId = await resolveDefaultClosetId(input.closet_id ?? category.closet_id);
  if (category.closet_id !== closetId) {
    throw new WardrobeError('分类不属于该衣橱');
  }

  const status = asTrimmedString(input.status) || 'active';
  if (!ITEM_STATUSES.has(status)) throw new WardrobeError('status 无效');

  const id = asTrimmedString(input.id) || randomUUID();
  const now = nowUtcMysql();
  const tagsJson = tagsToJsonText(input.tags_json);
  const extraData =
    input.extra_data == null
      ? null
      : typeof input.extra_data === 'string'
        ? asOptionalString(input.extra_data)
        : JSON.stringify(input.extra_data);

  try {
    await withSyncTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO wardrobe_items
           (id, closet_id, category_id, name, brand, color, season, price_cents, currency,
            fit, warmth, sku_code, art_key, tint, tint2, line, tags_json, image_uri, cutout_uri,
            purchased_on, status, wear_count, last_worn_on, note, extra_data,
            created_at, updated_at, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, 'synced')`,
        [
          id,
          closetId,
          categoryId,
          name,
          asOptionalString(input.brand),
          asOptionalString(input.color),
          asOptionalString(input.season),
          asOptionalInt(input.price_cents),
          asTrimmedString(input.currency) || 'CNY',
          asOptionalString(input.fit),
          asOptionalString(input.warmth),
          asOptionalString(input.sku_code),
          asOptionalString(input.art_key),
          asOptionalString(input.tint),
          asOptionalString(input.tint2),
          asOptionalString(input.line),
          tagsJson,
          asOptionalString(input.image_uri),
          asOptionalString(input.cutout_uri),
          asOptionalString(input.purchased_on),
          status,
          asOptionalString(input.note),
          extraData,
          now,
          now,
        ],
      );
      const stamp = await stampLiveUpsert(conn, 'wardrobe_items', id, {
        mode: 'insert',
        mutationId: options?.mutationId,
      });
      await appendChangeLog(conn, [
        {
          tableName: 'wardrobe_items',
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
      throw new WardrobeError('单品已存在', 409);
    }
    throw err;
  }

  const created = await getActiveItem(id);
  if (!created) throw new WardrobeError('创建单品失败', 500);
  return formatItem(created);
}

export type UpdateItemInput = Partial<CreateItemInput>;

export async function updateItem(
  itemId: string,
  input: UpdateItemInput,
  options?: SyncWriteOptions,
) {
  const id = itemId.trim();
  if (!id) throw new WardrobeError('id 不能为空');
  const existing = await getActiveItem(id);
  if (!existing) throw await throwTombstoneConflict(db, 'wardrobe_items', id);

  const updates: string[] = [];
  const values: unknown[] = [];

  if (input.category_id !== undefined) {
    const categoryId = asTrimmedString(input.category_id);
    if (!categoryId) throw new WardrobeError('category_id 不能为空');
    const category = await getActiveCategory(categoryId);
    if (!category) throw new WardrobeError('分类不存在', 404);
    if (category.closet_id !== existing.closet_id) {
      throw new WardrobeError('分类不属于该衣橱');
    }
    updates.push('category_id = ?');
    values.push(categoryId);
  }
  if (input.closet_id !== undefined) {
    const closetId = asTrimmedString(input.closet_id);
    if (!closetId) throw new WardrobeError('closet_id 不能为空');
    const closet = await getActiveCloset(closetId);
    if (!closet) throw new WardrobeError('衣橱不存在', 404);
    updates.push('closet_id = ?');
    values.push(closetId);
  }
  if (input.name !== undefined) {
    const name = asTrimmedString(input.name);
    if (!name) throw new WardrobeError('name 不能为空');
    updates.push('name = ?');
    values.push(name);
  }
  const stringFields = [
    'brand',
    'color',
    'season',
    'fit',
    'warmth',
    'sku_code',
    'art_key',
    'tint',
    'tint2',
    'line',
    'image_uri',
    'cutout_uri',
    'purchased_on',
    'note',
  ] as const;
  for (const key of stringFields) {
    if (input[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(asOptionalString(input[key]));
    }
  }
  if (input.price_cents !== undefined) {
    updates.push('price_cents = ?');
    values.push(asOptionalInt(input.price_cents));
  }
  if (input.currency !== undefined) {
    updates.push('currency = ?');
    values.push(asTrimmedString(input.currency) || 'CNY');
  }
  if (input.tags_json !== undefined) {
    updates.push('tags_json = ?');
    values.push(tagsToJsonText(input.tags_json));
  }
  if (input.extra_data !== undefined) {
    updates.push('extra_data = ?');
    values.push(
      input.extra_data == null
        ? null
        : typeof input.extra_data === 'string'
          ? asOptionalString(input.extra_data)
          : JSON.stringify(input.extra_data),
    );
  }
  if (input.status !== undefined) {
    const status = asTrimmedString(input.status);
    if (!ITEM_STATUSES.has(status)) throw new WardrobeError('status 无效');
    updates.push('status = ?');
    values.push(status);
  }

  if (updates.length === 0) throw new WardrobeError('没有可更新的字段');

  const now = nowUtcMysql();
  updates.push(`updated_at = ?`, `sync_status = 'synced'`);
  values.push(now, id);

  await withSyncTransaction(async (conn) => {
    const [result] = await conn.query<ResultSetHeader>(
      `UPDATE wardrobe_items SET ${updates.join(', ')} WHERE id = ? AND ${ACTIVE_SQL}`,
      values,
    );
    if (result.affectedRows === 0) throw new WardrobeError('单品不存在', 404);
    const stamp = await stampLiveUpsert(conn, 'wardrobe_items', id, {
      mode: 'update',
      mutationId: options?.mutationId,
      expectedRev: options?.expectedRev,
    });
    await appendChangeLog(conn, [
      {
        tableName: 'wardrobe_items',
        recordPk: id,
        op: 'upsert',
        updatedAt: now,
        deviceId: options?.deviceId,
        serverRev: stamp.serverRev,
        mutationId: stamp.mutationId,
      },
    ]);
  });

  const updated = await getActiveItem(id);
  if (!updated) throw new WardrobeError('单品不存在', 404);
  return formatItem(updated);
}

export async function deleteItem(itemId: string, options?: SyncWriteOptions) {
  const id = itemId.trim();
  if (!id) throw new WardrobeError('id 不能为空');
  const existing = await getActiveItem(id);
  if (!existing) {
    return { id, deleted_at: formatDbDateTimeForApi(nowUtcMysql(), 'utc') ?? nowUtcMysql() };
  }

  const now = nowUtcMysql();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const events: ChangeLogEvent[] = [];

    const [linkRows] = await conn.query<RowDataPacket[]>(
      `SELECT id FROM wardrobe_outfit_items WHERE item_id = ? AND ${ACTIVE_SQL}`,
      [id],
    );
    for (const row of linkRows) {
      const linkId = String(row.id);
      const del = await deleteLiveWithRevision(conn, 'wardrobe_outfit_items', linkId, {
        skipOcc: true,
      });
      if (del.kind === 'deleted') {
        pushEvent(events, 'wardrobe_outfit_items', linkId, 'delete', now, options, del);
      }
    }

    const itemDel = await deleteLiveWithRevision(conn, 'wardrobe_items', id, {
      mutationId: options?.mutationId,
      expectedRev: options?.expectedRev,
    });
    if (itemDel.kind === 'deleted') {
      events.unshift({
        tableName: 'wardrobe_items',
        recordPk: id,
        op: 'delete',
        updatedAt: now,
        deviceId: options?.deviceId,
        serverRev: itemDel.serverRev,
        mutationId: itemDel.mutationId,
      });
    }
    if (events.length) await appendChangeLog(conn, events);
    await conn.commit();
    await flushPendingSyncPublish(conn);
    return { id, deleted_at: formatDbDateTimeForApi(now, 'utc') ?? now };
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

// —— Occasions ——

export async function listOccasions() {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${OCCASION_COLS} FROM wardrobe_occasions
     WHERE ${ACTIVE_SQL}
     ORDER BY sort_order ASC, created_at ASC, id ASC`,
  );
  return (rows as OccasionRow[]).map(formatOccasion);
}

export async function createOccasion(
  input: { id?: unknown; name: unknown; sort_order?: unknown },
  options?: SyncWriteOptions,
) {
  const name = asTrimmedString(input.name);
  if (!name) throw new WardrobeError('name 不能为空');
  const id = asTrimmedString(input.id) || randomUUID();
  const now = nowUtcMysql();

  try {
    await withSyncTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO wardrobe_occasions
           (id, name, sort_order, is_builtin, created_at, updated_at, sync_status)
         VALUES (?, ?, ?, 0, ?, ?, 'synced')`,
        [id, name, asInt(input.sort_order, 1000), now, now],
      );
      const stamp = await stampLiveUpsert(conn, 'wardrobe_occasions', id, {
        mode: 'insert',
        mutationId: options?.mutationId,
      });
      await appendChangeLog(conn, [
        {
          tableName: 'wardrobe_occasions',
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
      throw new WardrobeError('场合已存在', 409);
    }
    throw err;
  }

  const created = await getActiveOccasion(id);
  if (!created) throw new WardrobeError('创建场合失败', 500);
  return formatOccasion(created);
}

export async function updateOccasion(
  occasionId: string,
  input: { name?: unknown; sort_order?: unknown },
  options?: SyncWriteOptions,
) {
  const id = occasionId.trim();
  if (!id) throw new WardrobeError('id 不能为空');
  const existing = await getActiveOccasion(id);
  if (!existing) throw await throwTombstoneConflict(db, 'wardrobe_occasions', id);

  const updates: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) {
    const name = asTrimmedString(input.name);
    if (!name) throw new WardrobeError('name 不能为空');
    updates.push('name = ?');
    values.push(name);
  }
  if (input.sort_order !== undefined) {
    updates.push('sort_order = ?');
    values.push(asInt(input.sort_order, existing.sort_order));
  }
  if (updates.length === 0) throw new WardrobeError('没有可更新的字段');

  const now = nowUtcMysql();
  updates.push(`updated_at = ?`, `sync_status = 'synced'`);
  values.push(now, id);

  await withSyncTransaction(async (conn) => {
    const [result] = await conn.query<ResultSetHeader>(
      `UPDATE wardrobe_occasions SET ${updates.join(', ')} WHERE id = ? AND ${ACTIVE_SQL}`,
      values,
    );
    if (result.affectedRows === 0) throw new WardrobeError('场合不存在', 404);
    const stamp = await stampLiveUpsert(conn, 'wardrobe_occasions', id, {
      mode: 'update',
      mutationId: options?.mutationId,
      expectedRev: options?.expectedRev,
    });
    await appendChangeLog(conn, [
      {
        tableName: 'wardrobe_occasions',
        recordPk: id,
        op: 'upsert',
        updatedAt: now,
        deviceId: options?.deviceId,
        serverRev: stamp.serverRev,
        mutationId: stamp.mutationId,
      },
    ]);
  });

  const updated = await getActiveOccasion(id);
  if (!updated) throw new WardrobeError('场合不存在', 404);
  return formatOccasion(updated);
}

/** 删除场合：引用该场合的搭配清空 occasion_id */
export async function deleteOccasion(occasionId: string, options?: SyncWriteOptions) {
  const id = occasionId.trim();
  if (!id) throw new WardrobeError('id 不能为空');
  const existing = await getActiveOccasion(id);
  if (!existing) {
    return { id, deleted_at: formatDbDateTimeForApi(nowUtcMysql(), 'utc') ?? nowUtcMysql() };
  }
  if (Number(existing.is_builtin)) {
    throw new WardrobeError('不能删除内置场合');
  }

  const now = nowUtcMysql();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const events: ChangeLogEvent[] = [];

    const [outfitRows] = await conn.query<RowDataPacket[]>(
      `SELECT id FROM wardrobe_outfits WHERE occasion_id = ? AND ${ACTIVE_SQL}`,
      [id],
    );
    for (const row of outfitRows) {
      const outfitId = String(row.id);
      await conn.query(
        `UPDATE wardrobe_outfits
         SET occasion_id = NULL, updated_at = ?, sync_status = 'synced'
         WHERE id = ? AND ${ACTIVE_SQL}`,
        [now, outfitId],
      );
      const stamp = await stampLiveUpsert(conn, 'wardrobe_outfits', outfitId, {
        mode: 'update',
        skipOcc: true,
      });
      pushEvent(events, 'wardrobe_outfits', outfitId, 'upsert', now, options, stamp);
    }

    const del = await deleteLiveWithRevision(conn, 'wardrobe_occasions', id, {
      mutationId: options?.mutationId,
      expectedRev: options?.expectedRev,
    });
    if (del.kind === 'deleted') {
      events.unshift({
        tableName: 'wardrobe_occasions',
        recordPk: id,
        op: 'delete',
        updatedAt: now,
        deviceId: options?.deviceId,
        serverRev: del.serverRev,
        mutationId: del.mutationId,
      });
    }
    if (events.length) await appendChangeLog(conn, events);
    await conn.commit();
    await flushPendingSyncPublish(conn);
    return { id, deleted_at: formatDbDateTimeForApi(now, 'utc') ?? now };
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

// —— Outfits ——

async function listOutfitItemRows(outfitId: string): Promise<OutfitItemRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${OUTFIT_ITEM_COLS} FROM wardrobe_outfit_items
     WHERE outfit_id = ? AND ${ACTIVE_SQL}
     ORDER BY sort_order ASC, created_at ASC, id ASC`,
    [outfitId],
  );
  return rows as OutfitItemRow[];
}

async function resolveOutfitItemIds(raw: unknown): Promise<string[]> {
  if (!Array.isArray(raw)) throw new WardrobeError('item_ids 须为数组');
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const id = asTrimmedString(v);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const item = await getActiveItem(id);
    if (!item) throw new WardrobeError(`单品不存在: ${id}`, 404);
    ids.push(id);
  }
  return ids;
}

async function replaceOutfitItems(
  conn: PoolConnection,
  outfitId: string,
  itemIds: string[],
  now: string,
  options: SyncWriteOptions | undefined,
  events: ChangeLogEvent[],
) {
  const [existing] = await conn.query<RowDataPacket[]>(
    `SELECT id, item_id FROM wardrobe_outfit_items WHERE outfit_id = ? AND ${ACTIVE_SQL}`,
    [outfitId],
  );
  for (const row of existing) {
    const linkId = String(row.id);
    const del = await deleteLiveWithRevision(conn, 'wardrobe_outfit_items', linkId, {
      skipOcc: true,
    });
    if (del.kind === 'deleted') {
      pushEvent(events, 'wardrobe_outfit_items', linkId, 'delete', now, options, del);
    }
  }

  let order = 10;
  for (const itemId of itemIds) {
    const linkId = randomUUID();
    await conn.query(
      `INSERT INTO wardrobe_outfit_items
         (id, outfit_id, item_id, sort_order, created_at, updated_at, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, 'synced')`,
      [linkId, outfitId, itemId, order, now, now],
    );
    const stamp = await stampLiveUpsert(conn, 'wardrobe_outfit_items', linkId, {
      mode: 'insert',
      skipOcc: true,
    });
    pushEvent(events, 'wardrobe_outfit_items', linkId, 'upsert', now, options, stamp);
    order += 10;
  }
}

export async function listOutfits(query: {
  closet_id?: unknown;
  occasion_id?: unknown;
  status?: unknown;
} = {}) {
  const closetId = await resolveDefaultClosetId(query.closet_id);
  const where = [`closet_id = ?`, ACTIVE_SQL];
  const values: unknown[] = [closetId];
  const occasionId = asTrimmedString(query.occasion_id);
  if (occasionId) {
    where.push('occasion_id = ?');
    values.push(occasionId);
  }
  const status = asTrimmedString(query.status);
  if (status) {
    if (!OUTFIT_STATUSES.has(status)) throw new WardrobeError('status 无效');
    where.push('status = ?');
    values.push(status);
  }

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${OUTFIT_COLS} FROM wardrobe_outfits
     WHERE ${where.join(' AND ')}
     ORDER BY updated_at DESC, created_at DESC, id ASC`,
    values,
  );
  return (rows as OutfitRow[]).map(formatOutfit);
}

export async function getOutfitDetail(outfitId: string) {
  const id = outfitId.trim();
  if (!id) throw new WardrobeError('id 不能为空');
  const outfit = await getActiveOutfit(id);
  if (!outfit) throw new WardrobeError('搭配不存在', 404);

  const links = await listOutfitItemRows(id);
  const items: ReturnType<typeof formatItem>[] = [];
  for (const link of links) {
    const item = await getActiveItem(link.item_id);
    if (item) items.push(formatItem(item));
  }
  const occasion = outfit.occasion_id ? await getActiveOccasion(outfit.occasion_id) : null;

  return {
    ...formatOutfit(outfit),
    occasion: occasion ? formatOccasion(occasion) : null,
    outfit_items: links.map(formatOutfitItem),
    items,
  };
}

export type CreateOutfitInput = {
  id?: unknown;
  closet_id?: unknown;
  name: unknown;
  occasion_id?: unknown;
  note?: unknown;
  cover_item_id?: unknown;
  status?: unknown;
  item_ids?: unknown;
};

export async function createOutfit(input: CreateOutfitInput, options?: SyncWriteOptions) {
  const name = asTrimmedString(input.name);
  if (!name) throw new WardrobeError('name 不能为空');
  const closetId = await resolveDefaultClosetId(input.closet_id);
  const occasionId = asOptionalString(input.occasion_id);
  if (occasionId) {
    const occ = await getActiveOccasion(occasionId);
    if (!occ) throw new WardrobeError('场合不存在', 404);
  }
  const status = asTrimmedString(input.status) || 'active';
  if (!OUTFIT_STATUSES.has(status)) throw new WardrobeError('status 无效');

  const itemIds = input.item_ids === undefined ? [] : await resolveOutfitItemIds(input.item_ids);
  for (const itemId of itemIds) {
    const item = await getActiveItem(itemId);
    if (item && item.closet_id !== closetId) {
      throw new WardrobeError('搭配单品须属于同一衣橱');
    }
  }
  const coverItemId = asOptionalString(input.cover_item_id) ?? itemIds[0] ?? null;
  if (coverItemId && !itemIds.includes(coverItemId)) {
    const cover = await getActiveItem(coverItemId);
    if (!cover) throw new WardrobeError('封面单品不存在', 404);
  }

  const id = asTrimmedString(input.id) || randomUUID();
  const now = nowUtcMysql();

  try {
    await withSyncTransaction(async (conn) => {
      const events: ChangeLogEvent[] = [];
      await conn.query(
        `INSERT INTO wardrobe_outfits
           (id, closet_id, name, occasion_id, note, cover_item_id, wear_count, last_worn_on,
            status, created_at, updated_at, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, 'synced')`,
        [
          id,
          closetId,
          name,
          occasionId,
          asOptionalString(input.note),
          coverItemId,
          status,
          now,
          now,
        ],
      );
      const stamp = await stampLiveUpsert(conn, 'wardrobe_outfits', id, {
        mode: 'insert',
        mutationId: options?.mutationId,
      });
      pushEvent(events, 'wardrobe_outfits', id, 'upsert', now, options, stamp);
      await replaceOutfitItems(conn, id, itemIds, now, options, events);
      await appendChangeLog(conn, events);
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      throw new WardrobeError('搭配已存在', 409);
    }
    throw err;
  }

  return getOutfitDetail(id);
}

export type UpdateOutfitInput = Partial<CreateOutfitInput>;

export async function updateOutfit(
  outfitId: string,
  input: UpdateOutfitInput,
  options?: SyncWriteOptions,
) {
  const id = outfitId.trim();
  if (!id) throw new WardrobeError('id 不能为空');
  const existing = await getActiveOutfit(id);
  if (!existing) throw await throwTombstoneConflict(db, 'wardrobe_outfits', id);

  const updates: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    const name = asTrimmedString(input.name);
    if (!name) throw new WardrobeError('name 不能为空');
    updates.push('name = ?');
    values.push(name);
  }
  if (input.closet_id !== undefined) {
    const closetId = asTrimmedString(input.closet_id);
    if (!closetId) throw new WardrobeError('closet_id 不能为空');
    const closet = await getActiveCloset(closetId);
    if (!closet) throw new WardrobeError('衣橱不存在', 404);
    updates.push('closet_id = ?');
    values.push(closetId);
  }
  if (input.occasion_id !== undefined) {
    const occasionId = asOptionalString(input.occasion_id);
    if (occasionId) {
      const occ = await getActiveOccasion(occasionId);
      if (!occ) throw new WardrobeError('场合不存在', 404);
    }
    updates.push('occasion_id = ?');
    values.push(occasionId);
  }
  if (input.note !== undefined) {
    updates.push('note = ?');
    values.push(asOptionalString(input.note));
  }
  if (input.cover_item_id !== undefined) {
    updates.push('cover_item_id = ?');
    values.push(asOptionalString(input.cover_item_id));
  }
  if (input.status !== undefined) {
    const status = asTrimmedString(input.status);
    if (!OUTFIT_STATUSES.has(status)) throw new WardrobeError('status 无效');
    updates.push('status = ?');
    values.push(status);
  }

  const replaceItems = input.item_ids !== undefined;
  const itemIds = replaceItems ? await resolveOutfitItemIds(input.item_ids) : null;
  if (!replaceItems && updates.length === 0) {
    throw new WardrobeError('没有可更新的字段');
  }

  const now = nowUtcMysql();
  await withSyncTransaction(async (conn) => {
    const events: ChangeLogEvent[] = [];
    if (updates.length) {
      const setParts = [...updates, `updated_at = ?`, `sync_status = 'synced'`];
      const [result] = await conn.query<ResultSetHeader>(
        `UPDATE wardrobe_outfits SET ${setParts.join(', ')} WHERE id = ? AND ${ACTIVE_SQL}`,
        [...values, now, id],
      );
      if (result.affectedRows === 0) throw new WardrobeError('搭配不存在', 404);
    } else {
      await conn.query(
        `UPDATE wardrobe_outfits SET updated_at = ?, sync_status = 'synced' WHERE id = ? AND ${ACTIVE_SQL}`,
        [now, id],
      );
    }
    const stamp = await stampLiveUpsert(conn, 'wardrobe_outfits', id, {
      mode: 'update',
      mutationId: options?.mutationId,
      expectedRev: options?.expectedRev,
    });
    pushEvent(events, 'wardrobe_outfits', id, 'upsert', now, options, stamp);
    if (itemIds) {
      await replaceOutfitItems(conn, id, itemIds, now, options, events);
    }
    await appendChangeLog(conn, events);
  });

  return getOutfitDetail(id);
}

export async function deleteOutfit(outfitId: string, options?: SyncWriteOptions) {
  const id = outfitId.trim();
  if (!id) throw new WardrobeError('id 不能为空');
  const existing = await getActiveOutfit(id);
  if (!existing) {
    return { id, deleted_at: formatDbDateTimeForApi(nowUtcMysql(), 'utc') ?? nowUtcMysql() };
  }

  const now = nowUtcMysql();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const events: ChangeLogEvent[] = [];

    const [linkRows] = await conn.query<RowDataPacket[]>(
      `SELECT id FROM wardrobe_outfit_items WHERE outfit_id = ? AND ${ACTIVE_SQL}`,
      [id],
    );
    for (const row of linkRows) {
      const linkId = String(row.id);
      const del = await deleteLiveWithRevision(conn, 'wardrobe_outfit_items', linkId, {
        skipOcc: true,
      });
      if (del.kind === 'deleted') {
        pushEvent(events, 'wardrobe_outfit_items', linkId, 'delete', now, options, del);
      }
    }

    const outfitDel = await deleteLiveWithRevision(conn, 'wardrobe_outfits', id, {
      mutationId: options?.mutationId,
      expectedRev: options?.expectedRev,
    });
    if (outfitDel.kind === 'deleted') {
      events.unshift({
        tableName: 'wardrobe_outfits',
        recordPk: id,
        op: 'delete',
        updatedAt: now,
        deviceId: options?.deviceId,
        serverRev: outfitDel.serverRev,
        mutationId: outfitDel.mutationId,
      });
    }
    if (events.length) await appendChangeLog(conn, events);
    await conn.commit();
    await flushPendingSyncPublish(conn);
    return { id, deleted_at: formatDbDateTimeForApi(now, 'utc') ?? now };
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

// —— Wear ——

async function findActiveItemWearLog(
  conn: PoolConnection | typeof db,
  itemId: string,
  wornOn: string,
): Promise<WearLogRow | null> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT ${WEAR_LOG_COLS} FROM wardrobe_wear_logs
     WHERE item_id = ? AND worn_on = ? AND source = 'item' AND ${ACTIVE_SQL}
     LIMIT 1`,
    [itemId, wornOn],
  );
  return (rows[0] as WearLogRow | undefined) ?? null;
}

async function findActiveOutfitWearLog(
  conn: PoolConnection | typeof db,
  outfitId: string,
  wornOn: string,
): Promise<WearLogRow | null> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT ${WEAR_LOG_COLS} FROM wardrobe_wear_logs
     WHERE outfit_id = ? AND worn_on = ? AND source = 'outfit' AND ${ACTIVE_SQL}
     LIMIT 1`,
    [outfitId, wornOn],
  );
  return (rows[0] as WearLogRow | undefined) ?? null;
}

async function bumpItemWearCache(
  conn: PoolConnection,
  itemId: string,
  wornOn: string,
  now: string,
  options: SyncWriteOptions | undefined,
  events: ChangeLogEvent[],
) {
  await conn.query(
    `UPDATE wardrobe_items
     SET wear_count = wear_count + 1,
         last_worn_on = CASE
           WHEN last_worn_on IS NULL OR last_worn_on < ? THEN ?
           ELSE last_worn_on
         END,
         updated_at = ?,
         sync_status = 'synced'
     WHERE id = ? AND ${ACTIVE_SQL}`,
    [wornOn, wornOn, now, itemId],
  );
  const stamp = await stampLiveUpsert(conn, 'wardrobe_items', itemId, {
    mode: 'update',
    skipOcc: true,
  });
  pushEvent(events, 'wardrobe_items', itemId, 'upsert', now, options, stamp);
}

async function bumpOutfitWearCache(
  conn: PoolConnection,
  outfitId: string,
  wornOn: string,
  now: string,
  options: SyncWriteOptions | undefined,
  events: ChangeLogEvent[],
) {
  await conn.query(
    `UPDATE wardrobe_outfits
     SET wear_count = wear_count + 1,
         last_worn_on = CASE
           WHEN last_worn_on IS NULL OR last_worn_on < ? THEN ?
           ELSE last_worn_on
         END,
         updated_at = ?,
         sync_status = 'synced'
     WHERE id = ? AND ${ACTIVE_SQL}`,
    [wornOn, wornOn, now, outfitId],
  );
  const stamp = await stampLiveUpsert(conn, 'wardrobe_outfits', outfitId, {
    mode: 'update',
    skipOcc: true,
  });
  pushEvent(events, 'wardrobe_outfits', outfitId, 'upsert', now, options, stamp);
}

async function recalcItemWearCache(
  conn: PoolConnection,
  itemId: string,
  now: string,
  options: SyncWriteOptions | undefined,
  events: ChangeLogEvent[],
) {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c, MAX(worn_on) AS last_worn
     FROM wardrobe_wear_logs
     WHERE item_id = ? AND source = 'item' AND ${ACTIVE_SQL}`,
    [itemId],
  );
  const count = Number(rows[0]?.c ?? 0);
  const lastWorn = rows[0]?.last_worn == null ? null : String(rows[0].last_worn);
  await conn.query(
    `UPDATE wardrobe_items
     SET wear_count = ?, last_worn_on = ?, updated_at = ?, sync_status = 'synced'
     WHERE id = ? AND ${ACTIVE_SQL}`,
    [count, lastWorn, now, itemId],
  );
  const stamp = await stampLiveUpsert(conn, 'wardrobe_items', itemId, {
    mode: 'update',
    skipOcc: true,
  });
  pushEvent(events, 'wardrobe_items', itemId, 'upsert', now, options, stamp);
}

async function recalcOutfitWearCache(
  conn: PoolConnection,
  outfitId: string,
  now: string,
  options: SyncWriteOptions | undefined,
  events: ChangeLogEvent[],
) {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c, MAX(worn_on) AS last_worn
     FROM wardrobe_wear_logs
     WHERE outfit_id = ? AND source = 'outfit' AND ${ACTIVE_SQL}`,
    [outfitId],
  );
  const count = Number(rows[0]?.c ?? 0);
  const lastWorn = rows[0]?.last_worn == null ? null : String(rows[0].last_worn);
  await conn.query(
    `UPDATE wardrobe_outfits
     SET wear_count = ?, last_worn_on = ?, updated_at = ?, sync_status = 'synced'
     WHERE id = ? AND ${ACTIVE_SQL}`,
    [count, lastWorn, now, outfitId],
  );
  const stamp = await stampLiveUpsert(conn, 'wardrobe_outfits', outfitId, {
    mode: 'update',
    skipOcc: true,
  });
  pushEvent(events, 'wardrobe_outfits', outfitId, 'upsert', now, options, stamp);
}

export async function wearItem(
  input: { item_id: unknown; worn_on?: unknown; note?: unknown },
  options?: SyncWriteOptions,
) {
  const itemId = asTrimmedString(input.item_id);
  if (!itemId) throw new WardrobeError('item_id 不能为空');
  const item = await getActiveItem(itemId);
  if (!item) throw new WardrobeError('单品不存在', 404);
  const wornOn = normalizeWornOn(input.worn_on);
  const note = asOptionalString(input.note);

  const existing = await findActiveItemWearLog(db, itemId, wornOn);
  if (existing) {
    return { created: false, log: formatWearLog(existing), item: formatItem(item) };
  }

  const logId = randomUUID();
  const now = nowUtcMysql();

  await withSyncTransaction(async (conn) => {
    const again = await findActiveItemWearLog(conn, itemId, wornOn);
    if (again) return;

    const events: ChangeLogEvent[] = [];
    await conn.query(
      `INSERT INTO wardrobe_wear_logs
         (id, closet_id, worn_on, source, item_id, outfit_id, note, created_at, updated_at, sync_status)
       VALUES (?, ?, ?, 'item', ?, NULL, ?, ?, ?, 'synced')`,
      [logId, item.closet_id, wornOn, itemId, note, now, now],
    );
    const stamp = await stampLiveUpsert(conn, 'wardrobe_wear_logs', logId, {
      mode: 'insert',
      mutationId: options?.mutationId,
    });
    pushEvent(events, 'wardrobe_wear_logs', logId, 'upsert', now, options, stamp);
    await bumpItemWearCache(conn, itemId, wornOn, now, options, events);
    await appendChangeLog(conn, events);
  });

  const log = await getActiveWearLog(logId);
  const updatedItem = await getActiveItem(itemId);
  return {
    created: true,
    log: log ? formatWearLog(log) : null,
    item: updatedItem ? formatItem(updatedItem) : formatItem(item),
  };
}

export async function wearOutfit(
  input: { outfit_id: unknown; worn_on?: unknown; note?: unknown },
  options?: SyncWriteOptions,
) {
  const outfitId = asTrimmedString(input.outfit_id);
  if (!outfitId) throw new WardrobeError('outfit_id 不能为空');
  const outfit = await getActiveOutfit(outfitId);
  if (!outfit) throw new WardrobeError('搭配不存在', 404);
  const wornOn = normalizeWornOn(input.worn_on);
  const note = asOptionalString(input.note);

  const existing = await findActiveOutfitWearLog(db, outfitId, wornOn);
  if (existing) {
    return {
      created: false,
      log: formatWearLog(existing),
      outfit: formatOutfit(outfit),
      item_logs: [] as ReturnType<typeof formatWearLog>[],
    };
  }

  const links = await listOutfitItemRows(outfitId);
  const outfitLogId = randomUUID();
  const now = nowUtcMysql();
  const itemLogIds: string[] = [];

  await withSyncTransaction(async (conn) => {
    const again = await findActiveOutfitWearLog(conn, outfitId, wornOn);
    if (again) return;

    const events: ChangeLogEvent[] = [];
    await conn.query(
      `INSERT INTO wardrobe_wear_logs
         (id, closet_id, worn_on, source, item_id, outfit_id, note, created_at, updated_at, sync_status)
       VALUES (?, ?, ?, 'outfit', NULL, ?, ?, ?, ?, 'synced')`,
      [outfitLogId, outfit.closet_id, wornOn, outfitId, note, now, now],
    );
    const outfitStamp = await stampLiveUpsert(conn, 'wardrobe_wear_logs', outfitLogId, {
      mode: 'insert',
      mutationId: options?.mutationId,
    });
    pushEvent(events, 'wardrobe_wear_logs', outfitLogId, 'upsert', now, options, outfitStamp);
    await bumpOutfitWearCache(conn, outfitId, wornOn, now, options, events);

    for (const link of links) {
      const itemId = link.item_id;
      const itemExists = await findActiveItemWearLog(conn, itemId, wornOn);
      if (itemExists) continue;
      const itemLogId = randomUUID();
      itemLogIds.push(itemLogId);
      await conn.query(
        `INSERT INTO wardrobe_wear_logs
           (id, closet_id, worn_on, source, item_id, outfit_id, note, created_at, updated_at, sync_status)
         VALUES (?, ?, ?, 'item', ?, ?, ?, ?, ?, 'synced')`,
        [itemLogId, outfit.closet_id, wornOn, itemId, outfitId, note, now, now],
      );
      const stamp = await stampLiveUpsert(conn, 'wardrobe_wear_logs', itemLogId, {
        mode: 'insert',
        skipOcc: true,
      });
      pushEvent(events, 'wardrobe_wear_logs', itemLogId, 'upsert', now, options, stamp);
      await bumpItemWearCache(conn, itemId, wornOn, now, options, events);
    }

    await appendChangeLog(conn, events);
  });

  const log = await getActiveWearLog(outfitLogId);
  const itemLogs: ReturnType<typeof formatWearLog>[] = [];
  for (const lid of itemLogIds) {
    const row = await getActiveWearLog(lid);
    if (row) itemLogs.push(formatWearLog(row));
  }
  const updatedOutfit = await getActiveOutfit(outfitId);
  return {
    created: true,
    log: log ? formatWearLog(log) : null,
    outfit: updatedOutfit ? formatOutfit(updatedOutfit) : formatOutfit(outfit),
    item_logs: itemLogs,
  };
}

export async function deleteWearLog(logIdRaw: string, options?: SyncWriteOptions) {
  const id = logIdRaw.trim();
  if (!id) throw new WardrobeError('id 不能为空');
  const existing = await getActiveWearLog(id);
  if (!existing) {
    return { id, deleted_at: formatDbDateTimeForApi(nowUtcMysql(), 'utc') ?? nowUtcMysql() };
  }

  const now = nowUtcMysql();
  await withSyncTransaction(async (conn) => {
    const events: ChangeLogEvent[] = [];
    const del = await deleteLiveWithRevision(conn, 'wardrobe_wear_logs', id, {
      mutationId: options?.mutationId,
      expectedRev: options?.expectedRev,
    });
    if (del.kind === 'deleted') {
      pushEvent(events, 'wardrobe_wear_logs', id, 'delete', now, options, del);
    }
    if (existing.source === 'item' && existing.item_id) {
      await recalcItemWearCache(conn, existing.item_id, now, options, events);
    }
    if (existing.source === 'outfit' && existing.outfit_id) {
      await recalcOutfitWearCache(conn, existing.outfit_id, now, options, events);
    }
    if (events.length) await appendChangeLog(conn, events);
  });

  return { id, deleted_at: formatDbDateTimeForApi(now, 'utc') ?? now };
}

export async function getWearWeek(closetIdRaw?: unknown, anchorRaw?: unknown) {
  const closetId = await resolveDefaultClosetId(closetIdRaw);
  const anchor = asTrimmedString(anchorRaw) || formatLocalYmdFromDate(new Date());
  if (!isValidYmd(anchor)) throw new WardrobeError('anchor 须为 YYYY-MM-DD');
  const weekStart = mondayOf(anchor);
  const weekEnd = addDaysToYmd(weekStart, 6);

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT worn_on FROM wardrobe_wear_logs
     WHERE closet_id = ? AND worn_on >= ? AND worn_on <= ? AND ${ACTIVE_SQL}`,
    [closetId, weekStart, weekEnd],
  );
  const wornSet = new Set(rows.map((r) => String(r.worn_on)));
  const days = Array.from({ length: 7 }, (_, i) => {
    const ymd = addDaysToYmd(weekStart, i);
    return { ymd, worn: wornSet.has(ymd) };
  });
  const wornDaysThisWeek = days.filter((d) => d.worn).length;

  // 连续天数：从今天（或 anchor）往前数有穿着的天
  const today = formatLocalYmdFromDate(new Date());
  let streak = 0;
  let cursor = today;
  for (let i = 0; i < 400; i += 1) {
    const [dayRows] = await db.query<RowDataPacket[]>(
      `SELECT 1 AS ok FROM wardrobe_wear_logs
       WHERE closet_id = ? AND worn_on = ? AND ${ACTIVE_SQL}
       LIMIT 1`,
      [closetId, cursor],
    );
    if (!dayRows[0]) break;
    streak += 1;
    cursor = addDaysToYmd(cursor, -1);
  }

  return {
    closet_id: closetId,
    anchor,
    week_start: weekStart,
    week_end: weekEnd,
    days,
    worn_days_this_week: wornDaysThisWeek,
    streak_days: streak,
  };
}

export async function getItemWearHistory(itemIdRaw: string, days = 28) {
  const itemId = itemIdRaw.trim();
  if (!itemId) throw new WardrobeError('id 不能为空');
  const item = await getActiveItem(itemId);
  if (!item) throw new WardrobeError('单品不存在', 404);

  const end = formatLocalYmdFromDate(new Date());
  const start = addDaysToYmd(end, -(Math.max(days, 1) - 1));
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT worn_on FROM wardrobe_wear_logs
     WHERE item_id = ? AND source = 'item' AND worn_on >= ? AND worn_on <= ? AND ${ACTIVE_SQL}`,
    [itemId, start, end],
  );
  const worn = new Set(rows.map((r) => String(r.worn_on)));
  const sequence: boolean[] = [];
  const dates: string[] = [];
  for (let i = 0; i < days; i += 1) {
    const ymd = addDaysToYmd(start, i);
    dates.push(ymd);
    sequence.push(worn.has(ymd));
  }
  return {
    item_id: itemId,
    start,
    end,
    days,
    dates,
    sequence,
    worn_dates: dates.filter((_, i) => sequence[i]),
  };
}

// —— Options ——

const OPTION_KINDS = new Set(['color', 'brand', 'season', 'fit']);

const OPTION_COLS = `id, closet_id, kind, value, sort_order, is_builtin, created_at, updated_at, sync_status, server_rev, mutation_id`;

type OptionRow = {
  id: string;
  closet_id: string | null;
  kind: string;
  value: string;
  sort_order: number;
  is_builtin: number;
  created_at: string;
  updated_at: string;
  sync_status: string;
  server_rev?: number;
  mutation_id?: string | null;
};

function formatOption(row: OptionRow) {
  return formatRecordDateTimesForApi(
    {
      id: row.id,
      closet_id: row.closet_id,
      kind: row.kind,
      value: row.value,
      sort_order: Number(row.sort_order) || 0,
      is_builtin: Number(row.is_builtin) ? 1 : 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
      sync_status: row.sync_status,
      server_rev: row.server_rev ?? 1,
      mutation_id: row.mutation_id ?? null,
      version: 1,
    },
    'wardrobe_option_values',
  );
}

async function getActiveOption(id: string): Promise<OptionRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${OPTION_COLS} FROM wardrobe_option_values WHERE id = ? AND ${ACTIVE_SQL} LIMIT 1`,
    [id],
  );
  return (rows[0] as OptionRow | undefined) ?? null;
}

export async function listOptions(query: { closet_id?: unknown; kind?: unknown } = {}) {
  const where = [ACTIVE_SQL];
  const values: unknown[] = [];
  const closetId = asTrimmedString(query.closet_id);
  if (closetId) {
    where.push('(closet_id IS NULL OR closet_id = ?)');
    values.push(closetId);
  }
  const kind = asTrimmedString(query.kind);
  if (kind) {
    if (!OPTION_KINDS.has(kind)) throw new WardrobeError('kind 无效');
    where.push('kind = ?');
    values.push(kind);
  }
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${OPTION_COLS} FROM wardrobe_option_values
     WHERE ${where.join(' AND ')}
     ORDER BY kind ASC, sort_order ASC, created_at ASC, id ASC`,
    values,
  );
  return (rows as OptionRow[]).map(formatOption);
}

export async function createOption(
  input: {
    id?: unknown;
    closet_id?: unknown;
    kind: unknown;
    value: unknown;
    sort_order?: unknown;
  },
  options?: SyncWriteOptions,
) {
  const kind = asTrimmedString(input.kind);
  if (!OPTION_KINDS.has(kind)) throw new WardrobeError('kind 须为 color/brand/season/fit');
  const value = asTrimmedString(input.value);
  if (!value) throw new WardrobeError('value 不能为空');

  let closetId: string | null = asOptionalString(input.closet_id);
  if (closetId) {
    const closet = await getActiveCloset(closetId);
    if (!closet) throw new WardrobeError('衣橱不存在', 404);
  }

  const id = asTrimmedString(input.id) || randomUUID();
  const now = nowUtcMysql();

  try {
    await withSyncTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO wardrobe_option_values
           (id, closet_id, kind, value, sort_order, is_builtin, created_at, updated_at, sync_status)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'synced')`,
        [id, closetId, kind, value, asInt(input.sort_order, 1000), now, now],
      );
      const stamp = await stampLiveUpsert(conn, 'wardrobe_option_values', id, {
        mode: 'insert',
        mutationId: options?.mutationId,
      });
      await appendChangeLog(conn, [
        {
          tableName: 'wardrobe_option_values',
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
      throw new WardrobeError('选项已存在', 409);
    }
    throw err;
  }

  const created = await getActiveOption(id);
  if (!created) throw new WardrobeError('创建选项失败', 500);
  return formatOption(created);
}

export async function updateOption(
  optionId: string,
  input: { value?: unknown; sort_order?: unknown; kind?: unknown; closet_id?: unknown },
  options?: SyncWriteOptions,
) {
  const id = optionId.trim();
  if (!id) throw new WardrobeError('id 不能为空');
  const existing = await getActiveOption(id);
  if (!existing) throw await throwTombstoneConflict(db, 'wardrobe_option_values', id);

  const updates: string[] = [];
  const values: unknown[] = [];
  if (input.value !== undefined) {
    const value = asTrimmedString(input.value);
    if (!value) throw new WardrobeError('value 不能为空');
    updates.push('value = ?');
    values.push(value);
  }
  if (input.sort_order !== undefined) {
    updates.push('sort_order = ?');
    values.push(asInt(input.sort_order, existing.sort_order));
  }
  if (input.kind !== undefined) {
    const kind = asTrimmedString(input.kind);
    if (!OPTION_KINDS.has(kind)) throw new WardrobeError('kind 无效');
    updates.push('kind = ?');
    values.push(kind);
  }
  if (input.closet_id !== undefined) {
    const closetId = asOptionalString(input.closet_id);
    if (closetId) {
      const closet = await getActiveCloset(closetId);
      if (!closet) throw new WardrobeError('衣橱不存在', 404);
    }
    updates.push('closet_id = ?');
    values.push(closetId);
  }
  if (updates.length === 0) throw new WardrobeError('没有可更新的字段');

  const now = nowUtcMysql();
  updates.push(`updated_at = ?`, `sync_status = 'synced'`);
  values.push(now, id);

  await withSyncTransaction(async (conn) => {
    const [result] = await conn.query<ResultSetHeader>(
      `UPDATE wardrobe_option_values SET ${updates.join(', ')} WHERE id = ? AND ${ACTIVE_SQL}`,
      values,
    );
    if (result.affectedRows === 0) throw new WardrobeError('选项不存在', 404);
    const stamp = await stampLiveUpsert(conn, 'wardrobe_option_values', id, {
      mode: 'update',
      mutationId: options?.mutationId,
      expectedRev: options?.expectedRev,
    });
    await appendChangeLog(conn, [
      {
        tableName: 'wardrobe_option_values',
        recordPk: id,
        op: 'upsert',
        updatedAt: now,
        deviceId: options?.deviceId,
        serverRev: stamp.serverRev,
        mutationId: stamp.mutationId,
      },
    ]);
  });

  const updated = await getActiveOption(id);
  if (!updated) throw new WardrobeError('选项不存在', 404);
  return formatOption(updated);
}

export async function deleteOption(optionId: string, options?: SyncWriteOptions) {
  const id = optionId.trim();
  if (!id) throw new WardrobeError('id 不能为空');
  const existing = await getActiveOption(id);
  if (!existing) {
    return { id, deleted_at: formatDbDateTimeForApi(nowUtcMysql(), 'utc') ?? nowUtcMysql() };
  }
  if (Number(existing.is_builtin)) {
    throw new WardrobeError('不能删除内置选项');
  }

  const now = nowUtcMysql();
  await withSyncTransaction(async (conn) => {
    const del = await deleteLiveWithRevision(conn, 'wardrobe_option_values', id, {
      mutationId: options?.mutationId,
      expectedRev: options?.expectedRev,
    });
    if (del.kind === 'already_gone') return;
    await appendChangeLog(conn, [
      {
        tableName: 'wardrobe_option_values',
        recordPk: id,
        op: 'delete',
        updatedAt: now,
        deviceId: options?.deviceId,
        serverRev: del.serverRev,
        mutationId: del.mutationId,
      },
    ]);
  });

  return { id, deleted_at: formatDbDateTimeForApi(now, 'utc') ?? now };
}

// —— Body profile ——

const BODY_COLS = `id, closet_id, height_cm, weight_kg, shoulder_cm, bust_cm, waist_cm, hip_cm,
  inseam_cm, foot_mm, size_top, size_bottom, size_shoe, note, extra_data,
  created_at, updated_at, sync_status, server_rev, mutation_id`;

type BodyProfileRow = {
  id: string;
  closet_id: string | null;
  height_cm: number | null;
  weight_kg: number | null;
  shoulder_cm: number | null;
  bust_cm: number | null;
  waist_cm: number | null;
  hip_cm: number | null;
  inseam_cm: number | null;
  foot_mm: number | null;
  size_top: string | null;
  size_bottom: string | null;
  size_shoe: string | null;
  note: string | null;
  extra_data: unknown;
  created_at: string;
  updated_at: string;
  sync_status: string;
  server_rev?: number;
  mutation_id?: string | null;
};

function formatBodyProfile(row: BodyProfileRow) {
  return formatRecordDateTimesForApi(
    {
      id: row.id,
      closet_id: row.closet_id,
      height_cm: row.height_cm == null ? null : Number(row.height_cm),
      weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
      shoulder_cm: row.shoulder_cm == null ? null : Number(row.shoulder_cm),
      bust_cm: row.bust_cm == null ? null : Number(row.bust_cm),
      waist_cm: row.waist_cm == null ? null : Number(row.waist_cm),
      hip_cm: row.hip_cm == null ? null : Number(row.hip_cm),
      inseam_cm: row.inseam_cm == null ? null : Number(row.inseam_cm),
      foot_mm: row.foot_mm == null ? null : Number(row.foot_mm),
      size_top: row.size_top,
      size_bottom: row.size_bottom,
      size_shoe: row.size_shoe,
      note: row.note,
      extra_data: parseJsonField(row.extra_data),
      created_at: row.created_at,
      updated_at: row.updated_at,
      sync_status: row.sync_status,
      server_rev: row.server_rev ?? 1,
      mutation_id: row.mutation_id ?? null,
      version: 1,
    },
    'wardrobe_body_profile',
  );
}

function asOptionalDecimal(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new WardrobeError('数值字段无效');
  return Math.round(n * 100) / 100;
}

async function findBodyProfile(closetId: string | null): Promise<BodyProfileRow | null> {
  if (closetId) {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT ${BODY_COLS} FROM wardrobe_body_profile
       WHERE closet_id = ? AND ${ACTIVE_SQL}
       ORDER BY updated_at DESC LIMIT 1`,
      [closetId],
    );
    if (rows[0]) return rows[0] as BodyProfileRow;
  }
  const [globalRows] = await db.query<RowDataPacket[]>(
    `SELECT ${BODY_COLS} FROM wardrobe_body_profile
     WHERE closet_id IS NULL AND ${ACTIVE_SQL}
     ORDER BY updated_at DESC LIMIT 1`,
  );
  return (globalRows[0] as BodyProfileRow | undefined) ?? null;
}

export async function getBodyProfile(closetIdRaw?: unknown) {
  const closetId = asTrimmedString(closetIdRaw) || null;
  if (closetId) {
    const closet = await getActiveCloset(closetId);
    if (!closet) throw new WardrobeError('衣橱不存在', 404);
  }
  const row = await findBodyProfile(closetId);
  return row ? formatBodyProfile(row) : null;
}

export type UpsertBodyProfileInput = {
  id?: unknown;
  closet_id?: unknown;
  height_cm?: unknown;
  weight_kg?: unknown;
  shoulder_cm?: unknown;
  bust_cm?: unknown;
  waist_cm?: unknown;
  hip_cm?: unknown;
  inseam_cm?: unknown;
  foot_mm?: unknown;
  size_top?: unknown;
  size_bottom?: unknown;
  size_shoe?: unknown;
  note?: unknown;
  extra_data?: unknown;
};

/** PUT：无记录则创建，有则全量覆盖可写字段 */
export async function upsertBodyProfile(
  input: UpsertBodyProfileInput,
  options?: SyncWriteOptions,
) {
  let closetId: string | null = asOptionalString(input.closet_id);
  if (closetId) {
    const closet = await getActiveCloset(closetId);
    if (!closet) throw new WardrobeError('衣橱不存在', 404);
  }

  const existing = await findBodyProfile(closetId);
  const now = nowUtcMysql();
  const fields = {
    height_cm: input.height_cm !== undefined ? asOptionalDecimal(input.height_cm) : existing?.height_cm ?? null,
    weight_kg: input.weight_kg !== undefined ? asOptionalDecimal(input.weight_kg) : existing?.weight_kg ?? null,
    shoulder_cm:
      input.shoulder_cm !== undefined ? asOptionalDecimal(input.shoulder_cm) : existing?.shoulder_cm ?? null,
    bust_cm: input.bust_cm !== undefined ? asOptionalDecimal(input.bust_cm) : existing?.bust_cm ?? null,
    waist_cm: input.waist_cm !== undefined ? asOptionalDecimal(input.waist_cm) : existing?.waist_cm ?? null,
    hip_cm: input.hip_cm !== undefined ? asOptionalDecimal(input.hip_cm) : existing?.hip_cm ?? null,
    inseam_cm:
      input.inseam_cm !== undefined ? asOptionalDecimal(input.inseam_cm) : existing?.inseam_cm ?? null,
    foot_mm: input.foot_mm !== undefined ? asOptionalDecimal(input.foot_mm) : existing?.foot_mm ?? null,
    size_top: input.size_top !== undefined ? asOptionalString(input.size_top) : existing?.size_top ?? null,
    size_bottom:
      input.size_bottom !== undefined ? asOptionalString(input.size_bottom) : existing?.size_bottom ?? null,
    size_shoe:
      input.size_shoe !== undefined ? asOptionalString(input.size_shoe) : existing?.size_shoe ?? null,
    note: input.note !== undefined ? asOptionalString(input.note) : existing?.note ?? null,
    extra_data:
      input.extra_data !== undefined
        ? input.extra_data == null
          ? null
          : typeof input.extra_data === 'string'
            ? asOptionalString(input.extra_data)
            : JSON.stringify(input.extra_data)
        : existing?.extra_data == null
          ? null
          : typeof existing.extra_data === 'string'
            ? existing.extra_data
            : JSON.stringify(existing.extra_data),
  };

  if (!existing) {
    const id = asTrimmedString(input.id) || randomUUID();
    await withSyncTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO wardrobe_body_profile
           (id, closet_id, height_cm, weight_kg, shoulder_cm, bust_cm, waist_cm, hip_cm,
            inseam_cm, foot_mm, size_top, size_bottom, size_shoe, note, extra_data,
            created_at, updated_at, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')`,
        [
          id,
          closetId,
          fields.height_cm,
          fields.weight_kg,
          fields.shoulder_cm,
          fields.bust_cm,
          fields.waist_cm,
          fields.hip_cm,
          fields.inseam_cm,
          fields.foot_mm,
          fields.size_top,
          fields.size_bottom,
          fields.size_shoe,
          fields.note,
          fields.extra_data,
          now,
          now,
        ],
      );
      const stamp = await stampLiveUpsert(conn, 'wardrobe_body_profile', id, {
        mode: 'insert',
        mutationId: options?.mutationId,
      });
      await appendChangeLog(conn, [
        {
          tableName: 'wardrobe_body_profile',
          recordPk: id,
          op: 'upsert',
          updatedAt: now,
          deviceId: options?.deviceId,
          serverRev: stamp.serverRev,
          mutationId: stamp.mutationId,
        },
      ]);
    });
    const created = await findBodyProfile(closetId);
    if (!created) throw new WardrobeError('保存身材档案失败', 500);
    return formatBodyProfile(created);
  }

  const id = existing.id;
  await withSyncTransaction(async (conn) => {
    await conn.query(
      `UPDATE wardrobe_body_profile
       SET closet_id = ?, height_cm = ?, weight_kg = ?, shoulder_cm = ?, bust_cm = ?,
           waist_cm = ?, hip_cm = ?, inseam_cm = ?, foot_mm = ?,
           size_top = ?, size_bottom = ?, size_shoe = ?, note = ?, extra_data = ?,
           updated_at = ?, sync_status = 'synced'
       WHERE id = ? AND ${ACTIVE_SQL}`,
      [
        closetId ?? existing.closet_id,
        fields.height_cm,
        fields.weight_kg,
        fields.shoulder_cm,
        fields.bust_cm,
        fields.waist_cm,
        fields.hip_cm,
        fields.inseam_cm,
        fields.foot_mm,
        fields.size_top,
        fields.size_bottom,
        fields.size_shoe,
        fields.note,
        fields.extra_data,
        now,
        id,
      ],
    );
    const stamp = await stampLiveUpsert(conn, 'wardrobe_body_profile', id, {
      mode: 'update',
      mutationId: options?.mutationId,
      expectedRev: options?.expectedRev,
    });
    await appendChangeLog(conn, [
      {
        tableName: 'wardrobe_body_profile',
        recordPk: id,
        op: 'upsert',
        updatedAt: now,
        deviceId: options?.deviceId,
        serverRev: stamp.serverRev,
        mutationId: stamp.mutationId,
      },
    ]);
  });

  const updated = await findBodyProfile(closetId ?? existing.closet_id);
  if (!updated) throw new WardrobeError('身材档案不存在', 404);
  return formatBodyProfile(updated);
}

// —— Stats ——

export async function getStatsSummary(closetIdRaw?: unknown) {
  const closetId = await resolveDefaultClosetId(closetIdRaw);

  const [catRows] = await db.query<RowDataPacket[]>(
    `SELECT c.id AS category_id, c.name AS category_name, COUNT(i.id) AS item_count
     FROM wardrobe_categories c
     LEFT JOIN wardrobe_items i
       ON i.category_id = c.id AND i.closet_id = ?
      AND (i.sync_status IS NULL OR i.sync_status != 'pending_delete')
      AND i.status = 'active'
     WHERE c.closet_id = ?
       AND (c.sync_status IS NULL OR c.sync_status != 'pending_delete')
     GROUP BY c.id, c.name, c.sort_order
     ORDER BY item_count DESC, c.sort_order ASC`,
    [closetId, closetId],
  );

  const [seasonRows] = await db.query<RowDataPacket[]>(
    `SELECT COALESCE(NULLIF(TRIM(season), ''), '未填') AS season, COUNT(*) AS item_count
     FROM wardrobe_items
     WHERE closet_id = ? AND ${ACTIVE_SQL} AND status = 'active'
     GROUP BY COALESCE(NULLIF(TRIM(season), ''), '未填')
     ORDER BY item_count DESC`,
    [closetId],
  );

  const [colorRows] = await db.query<RowDataPacket[]>(
    `SELECT COALESCE(NULLIF(TRIM(color), ''), '未填') AS color, COUNT(*) AS item_count
     FROM wardrobe_items
     WHERE closet_id = ? AND ${ACTIVE_SQL} AND status = 'active'
     GROUP BY COALESCE(NULLIF(TRIM(color), ''), '未填')
     ORDER BY item_count DESC
     LIMIT 20`,
    [closetId],
  );

  const [topWornRows] = await db.query<RowDataPacket[]>(
    `SELECT ${ITEM_COLS}
     FROM wardrobe_items
     WHERE closet_id = ? AND ${ACTIVE_SQL} AND status = 'active'
     ORDER BY wear_count DESC, last_worn_on DESC, updated_at DESC
     LIMIT 10`,
    [closetId],
  );

  const [totalRows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM wardrobe_items
     WHERE closet_id = ? AND ${ACTIVE_SQL} AND status = 'active'`,
    [closetId],
  );

  return {
    closet_id: closetId,
    item_total: Number(totalRows[0]?.c ?? 0),
    by_category: catRows.map((r) => ({
      category_id: String(r.category_id),
      category_name: String(r.category_name),
      item_count: Number(r.item_count) || 0,
    })),
    by_season: seasonRows.map((r) => ({
      season: String(r.season),
      item_count: Number(r.item_count) || 0,
    })),
    by_color: colorRows.map((r) => ({
      color: String(r.color),
      item_count: Number(r.item_count) || 0,
    })),
    top_worn_items: (topWornRows as ItemRow[]).map((r) => formatItem(r)),
  };
}

// —— Bootstrap ——

export async function bootstrapWardrobe(closetIdRaw?: unknown) {
  const closetId = await resolveDefaultClosetId(closetIdRaw);
  const closet = await getActiveCloset(closetId);
  if (!closet) throw new WardrobeError('衣橱不存在', 404);

  const [categories, occasions, itemsPage, outfits, wearWeek, itemCount, optionsList, bodyProfile] =
    await Promise.all([
      listCategories(closetId),
      listOccasions(),
      listItems({ closet_id: closetId, status: 'active', limit: 200, offset: 0 }),
      listOutfits({ closet_id: closetId, status: 'active' }),
      getWearWeek(closetId),
      countItems(closetId, 'active'),
      listOptions({ closet_id: closetId }),
      getBodyProfile(closetId),
    ]);

  const recentOutfits = outfits.slice(0, 12);

  return {
    closet: formatCloset(closet),
    categories,
    occasions,
    items: itemsPage.items,
    item_count: itemCount.count,
    outfits: recentOutfits,
    outfit_count: outfits.length,
    wear_week: wearWeek,
    options: optionsList,
    body_profile: bodyProfile,
  };
}
