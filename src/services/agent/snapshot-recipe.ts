/**
 * Agent 只读菜谱库摘要：id + 名 + 主食材（限条）。
 * 挂载：GET /api/app/agent/snapshot/recipe
 */
import { listAllRecipeItems, RecipeError } from '../recipes.js';

const RECIPE_LIMIT = 40;
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

export async function getAgentRecipeSnapshot(params: AgentRecipeSnapshotParams = {}) {
  const lim = Math.max(1, Math.min(Number(params.limit) || RECIPE_LIMIT, 60));
  const items = await listAllRecipeItems({ parseJson: true });
  const list = (Array.isArray(items) ? items : []).slice(0, lim).map((row) => {
    const r = row as Record<string, unknown>;
    const ingredients = r.ingredients_json;
    return {
      id: r.id == null ? null : String(r.id),
      title: String(r.title ?? '').trim() || '未命名菜谱',
      category_id: r.category_id == null ? null : String(r.category_id),
      main_ingredients: mainIngredients(ingredients),
    };
  });

  return {
    domain: 'recipe',
    recipe_count: list.length,
    recipes: list,
    note: '菜谱库只读摘要；排餐/改写草稿需用户确认后写入，助手不写库。',
  };
}
