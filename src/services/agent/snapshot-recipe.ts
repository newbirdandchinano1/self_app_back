/**
 * Agent 只读菜谱库摘要：分类 + 菜谱 + 厨房统计/菜单篮/计划/采购/制作记录。
 * 挂载：GET /api/app/agent/snapshot/recipe
 */
import { listAllRecipeItems, listRecipeCategories, RecipeError } from '../recipes.js';
import {
  getBasket,
  getKitchenStats,
  getShopState,
  listCookLogs,
  listPlanEntries,
} from '../recipe-kitchen.js';

const RECIPE_LIMIT = 40;
const CATEGORY_LIMIT = 40;
const INGREDIENT_LIMIT = 6;

export type AgentRecipeSnapshotParams = {
  limit?: number;
};

export { RecipeError as RecipeSnapshotError };

function mainIngredients(ingredients: unknown): string[] {
  if (!Array.isArray(ingredients)) return [];
  const out: string[] = [];
  for (const row of ingredients) {
    if (typeof row === 'string' && row.trim()) {
      out.push(row.trim());
    } else if (row && typeof row === 'object') {
      const name = (row as Record<string, unknown>).name ?? (row as Record<string, unknown>).title;
      if (typeof name === 'string' && name.trim()) out.push(name.trim());
    }
    if (out.length >= INGREDIENT_LIMIT) break;
  }
  return out;
}

function nonEmptyCount(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  let n = 0;
  for (const row of raw) {
    if (typeof row === 'string' && row.trim()) n += 1;
    else if (row && typeof row === 'object') n += 1;
  }
  return n;
}

/** 步骤文案拼接，供 Agent 按步骤关键词搜索（截断，避免撑爆快照）。 */
function stepsBlob(steps: unknown): string {
  if (!Array.isArray(steps)) return '';
  const parts: string[] = [];
  let len = 0;
  for (const row of steps) {
    let text = '';
    if (typeof row === 'string') text = row.trim();
    else if (row && typeof row === 'object') {
      const o = row as Record<string, unknown>;
      const t = o.text ?? o.content ?? o.step;
      if (typeof t === 'string') text = t.trim();
    }
    if (!text) continue;
    parts.push(text);
    len += text.length + 1;
    if (len >= 400) break;
  }
  return parts.join(' ').slice(0, 400);
}

export async function getAgentRecipeSnapshot(params: AgentRecipeSnapshotParams = {}) {
  const lim = Math.max(1, Math.min(Number(params.limit) || RECIPE_LIMIT, 60));
  const [categoryRows, items, kitchen, basket, plan, shop, cookLogs] = await Promise.all([
    listRecipeCategories(),
    listAllRecipeItems({ parseJson: true }),
    getKitchenStats(),
    getBasket(),
    listPlanEntries({ limit: 40 }),
    getShopState(),
    listCookLogs({ limit: 20 }),
  ]);
  const categories = (Array.isArray(categoryRows) ? categoryRows : [])
    .slice(0, CATEGORY_LIMIT)
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: r.id == null ? null : String(r.id),
        name: String(r.name ?? '').trim() || '未命名分类',
      };
    });
  const catNameById = new Map(
    categories
      .filter((c) => c.id)
      .map((c) => [String(c.id), c.name] as const),
  );
  const list = (Array.isArray(items) ? items : []).slice(0, lim).map((row) => {
    const r = row as Record<string, unknown>;
    const ingredients = r.ingredients_json;
    const steps = r.steps_json;
    const categoryId = r.category_id == null ? null : String(r.category_id);
    const ingCount = nonEmptyCount(ingredients);
    const stepCount = nonEmptyCount(steps);
    const imageUri =
      r.finished_image_uri == null ? '' : String(r.finished_image_uri).trim();
    return {
      id: r.id == null ? null : String(r.id),
      title: String(r.title ?? '').trim() || '未命名菜谱',
      category_id: categoryId,
      category_name: categoryId ? catNameById.get(categoryId) ?? null : null,
      main_ingredients: mainIngredients(ingredients),
      times_cooked: Number(r.times_cooked ?? 0) || 0,
      last_cooked_at: r.last_cooked_at == null ? null : String(r.last_cooked_at),
      created_at: r.created_at == null ? null : String(r.created_at),
      updated_at: r.updated_at == null ? null : String(r.updated_at),
      has_finished_image: !!imageUri,
      has_ingredients: ingCount > 0,
      has_steps: stepCount > 0,
      steps_blob: stepsBlob(steps),
    };
  });

  return {
    domain: 'recipe',
    recipe_count: list.length,
    category_count: categories.length,
    categories,
    recipes: list,
    kitchen_stats: kitchen,
    basket: {
      count: basket.count,
      items: basket.items.slice(0, 30).map((i) => ({
        recipe_id: i.recipeId,
        recipe_title: i.recipeTitle,
        category_name: i.categoryName || null,
      })),
    },
    plan: {
      count: plan.count,
      planned_dates: plan.planned_dates.slice(0, 31),
      entries: plan.entries.slice(0, 40).map((e) => ({
        id: e.id,
        date: e.date,
        slot: e.slot,
        recipe_id: e.recipeId,
        recipe_title: e.recipeTitle,
      })),
    },
    shop: {
      added_count: shop.added_count,
      added_recipes: shop.added_recipes.slice(0, 30).map((r) => ({
        recipe_id: r.recipeId,
        recipe_title: r.recipeTitle,
      })),
      override_count: Object.keys(shop.overrides).length,
      dismissed_count: shop.dismissed_keys.length,
      item_count: shop.item_count,
      todo_count: shop.todo_count,
      stock_count: shop.stock_count,
      bought_count: shop.bought_count,
      /** 完整可见采购项（含待购/库存/已购）；Agent 可直接回答「还要买什么」 */
      items: shop.items.slice(0, 120).map((i) => ({
        key: i.key,
        name: i.name,
        amount: i.amount,
        status: i.status,
        is_common_seasoning: i.is_common_seasoning,
        recipe_titles: i.recipe_titles.slice(0, 4),
      })),
      todo_items: shop.todo_items.slice(0, 80).map((i) => ({
        key: i.key,
        name: i.name,
        amount: i.amount,
        recipe_titles: i.recipe_titles.slice(0, 4),
      })),
    },
    cook_logs: {
      count: cookLogs.count,
      average_rating: cookLogs.average_rating,
      recent: cookLogs.logs.slice(0, 20).map((l) => ({
        id: l.id,
        recipe_id: l.recipeId,
        cooked_at: l.cookedAt,
        rating: l.rating,
        note: l.note ?? null,
      })),
    },
    note: '菜谱库只读摘要（含厨房统计/菜单篮/计划/采购/制作记录）；写操作需用户确认后由助手 commit。',
  };
}
