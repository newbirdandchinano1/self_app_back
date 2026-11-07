/**
 * Agent 只读衣橱快照：单品/搭配摘要、闲置与近穿着（字段白名单）。
 * 挂载：GET /api/app/agent/snapshot/wardrobe
 */
import type { RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import {
  WardrobeError,
  listCategories,
  listItems,
  listOutfits,
  getStatsSummary,
} from '../wardrobe.js';
import { addDaysToYmd, formatLocalYmdFromDate } from '../calendar/logical-day.js';

const ITEM_LIMIT = 60;
const OUTFIT_LIMIT = 24;
const RECENT_WEAR_DAYS = 28;
const IDLE_DAYS = 90;

export type AgentWardrobeSnapshotParams = {
  limit?: number;
};

export { WardrobeError as WardrobeSnapshotError };

const ACTIVE_SQL = `(sync_status IS NULL OR sync_status != 'pending_delete')`;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function trimItem(
  row: Record<string, unknown>,
  categoryNameById: Map<string, string>,
) {
  const id = row.id == null ? null : String(row.id);
  const categoryId = row.category_id == null ? null : String(row.category_id);
  const tagsRaw = row.tags_json;
  let tags: string[] = [];
  if (Array.isArray(tagsRaw)) {
    tags = tagsRaw.filter((t): t is string => typeof t === 'string' && !!t.trim()).slice(0, 6);
  }
  return {
    id,
    name: String(row.name ?? '').trim() || '未命名单品',
    category_id: categoryId,
    category: categoryId ? categoryNameById.get(categoryId) || null : null,
    color: row.color == null ? null : String(row.color),
    season: row.season == null ? null : String(row.season),
    brand: row.brand == null ? null : String(row.brand),
    fit: row.fit == null ? null : String(row.fit),
    warmth: row.warmth == null ? null : String(row.warmth),
    wear_count: Number(row.wear_count) || 0,
    last_worn_on: row.last_worn_on == null ? null : String(row.last_worn_on),
    tags,
  };
}

function trimOutfit(row: Record<string, unknown>, itemIds: string[]) {
  return {
    id: row.id == null ? null : String(row.id),
    name: String(row.name ?? '').trim() || '未命名搭配',
    occasion_id: row.occasion_id == null ? null : String(row.occasion_id),
    wear_count: Number(row.wear_count) || 0,
    last_worn_on: row.last_worn_on == null ? null : String(row.last_worn_on),
    item_ids: itemIds.slice(0, 12),
  };
}

function isIdle(row: Record<string, unknown>, cutoffYmd: string): boolean {
  const wearCount = Number(row.wear_count) || 0;
  if (wearCount === 0) return true;
  const last = row.last_worn_on == null ? '' : String(row.last_worn_on).slice(0, 10);
  if (!last || last.length < 10) return true;
  return last < cutoffYmd;
}

export async function getAgentWardrobeSnapshot(params: AgentWardrobeSnapshotParams = {}) {
  const lim = Math.max(1, Math.min(Number(params.limit) || ITEM_LIMIT, 80));
  const today = formatLocalYmdFromDate(new Date());
  const idleCutoff = addDaysToYmd(today, -IDLE_DAYS);
  const wearSince = addDaysToYmd(today, -RECENT_WEAR_DAYS);

  const [stats, categories, itemsPage, outfitsRaw] = await Promise.all([
    getStatsSummary(),
    listCategories(),
    listItems({ status: 'active', limit: lim, offset: 0 }),
    listOutfits({ status: 'active' }),
  ]);

  const categoryNameById = new Map<string, string>();
  for (const c of categories) {
    const row = asRecord(c);
    if (!row || row.id == null) continue;
    categoryNameById.set(String(row.id), String(row.name ?? '').trim() || '分类');
  }
  const categoryNames = [...categoryNameById.values()].slice(0, 40);

  const items = (itemsPage.items || [])
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => !!row)
    .map((row) => trimItem(row, categoryNameById));

  const idleItems = (itemsPage.items || [])
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => !!row)
    .filter((row) => isIdle(row, idleCutoff))
    .slice(0, 20)
    .map((row) => trimItem(row, categoryNameById));

  const outfitsLimited = (outfitsRaw || []).slice(0, OUTFIT_LIMIT);
  const outfitIds = outfitsLimited
    .map((o) => asRecord(o)?.id)
    .filter((id): id is string | number => id != null)
    .map((id) => String(id));

  const outfitItemMap = new Map<string, string[]>();
  if (outfitIds.length > 0) {
    const placeholders = outfitIds.map(() => '?').join(',');
    const [linkRows] = await db.query<RowDataPacket[]>(
      `SELECT outfit_id, item_id FROM wardrobe_outfit_items
       WHERE outfit_id IN (${placeholders}) AND ${ACTIVE_SQL}
       ORDER BY sort_order ASC, created_at ASC`,
      outfitIds,
    );
    for (const link of linkRows) {
      const oid = String(link.outfit_id);
      const iid = String(link.item_id);
      const list = outfitItemMap.get(oid) || [];
      if (list.length < 12) list.push(iid);
      outfitItemMap.set(oid, list);
    }
  }

  const outfits = outfitsLimited
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => !!row)
    .map((row) => trimOutfit(row, outfitItemMap.get(String(row.id)) || []));

  const closetId = String(stats.closet_id || '');
  let recentlyWornItemIds: string[] = [];
  let recentlyWornOutfitIds: string[] = [];
  if (closetId) {
    const [wearRows] = await db.query<RowDataPacket[]>(
      `SELECT item_id, outfit_id FROM wardrobe_wear_logs
       WHERE closet_id = ? AND worn_on >= ? AND ${ACTIVE_SQL}
       ORDER BY worn_on DESC, created_at DESC
       LIMIT 80`,
      [closetId, wearSince],
    );
    const itemSeen = new Set<string>();
    const outfitSeen = new Set<string>();
    for (const row of wearRows) {
      if (row.item_id != null) {
        const id = String(row.item_id);
        if (!itemSeen.has(id)) {
          itemSeen.add(id);
          recentlyWornItemIds.push(id);
        }
      }
      if (row.outfit_id != null) {
        const id = String(row.outfit_id);
        if (!outfitSeen.has(id)) {
          outfitSeen.add(id);
          recentlyWornOutfitIds.push(id);
        }
      }
    }
    recentlyWornItemIds = recentlyWornItemIds.slice(0, 40);
    recentlyWornOutfitIds = recentlyWornOutfitIds.slice(0, 20);
  }

  return {
    domain: 'wardrobe',
    today_ymd: today,
    item_count: Number(stats.item_total) || itemsPage.total || items.length,
    outfit_count: (outfitsRaw || []).length,
    idle_count: idleItems.length,
    items,
    idle_items: idleItems,
    outfits,
    category_names: categoryNames,
    by_category: (stats.by_category || []).slice(0, 12).map((row) => ({
      category_id: String(row.category_id),
      category_name: String(row.category_name),
      item_count: Number(row.item_count) || 0,
    })),
    recently_worn_item_ids: recentlyWornItemIds,
    recently_worn_outfit_ids: recentlyWornOutfitIds,
    note: '衣橱只读摘要；推荐 id 须来自本列表；建单品/搭配需用户确认，助手不写库。',
  };
}
