/**
 * 菜谱「厨房」域：菜单篮 / 用餐计划 / 采购清单 / 制作记录 / 厨房统计。
 * 数据落在 app_settings 语义键（与 App 端一致）+ recipe_items 制作计数；
 * 对外提供专用读写，供 Agent 代查与确认后写入对齐。
 */
import { randomUUID } from 'crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import { formatUtcMySQLDateTime } from './calendar/logical-day.js';
import { listAllRecipeItems, RecipeError, updateRecipe } from './recipes.js';
import type { SyncWriteOptions } from './sync-change-log.js';

export { RecipeError as RecipeKitchenError };

const KEYS = {
  mealPlan: '@selfapp/recipe_meal_plan_v1',
  shopList: '@selfapp/recipe_shop_list_v1',
  menuBasket: '@selfapp/recipe_menu_basket_v1',
  cookLogs: '@selfapp/recipe_cook_logs_v1',
} as const;

const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
type MealSlot = (typeof MEAL_SLOTS)[number];
type ShopStatus = 'todo' | 'stock' | 'bought';

type BasketItem = {
  recipeId: string;
  recipeTitle: string;
  categoryName: string;
  added_at: string;
};

type BasketStore = { version: 1; items: BasketItem[] };

type PlanEntry = {
  id: string;
  date: string;
  slot: MealSlot;
  recipeId: string;
  recipeTitle: string;
  created_at: string;
};

type PlanStore = { version: 1; entries: PlanEntry[] };

type ShopAddedRecipe = { recipeId: string; recipeTitle: string };
type ShopState = {
  version: 1;
  overrides: Record<string, ShopStatus>;
  addedRecipes: ShopAddedRecipe[];
  dismissedKeys: string[];
};

type CookLog = {
  id: string;
  recipeId: string;
  cookedAt: string;
  rating: number;
  note?: string;
};

type CookLogStore = { version: 1; logs: CookLog[] };

function nowIso(): string {
  return new Date().toISOString();
}

function asTrimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseJsonValue(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readSetting(key: string): Promise<unknown> {
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT value_json FROM app_settings WHERE `key` = ? LIMIT 1',
    [key],
  );
  return parseJsonValue(rows[0]?.value_json);
}

async function writeSetting(key: string, value: unknown): Promise<void> {
  const payload = JSON.stringify(value);
  const now = formatUtcMySQLDateTime(new Date());
  await db.query<ResultSetHeader>(
    `INSERT INTO app_settings (\`key\`, value_json, updated_at, sync_status)
     VALUES (?, ?, ?, 'synced')
     ON DUPLICATE KEY UPDATE
       value_json = VALUES(value_json),
       updated_at = VALUES(updated_at),
       sync_status = 'synced'`,
    [key, payload, now],
  );
}

function emptyBasket(): BasketStore {
  return { version: 1, items: [] };
}

function emptyPlan(): PlanStore {
  return { version: 1, entries: [] };
}

function emptyShop(): ShopState {
  return { version: 1, overrides: {}, addedRecipes: [], dismissedKeys: [] };
}

function emptyCookLogs(): CookLogStore {
  return { version: 1, logs: [] };
}

function parseBasket(raw: unknown): BasketStore {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyBasket();
  const o = raw as Record<string, unknown>;
  if (o.version !== 1 || !Array.isArray(o.items)) return emptyBasket();
  const items: BasketItem[] = [];
  const seen = new Set<string>();
  for (const row of o.items) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const recipeId = asTrimmed(r.recipeId);
    if (!recipeId || seen.has(recipeId)) continue;
    seen.add(recipeId);
    items.push({
      recipeId,
      recipeTitle: (asTrimmed(r.recipeTitle) || '未命名菜谱').slice(0, 80),
      categoryName: asTrimmed(r.categoryName).slice(0, 40),
      added_at: asTrimmed(r.added_at) || nowIso(),
    });
  }
  return { version: 1, items };
}

function parsePlan(raw: unknown): PlanStore {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyPlan();
  const o = raw as Record<string, unknown>;
  if (o.version !== 1 || !Array.isArray(o.entries)) return emptyPlan();
  const entries: PlanEntry[] = [];
  for (const row of o.entries) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = asTrimmed(r.id);
    const date = asTrimmed(r.date);
    const slot = asTrimmed(r.slot) as MealSlot;
    const recipeId = asTrimmed(r.recipeId);
    const recipeTitle = asTrimmed(r.recipeTitle);
    const created_at = asTrimmed(r.created_at);
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!MEAL_SLOTS.includes(slot)) continue;
    if (!recipeId || !recipeTitle || !created_at) continue;
    entries.push({ id, date, slot, recipeId, recipeTitle, created_at });
  }
  return { version: 1, entries };
}

function parseShop(raw: unknown): ShopState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyShop();
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return emptyShop();
  const overrides: Record<string, ShopStatus> = {};
  if (o.overrides && typeof o.overrides === 'object' && !Array.isArray(o.overrides)) {
    for (const [k, v] of Object.entries(o.overrides as Record<string, unknown>)) {
      if (v === 'todo' || v === 'stock' || v === 'bought') overrides[k] = v;
    }
  }
  const addedRecipes: ShopAddedRecipe[] = [];
  const seen = new Set<string>();
  if (Array.isArray(o.addedRecipes)) {
    for (const row of o.addedRecipes) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const recipeId = asTrimmed(r.recipeId);
      if (!recipeId || seen.has(recipeId)) continue;
      seen.add(recipeId);
      addedRecipes.push({
        recipeId,
        recipeTitle: (asTrimmed(r.recipeTitle) || '未命名菜谱').slice(0, 80),
      });
    }
  }
  const dismissedKeys = Array.isArray(o.dismissedKeys)
    ? o.dismissedKeys.map((k) => asTrimmed(k)).filter(Boolean)
    : [];
  return { version: 1, overrides, addedRecipes, dismissedKeys };
}

function clampRating(n: unknown): number | null {
  const v = typeof n === 'number' ? n : typeof n === 'string' ? Number(n) : NaN;
  if (!Number.isFinite(v)) return null;
  const r = Math.round(v);
  if (r < 1 || r > 5) return null;
  return r;
}

function parseCookLogs(raw: unknown): CookLogStore {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyCookLogs();
  const o = raw as Record<string, unknown>;
  if (o.version !== 1 || !Array.isArray(o.logs)) return emptyCookLogs();
  const logs: CookLog[] = [];
  for (const row of o.logs) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = asTrimmed(r.id);
    const recipeId = asTrimmed(r.recipeId);
    const cookedAt = asTrimmed(r.cookedAt);
    const rating = clampRating(r.rating);
    const note = asTrimmed(r.note);
    if (!id || !recipeId || !cookedAt || rating == null) continue;
    logs.push({
      id,
      recipeId,
      cookedAt,
      rating,
      ...(note ? { note: note.slice(0, 200) } : {}),
    });
  }
  return { version: 1, logs };
}

function localYmd(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function ymdFromIso(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return localYmd(d);
}

function isoInMonth(iso: string | undefined | null, year: number, monthIndex: number): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.getFullYear() === year && d.getMonth() === monthIndex;
}

function consecutiveCookStreak(lastCookedAts: Array<string | null | undefined>): number {
  const days = new Set<string>();
  for (const iso of lastCookedAts) {
    if (!iso) continue;
    const ymd = ymdFromIso(iso);
    if (ymd) days.add(ymd);
  }
  if (days.size === 0) return 0;
  const today = localYmd();
  const yDate = new Date();
  yDate.setDate(yDate.getDate() - 1);
  const yesterday = localYmd(yDate);
  let cursor = days.has(today) ? today : days.has(yesterday) ? yesterday : null;
  if (!cursor) return 0;
  let streak = 0;
  while (cursor && days.has(cursor)) {
    streak += 1;
    const d = new Date(`${cursor}T12:00:00`);
    d.setDate(d.getDate() - 1);
    cursor = localYmd(d);
  }
  return streak;
}

function ingredientsNonEmpty(ingredients: unknown): boolean {
  if (Array.isArray(ingredients)) return ingredients.length > 0;
  if (typeof ingredients === 'string') {
    try {
      const parsed = JSON.parse(ingredients);
      return Array.isArray(parsed) && parsed.length > 0;
    } catch {
      return ingredients.trim().length > 0;
    }
  }
  return false;
}

function stepsNonEmpty(steps: unknown): boolean {
  return ingredientsNonEmpty(steps);
}

function asMealSlot(raw: unknown): MealSlot | null {
  const s = asTrimmed(raw).toLowerCase();
  if (s === 'breakfast' || s === '早' || s === '早餐') return 'breakfast';
  if (s === 'lunch' || s === '午' || s === '午餐' || s === '中餐') return 'lunch';
  if (s === 'dinner' || s === '晚' || s === '晚餐') return 'dinner';
  if (s === 'snack' || s === '加餐' || s === '点心') return 'snack';
  return null;
}

function asShopStatus(raw: unknown): ShopStatus | null {
  const s = asTrimmed(raw).toLowerCase();
  if (s === 'todo' || s === '待采购' || s === '待买') return 'todo';
  if (s === 'stock' || s === '库存' || s === '已有库存' || s === '已有') return 'stock';
  if (s === 'bought' || s === '已采购' || s === '已买') return 'bought';
  return null;
}

function shopItemKey(name: string): string {
  return name.trim().toLowerCase();
}

// —— 厨房统计 ——

export async function getKitchenStats() {
  const [recipes, planRaw] = await Promise.all([
    listAllRecipeItems({ parseJson: true }),
    readSetting(KEYS.mealPlan),
  ]);
  const plan = parsePlan(planRaw);
  const now = new Date();
  const year = now.getFullYear();
  const monthIndex = now.getMonth();
  const monthPrefix = `${year}-${String(monthIndex + 1).padStart(2, '0')}-`;

  let organizedCount = 0;
  let cookedTotal = 0;
  let monthCooked = 0;
  let monthAdded = 0;
  const lastCookedAts: Array<string | null | undefined> = [];

  for (const row of recipes) {
    const r = row as Record<string, unknown>;
    if (ingredientsNonEmpty(r.ingredients_json) && stepsNonEmpty(r.steps_json)) {
      organizedCount += 1;
    }
    const times = Number(r.times_cooked ?? 0);
    cookedTotal += Number.isFinite(times) && times > 0 ? Math.floor(times) : 0;
    const lastCooked = r.last_cooked_at == null ? null : String(r.last_cooked_at);
    lastCookedAts.push(lastCooked);
    if (isoInMonth(lastCooked, year, monthIndex)) monthCooked += 1;
    const created = r.created_at == null ? null : String(r.created_at);
    if (isoInMonth(created, year, monthIndex)) monthAdded += 1;
  }

  const planDays = new Set(
    plan.entries.filter((e) => e.date.startsWith(monthPrefix)).map((e) => e.date),
  ).size;

  return {
    favorite_count: recipes.length,
    organized_count: organizedCount,
    cooked_total: cookedTotal,
    month_cooked: monthCooked,
    month_added: monthAdded,
    plan_days: planDays,
    cook_streak: consecutiveCookStreak(lastCookedAts),
  };
}

// —— 制作记录 ——

export async function listCookLogs(params?: { recipe_id?: string; limit?: number }) {
  const store = parseCookLogs(await readSetting(KEYS.cookLogs));
  const recipeId = asTrimmed(params?.recipe_id);
  let logs = store.logs;
  if (recipeId) logs = logs.filter((l) => l.recipeId === recipeId);
  logs = [...logs].sort((a, b) => b.cookedAt.localeCompare(a.cookedAt));
  const limit = Math.max(1, Math.min(Number(params?.limit) || 50, 200));
  const sliced = logs.slice(0, limit);
  const avg =
    sliced.length === 0
      ? null
      : Math.round((sliced.reduce((s, l) => s + l.rating, 0) / sliced.length) * 10) / 10;
  return {
    logs: sliced,
    count: sliced.length,
    average_rating: avg,
    times_logged: sliced.length,
  };
}

export async function getRecipeCookSummary(recipeIdRaw: unknown) {
  const recipeId = asTrimmed(recipeIdRaw);
  if (!recipeId) throw new RecipeError('recipe_id 不能为空');
  const detail = await listCookLogs({ recipe_id: recipeId, limit: 200 });
  const recipes = await listAllRecipeItems({ parseJson: false });
  const recipe = recipes.find((r) => String((r as { id: string }).id) === recipeId) as
    | Record<string, unknown>
    | undefined;
  return {
    recipe_id: recipeId,
    recipe_title: recipe ? String(recipe.title ?? '') : null,
    times_cooked: recipe ? Number(recipe.times_cooked ?? 0) : 0,
    last_cooked_at: recipe?.last_cooked_at ?? null,
    average_rating: detail.average_rating,
    log_count: detail.count,
    logs: detail.logs,
  };
}

export async function addCookLog(
  input: {
    recipe_id?: unknown;
    rating?: unknown;
    note?: unknown;
    cooked_at?: unknown;
  },
  options?: SyncWriteOptions,
) {
  const recipeId = asTrimmed(input.recipe_id);
  const rating = clampRating(input.rating);
  if (!recipeId) throw new RecipeError('recipe_id 不能为空');
  if (rating == null) throw new RecipeError('请选择 1～5 星评分');

  const store = parseCookLogs(await readSetting(KEYS.cookLogs));
  const note = asTrimmed(input.note);
  const cookedAt = asTrimmed(input.cooked_at) || nowIso();
  const entry: CookLog = {
    id: `rcook_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    recipeId,
    cookedAt,
    rating,
    ...(note ? { note: note.slice(0, 200) } : {}),
  };
  store.logs.push(entry);
  await writeSetting(KEYS.cookLogs, store);

  // 同步累加 recipe_items 制作次数（与 App recordRecipeCooked 对齐）
  try {
    const recipes = await listAllRecipeItems({ parseJson: false });
    const prev = recipes.find((r) => String((r as { id: string }).id) === recipeId) as
      | Record<string, unknown>
      | undefined;
    if (prev) {
      const times = Math.max(0, Number(prev.times_cooked ?? 0)) + 1;
      await updateRecipe(
        recipeId,
        {
          times_cooked: times,
          last_cooked_at: cookedAt,
        },
        options,
      );
    }
  } catch {
    /* 菜谱缺失时仍保留 log */
  }

  return entry;
}

export async function updateCookLogNote(input: {
  log_id?: unknown;
  recipe_id?: unknown;
  note?: unknown;
}) {
  const logId = asTrimmed(input.log_id);
  const recipeId = asTrimmed(input.recipe_id);
  const note = asTrimmed(input.note);
  if (!logId && !recipeId) throw new RecipeError('请指定 log_id 或 recipe_id');

  const store = parseCookLogs(await readSetting(KEYS.cookLogs));
  let target: CookLog | undefined;
  if (logId) {
    target = store.logs.find((l) => l.id === logId);
  } else {
    target = [...store.logs]
      .filter((l) => l.recipeId === recipeId)
      .sort((a, b) => b.cookedAt.localeCompare(a.cookedAt))[0];
  }
  if (!target) throw new RecipeError('找不到制作记录', 404);
  if (note) target.note = note.slice(0, 200);
  else delete target.note;
  await writeSetting(KEYS.cookLogs, store);
  return target;
}

// —— 菜单篮 ——

export async function getBasket() {
  const store = parseBasket(await readSetting(KEYS.menuBasket));
  return { items: store.items, count: store.items.length };
}

export async function addBasketItem(input: {
  recipe_id?: unknown;
  recipe_title?: unknown;
  category_name?: unknown;
}) {
  const recipeId = asTrimmed(input.recipe_id);
  if (!recipeId) throw new RecipeError('recipe_id 不能为空');
  const store = parseBasket(await readSetting(KEYS.menuBasket));
  const existing = store.items.find((i) => i.recipeId === recipeId);
  if (existing) return { item: existing, already_added: true };
  const item: BasketItem = {
    recipeId,
    recipeTitle: (asTrimmed(input.recipe_title) || '未命名菜谱').slice(0, 80),
    categoryName: asTrimmed(input.category_name).slice(0, 40),
    added_at: nowIso(),
  };
  store.items.push(item);
  await writeSetting(KEYS.menuBasket, store);
  return { item, already_added: false };
}

export async function removeBasketItem(recipeIdRaw: unknown) {
  const recipeId = asTrimmed(recipeIdRaw);
  if (!recipeId) throw new RecipeError('recipe_id 不能为空');
  const store = parseBasket(await readSetting(KEYS.menuBasket));
  const next = store.items.filter((i) => i.recipeId !== recipeId);
  if (next.length === store.items.length) throw new RecipeError('菜单篮中没有该菜谱', 404);
  await writeSetting(KEYS.menuBasket, { version: 1, items: next });
  return { removed: true, recipe_id: recipeId, count: next.length };
}

export async function clearBasket() {
  await writeSetting(KEYS.menuBasket, emptyBasket());
  return { cleared: true, count: 0 };
}

// —— 用餐计划 ——

export async function listPlanEntries(params?: {
  date?: string;
  from?: string;
  to?: string;
  limit?: number;
}) {
  const store = parsePlan(await readSetting(KEYS.mealPlan));
  let entries = [...store.entries];
  const date = asTrimmed(params?.date);
  const from = asTrimmed(params?.from);
  const to = asTrimmed(params?.to);
  if (date) entries = entries.filter((e) => e.date === date);
  if (from) entries = entries.filter((e) => e.date >= from);
  if (to) entries = entries.filter((e) => e.date <= to);
  entries.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.created_at.localeCompare(b.created_at);
  });
  const limit = Math.max(1, Math.min(Number(params?.limit) || 100, 300));
  const sliced = entries.slice(0, limit);
  const planned_dates = [...new Set(sliced.map((e) => e.date))];
  return { entries: sliced, count: sliced.length, planned_dates };
}

export async function addPlanEntry(input: {
  date?: unknown;
  slot?: unknown;
  recipe_id?: unknown;
  recipe_title?: unknown;
}) {
  const date = asTrimmed(input.date);
  const slot = asMealSlot(input.slot);
  const recipeId = asTrimmed(input.recipe_id);
  const recipeTitle = (asTrimmed(input.recipe_title) || '未命名菜谱').slice(0, 80);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RecipeError('date 须为 YYYY-MM-DD');
  if (!slot) throw new RecipeError('slot 无效（breakfast/lunch/dinner/snack）');
  if (!recipeId) throw new RecipeError('recipe_id 不能为空');

  const store = parsePlan(await readSetting(KEYS.mealPlan));
  const dup = store.entries.find(
    (e) => e.date === date && e.slot === slot && e.recipeId === recipeId,
  );
  if (dup) return { entry: dup, already_added: true };

  const entry: PlanEntry = {
    id: `rplan_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    date,
    slot,
    recipeId,
    recipeTitle,
    created_at: nowIso(),
  };
  store.entries.push(entry);
  await writeSetting(KEYS.mealPlan, store);
  return { entry, already_added: false };
}

export async function removePlanEntry(idRaw: unknown) {
  const id = asTrimmed(idRaw);
  if (!id) throw new RecipeError('id 不能为空');
  const store = parsePlan(await readSetting(KEYS.mealPlan));
  const next = store.entries.filter((e) => e.id !== id);
  if (next.length === store.entries.length) throw new RecipeError('计划条目不存在', 404);
  await writeSetting(KEYS.mealPlan, { version: 1, entries: next });
  return { removed: true, id };
}

// —— 采购清单 ——

export async function getShopState() {
  const state = parseShop(await readSetting(KEYS.shopList));
  return {
    added_recipes: state.addedRecipes,
    overrides: state.overrides,
    dismissed_keys: state.dismissedKeys,
    added_count: state.addedRecipes.length,
  };
}

export async function addShopRecipe(input: {
  recipe_id?: unknown;
  recipe_title?: unknown;
}) {
  const recipeId = asTrimmed(input.recipe_id);
  if (!recipeId) throw new RecipeError('recipe_id 不能为空');
  const state = parseShop(await readSetting(KEYS.shopList));
  if (state.addedRecipes.some((r) => r.recipeId === recipeId)) {
    return {
      already_added: true,
      recipe_id: recipeId,
      added_count: state.addedRecipes.length,
    };
  }
  state.addedRecipes.push({
    recipeId,
    recipeTitle: (asTrimmed(input.recipe_title) || '未命名菜谱').slice(0, 80),
  });
  await writeSetting(KEYS.shopList, state);
  return { already_added: false, recipe_id: recipeId, added_count: state.addedRecipes.length };
}

export async function setShopItemStatus(input: {
  key?: unknown;
  keys?: unknown;
  status?: unknown;
}) {
  const status = asShopStatus(input.status);
  if (!status) throw new RecipeError('status 须为 todo/stock/bought');
  const keys: string[] = [];
  const one = asTrimmed(input.key);
  if (one) keys.push(shopItemKey(one));
  if (Array.isArray(input.keys)) {
    for (const k of input.keys) {
      const t = asTrimmed(k);
      if (t) keys.push(shopItemKey(t));
    }
  }
  if (keys.length === 0) throw new RecipeError('请指定 key 或 keys');
  const state = parseShop(await readSetting(KEYS.shopList));
  for (const k of keys) state.overrides[k] = status;
  await writeSetting(KEYS.shopList, state);
  return { updated: keys, status, overrides: state.overrides };
}

export async function dismissShopItems(input: { key?: unknown; keys?: unknown }) {
  const keys: string[] = [];
  const one = asTrimmed(input.key);
  if (one) keys.push(shopItemKey(one));
  if (Array.isArray(input.keys)) {
    for (const k of input.keys) {
      const t = asTrimmed(k);
      if (t) keys.push(shopItemKey(t));
    }
  }
  if (keys.length === 0) throw new RecipeError('请指定 key 或 keys');
  const state = parseShop(await readSetting(KEYS.shopList));
  const dismissed = new Set(state.dismissedKeys);
  for (const k of keys) {
    dismissed.add(k);
    delete state.overrides[k];
  }
  state.dismissedKeys = [...dismissed];
  await writeSetting(KEYS.shopList, state);
  return { dismissed: keys, dismissed_keys: state.dismissedKeys };
}

export async function clearShop(input?: { dismiss_keys?: unknown }) {
  const prev = parseShop(await readSetting(KEYS.shopList));
  const next = emptyShop();
  const dismissed = new Set(prev.dismissedKeys);
  if (Array.isArray(input?.dismiss_keys)) {
    for (const k of input!.dismiss_keys) {
      const t = asTrimmed(k);
      if (t) dismissed.add(shopItemKey(t));
    }
  }
  next.dismissedKeys = [...dismissed];
  await writeSetting(KEYS.shopList, next);
  return { cleared: true, dismissed_keys: next.dismissedKeys };
}

/** 菜单篮 → 采购：把篮内菜谱写入采购 addedRecipes */
export async function basketToShop() {
  const basket = parseBasket(await readSetting(KEYS.menuBasket));
  if (basket.items.length === 0) {
    return { added: 0, already: 0, added_recipes: [] as ShopAddedRecipe[] };
  }
  const state = parseShop(await readSetting(KEYS.shopList));
  const seen = new Set(state.addedRecipes.map((r) => r.recipeId));
  let added = 0;
  let already = 0;
  for (const item of basket.items) {
    if (seen.has(item.recipeId)) {
      already += 1;
      continue;
    }
    state.addedRecipes.push({
      recipeId: item.recipeId,
      recipeTitle: item.recipeTitle,
    });
    seen.add(item.recipeId);
    added += 1;
  }
  await writeSetting(KEYS.shopList, state);
  return { added, already, added_recipes: state.addedRecipes };
}

/** 菜单篮 → 计划：把篮内菜谱写入某日某餐次 */
export async function basketToPlan(input: { date?: unknown; slot?: unknown }) {
  const date = asTrimmed(input.date) || localYmd();
  const slot = asMealSlot(input.slot) || 'dinner';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RecipeError('date 须为 YYYY-MM-DD');
  const basket = parseBasket(await readSetting(KEYS.menuBasket));
  if (basket.items.length === 0) {
    return { added: 0, already: 0, entries: [] as PlanEntry[] };
  }
  const store = parsePlan(await readSetting(KEYS.mealPlan));
  let added = 0;
  let already = 0;
  const created: PlanEntry[] = [];
  for (const item of basket.items) {
    const dup = store.entries.find(
      (e) => e.date === date && e.slot === slot && e.recipeId === item.recipeId,
    );
    if (dup) {
      already += 1;
      continue;
    }
    const entry: PlanEntry = {
      id: `rplan_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      date,
      slot,
      recipeId: item.recipeId,
      recipeTitle: item.recipeTitle,
      created_at: nowIso(),
    };
    store.entries.push(entry);
    created.push(entry);
    added += 1;
  }
  await writeSetting(KEYS.mealPlan, store);
  return { added, already, entries: created, date, slot };
}
