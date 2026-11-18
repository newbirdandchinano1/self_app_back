/**
 * Agent 只读衣橱快照：单品/搭配/分类/衣橱/场合/选项/身材/周历（字段白名单）。
 * 挂载：GET /api/app/agent/snapshot/wardrobe
 */
import type { RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import {
  WardrobeError,
  listCategories,
  listItems,
  listOutfits,
  listClosets,
  listOccasions,
  listOptions,
  getBodyProfile,
  getWearWeek,
  getStatsSummary,
} from '../wardrobe.js';
import { addDaysToYmd, formatLocalYmdFromDate } from '../calendar/logical-day.js';

const ITEM_LIMIT = 80;
const OUTFIT_LIMIT = 40;
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
  const priceCents =
    row.price_cents == null || row.price_cents === ''
      ? null
      : Number(row.price_cents);
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
    price_cents: Number.isFinite(priceCents as number) ? priceCents : null,
    wear_count: Number(row.wear_count) || 0,
    last_worn_on: row.last_worn_on == null ? null : String(row.last_worn_on),
    purchased_on: row.purchased_on == null ? null : String(row.purchased_on),
    note: row.note == null ? null : String(row.note),
    created_at: row.created_at == null ? null : String(row.created_at),
    tags,
  };
}

function trimOutfit(
  row: Record<string, unknown>,
  itemIds: string[],
  occasionNameById: Map<string, string>,
) {
  const occasionId = row.occasion_id == null ? null : String(row.occasion_id);
  return {
    id: row.id == null ? null : String(row.id),
    name: String(row.name ?? '').trim() || '未命名搭配',
    occasion_id: occasionId,
    occasion: occasionId ? occasionNameById.get(occasionId) || null : null,
    wear_count: Number(row.wear_count) || 0,
    last_worn_on: row.last_worn_on == null ? null : String(row.last_worn_on),
    note: row.note == null ? null : String(row.note),
    created_at: row.created_at == null ? null : String(row.created_at),
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
  const lim = Math.max(1, Math.min(Number(params.limit) || ITEM_LIMIT, 100));
  const today = formatLocalYmdFromDate(new Date());
  const idleCutoff = addDaysToYmd(today, -IDLE_DAYS);
  const wearSince = addDaysToYmd(today, -RECENT_WEAR_DAYS);

  const [stats, categories, itemsPage, outfitsRaw, closets, occasions, options, bodyProfile, wearWeek] =
    await Promise.all([
      getStatsSummary(),
      listCategories(),
      listItems({ status: 'active', limit: lim, offset: 0 }),
      listOutfits({ status: 'active' }),
      listClosets().catch(() => []),
      listOccasions().catch(() => []),
      listOptions({}).catch(() => []),
      getBodyProfile().catch(() => null),
      getWearWeek().catch(() => null),
    ]);

  const categoryNameById = new Map<string, string>();
  const categoriesTrim = [];
  for (const c of categories) {
    const row = asRecord(c);
    if (!row || row.id == null) continue;
    const id = String(row.id);
    const name = String(row.name ?? '').trim() || '分类';
    categoryNameById.set(id, name);
    categoriesTrim.push({
      id,
      name,
      sort_order: Number(row.sort_order) || 0,
    });
  }
  const categoryNames = [...categoryNameById.values()].slice(0, 40);

  const occasionNameById = new Map<string, string>();
  const occasionsTrim = [];
  for (const o of occasions || []) {
    const row = asRecord(o);
    if (!row || row.id == null) continue;
    const id = String(row.id);
    const name = String(row.name ?? '').trim() || '场合';
    occasionNameById.set(id, name);
    occasionsTrim.push({ id, name });
  }

  const closetId = String(stats.closet_id || '');
  let closetItemCounts = new Map<string, number>();
  if ((closets || []).length > 0) {
    const [countRows] = await db.query<RowDataPacket[]>(
      `SELECT closet_id, COUNT(*) AS c FROM wardrobe_items
       WHERE ${ACTIVE_SQL} AND status = 'active'
       GROUP BY closet_id`,
    );
    closetItemCounts = new Map(
      countRows.map((r) => [String(r.closet_id), Number(r.c) || 0]),
    );
  }
  const closetsTrim = (closets || [])
    .map((c) => asRecord(c))
    .filter((row): row is Record<string, unknown> => !!row && row.id != null)
    .map((row) => {
      const id = String(row.id);
      return {
        id,
        name: String(row.name ?? '').trim() || '衣橱',
        is_default: Number(row.is_default) ? 1 : 0,
        item_count: closetItemCounts.get(id) || 0,
      };
    })
    .slice(0, 20);

  const optionsTrim = (options || [])
    .map((o) => asRecord(o))
    .filter((row): row is Record<string, unknown> => !!row && row.id != null)
    .slice(0, 80)
    .map((row) => ({
      id: String(row.id),
      kind: String(row.kind ?? ''),
      value: String(row.value ?? ''),
      is_builtin: Number(row.is_builtin) ? 1 : 0,
    }));

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
    .map((row) =>
      trimOutfit(row, outfitItemMap.get(String(row.id)) || [], occasionNameById),
    );

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

  const body = asRecord(bodyProfile);
  const bodyTrim = body
    ? {
        height_cm: body.height_cm == null ? null : Number(body.height_cm),
        weight_kg: body.weight_kg == null ? null : Number(body.weight_kg),
        shoulder_cm: body.shoulder_cm == null ? null : Number(body.shoulder_cm),
        bust_cm: body.bust_cm == null ? null : Number(body.bust_cm),
        waist_cm: body.waist_cm == null ? null : Number(body.waist_cm),
        hip_cm: body.hip_cm == null ? null : Number(body.hip_cm),
        inseam_cm: body.inseam_cm == null ? null : Number(body.inseam_cm),
        foot_mm: body.foot_mm == null ? null : Number(body.foot_mm),
        size_top: body.size_top == null ? null : String(body.size_top),
        size_bottom: body.size_bottom == null ? null : String(body.size_bottom),
        size_shoe: body.size_shoe == null ? null : String(body.size_shoe),
        note: body.note == null ? null : String(body.note),
      }
    : null;

  const wear = asRecord(wearWeek);
  const wearWeekTrim = wear
    ? {
        week_start: wear.week_start == null ? null : String(wear.week_start),
        week_end: wear.week_end == null ? null : String(wear.week_end),
        worn_days_this_week: Number(wear.worn_days_this_week) || 0,
        streak_days: Number(wear.streak_days) || 0,
        days: Array.isArray(wear.days)
          ? wear.days.slice(0, 7).map((d) => {
              const row = asRecord(d) || {};
              return {
                ymd: row.ymd == null ? null : String(row.ymd),
                worn: Boolean(row.worn),
              };
            })
          : [],
      }
    : null;

  return {
    domain: 'wardrobe',
    today_ymd: today,
    closet_id: closetId || null,
    item_count: Number(stats.item_total) || itemsPage.total || items.length,
    outfit_count: (outfitsRaw || []).length,
    idle_count: idleItems.length,
    items,
    idle_items: idleItems,
    outfits,
    categories: categoriesTrim.slice(0, 40),
    category_names: categoryNames,
    closets: closetsTrim,
    occasions: occasionsTrim.slice(0, 40),
    options: optionsTrim,
    body_profile: bodyTrim,
    wear_week: wearWeekTrim,
    by_category: (stats.by_category || []).slice(0, 12).map((row) => ({
      category_id: String(row.category_id),
      category_name: String(row.category_name),
      item_count: Number(row.item_count) || 0,
    })),
    by_season: Array.isArray(stats.by_season)
      ? stats.by_season.slice(0, 12).map((row: Record<string, unknown>) => ({
          season: String(row.season ?? ''),
          item_count: Number(row.item_count) || 0,
        }))
      : [],
    by_color: Array.isArray(stats.by_color)
      ? stats.by_color.slice(0, 12).map((row: Record<string, unknown>) => ({
          color: String(row.color ?? ''),
          item_count: Number(row.item_count) || 0,
        }))
      : [],
    recently_worn_item_ids: recentlyWornItemIds,
    recently_worn_outfit_ids: recentlyWornOutfitIds,
    note: '衣橱只读摘要；推荐 id 须来自本列表；建单品/搭配需用户确认，助手不写库。',
  };
}
