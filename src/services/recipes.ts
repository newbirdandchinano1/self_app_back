import { randomUUID } from 'crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import {
  formatDbDateTimeForApi,
  formatRecordDateTimesForApi,
  formatUtcMySQLDateTime,
} from './calendar/logical-day.js';

export class RecipeError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'RecipeError';
  }
}

/** 软删口径：migration 001 已去掉 deleted_at/version，改用 sync_status */
const ACTIVE_RECIPE_SQL = `(sync_status IS NULL OR sync_status != 'pending_delete')`;

type CategoryRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  sync_status: string;
};

type RecipeRow = {
  id: string;
  category_id: string;
  title: string;
  ingredients_json: string;
  steps_json: string;
  notes: string | null;
  finished_image_uri: string | null;
  created_at: string;
  updated_at: string;
  sync_status: string;
};

function nowUtcMysql(): string {
  return formatUtcMySQLDateTime(new Date());
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toJsonText(value: unknown, fieldName: string): string {
  if (value == null) {
    throw new RecipeError(`${fieldName} 不能为空`);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) throw new RecipeError(`${fieldName} 不能为空`);
    try {
      JSON.parse(trimmed);
    } catch {
      throw new RecipeError(`${fieldName} 必须是合法 JSON`);
    }
    return trimmed;
  }
  try {
    return JSON.stringify(value);
  } catch {
    throw new RecipeError(`${fieldName} 无法序列化为 JSON`);
  }
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

function formatCategory(row: CategoryRow) {
  return formatRecordDateTimesForApi(
    {
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      updated_at: row.updated_at,
      sync_status: row.sync_status,
      version: 1,
    },
    'recipe_categories',
  );
}

function formatRecipe(row: RecipeRow, { parseJson = true }: { parseJson?: boolean } = {}) {
  const base = formatRecordDateTimesForApi(
    {
      id: row.id,
      category_id: row.category_id,
      title: row.title,
      ingredients_json: parseJson ? parseJsonField(row.ingredients_json) : row.ingredients_json,
      steps_json: parseJson ? parseJsonField(row.steps_json) : row.steps_json,
      notes: row.notes,
      finished_image_uri: row.finished_image_uri,
      created_at: row.created_at,
      updated_at: row.updated_at,
      sync_status: row.sync_status,
      version: 1,
    },
    'recipe_items',
  );
  return base;
}

async function getActiveCategory(id: string): Promise<CategoryRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, name, created_at, updated_at, sync_status
     FROM recipe_categories
     WHERE id = ? AND ${ACTIVE_RECIPE_SQL}
     LIMIT 1`,
    [id],
  );
  return (rows[0] as CategoryRow | undefined) ?? null;
}

async function getActiveRecipe(id: string): Promise<RecipeRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, category_id, title, ingredients_json, steps_json, notes,
            finished_image_uri, created_at, updated_at, sync_status
     FROM recipe_items
     WHERE id = ? AND ${ACTIVE_RECIPE_SQL}
     LIMIT 1`,
    [id],
  );
  return (rows[0] as RecipeRow | undefined) ?? null;
}

/** 获取全部分类 */
export async function listRecipeCategories() {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, name, created_at, updated_at, sync_status
     FROM recipe_categories
     WHERE ${ACTIVE_RECIPE_SQL}
     ORDER BY created_at ASC, id ASC`,
  );
  return (rows as CategoryRow[]).map(formatCategory);
}

/** 分类数量 */
export async function countRecipeCategories(): Promise<{ count: number }> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM recipe_categories WHERE ${ACTIVE_RECIPE_SQL}`,
  );
  return { count: Number(rows[0]?.count ?? 0) };
}

/** 菜谱数量 */
export async function countRecipes(): Promise<{ count: number }> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM recipe_items WHERE ${ACTIVE_RECIPE_SQL}`,
  );
  return { count: Number(rows[0]?.count ?? 0) };
}

/** 指定分类下的全部菜谱 */
export async function listRecipesByCategory(categoryId: string) {
  const id = categoryId.trim();
  if (!id) throw new RecipeError('categoryId 不能为空');

  const category = await getActiveCategory(id);
  if (!category) throw new RecipeError('分类不存在', 404);

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, category_id, title, ingredients_json, steps_json, notes,
            finished_image_uri, created_at, updated_at, sync_status
     FROM recipe_items
     WHERE category_id = ? AND ${ACTIVE_RECIPE_SQL}
     ORDER BY created_at ASC, id ASC`,
    [id],
  );

  return {
    category: formatCategory(category),
    items: (rows as RecipeRow[]).map((row) => formatRecipe(row)),
  };
}

/** 全部菜谱扁平列表（与分类列表同口径；profile 聚合与领域接口同源） */
export async function listAllRecipeItems(opts?: { parseJson?: boolean }) {
  const parseJson = opts?.parseJson !== false;
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, category_id, title, ingredients_json, steps_json, notes,
            finished_image_uri, created_at, updated_at, sync_status
     FROM recipe_items
     WHERE ${ACTIVE_RECIPE_SQL}
     ORDER BY created_at ASC, id ASC`,
  );
  return (rows as RecipeRow[]).map((row) => formatRecipe(row, { parseJson }));
}

/** 每个分类及其下全部菜谱 */
export async function listRecipesGroupedByCategory() {
  const categories = await listRecipeCategories();
  const items = await listAllRecipeItems();

  const byCategory = new Map<string, ReturnType<typeof formatRecipe>[]>();
  for (const item of items) {
    const categoryId = String((item as { category_id: string }).category_id);
    const list = byCategory.get(categoryId) ?? [];
    list.push(item);
    byCategory.set(categoryId, list);
  }

  return categories.map((category) => ({
    category,
    items: byCategory.get(String((category as { id: string }).id)) ?? [],
  }));
}

/** 菜谱详情 */
export async function getRecipeDetail(recipeId: string) {
  const id = recipeId.trim();
  if (!id) throw new RecipeError('id 不能为空');

  const recipe = await getActiveRecipe(id);
  if (!recipe) throw new RecipeError('菜谱不存在', 404);

  const category = await getActiveCategory(recipe.category_id);
  return {
    ...formatRecipe(recipe),
    category: category ? formatCategory(category) : null,
  };
}

/** 新建分类 */
export async function createRecipeCategory(input: { id?: unknown; name: unknown }) {
  const name = asTrimmedString(input.name);
  if (!name) throw new RecipeError('name 不能为空');

  const id = asTrimmedString(input.id) || randomUUID();
  const now = nowUtcMysql();

  try {
    await db.query(
      `INSERT INTO recipe_categories
         (id, name, created_at, updated_at, sync_status)
       VALUES (?, ?, ?, ?, 'synced')`,
      [id, name, now, now],
    );
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      throw new RecipeError('分类已存在', 409);
    }
    throw err;
  }

  const created = await getActiveCategory(id);
  if (!created) throw new RecipeError('创建分类失败', 500);
  return formatCategory(created);
}

/** 修改分类名称 */
export async function renameRecipeCategory(categoryId: string, nameRaw: unknown) {
  const id = categoryId.trim();
  if (!id) throw new RecipeError('id 不能为空');

  const name = asTrimmedString(nameRaw);
  if (!name) throw new RecipeError('name 不能为空');

  const existing = await getActiveCategory(id);
  if (!existing) throw new RecipeError('分类不存在', 404);

  const now = nowUtcMysql();
  await db.query(
    `UPDATE recipe_categories
     SET name = ?, updated_at = ?, sync_status = 'synced'
     WHERE id = ? AND ${ACTIVE_RECIPE_SQL}`,
    [name, now, id],
  );

  const updated = await getActiveCategory(id);
  if (!updated) throw new RecipeError('分类不存在', 404);
  return formatCategory(updated);
}

/** 删除分类（软删，并级联软删其下菜谱） */
export async function deleteRecipeCategory(categoryId: string) {
  const id = categoryId.trim();
  if (!id) throw new RecipeError('id 不能为空');

  const existing = await getActiveCategory(id);
  if (!existing) throw new RecipeError('分类不存在', 404);

  const now = nowUtcMysql();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE recipe_items
       SET sync_status = 'pending_delete', updated_at = ?
       WHERE category_id = ? AND ${ACTIVE_RECIPE_SQL}`,
      [now, id],
    );
    const [result] = await conn.query<ResultSetHeader>(
      `UPDATE recipe_categories
       SET sync_status = 'pending_delete', updated_at = ?
       WHERE id = ? AND ${ACTIVE_RECIPE_SQL}`,
      [now, id],
    );
    await conn.commit();
    if (result.affectedRows === 0) throw new RecipeError('分类不存在', 404);
    return { id, deleted_at: formatDbDateTimeForApi(now, 'utc') ?? now };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export type CreateRecipeInput = {
  id?: unknown;
  category_id: unknown;
  title?: unknown;
  ingredients_json: unknown;
  steps_json: unknown;
  notes?: unknown;
  finished_image_uri?: unknown;
};

/** 新建菜谱 */
export async function createRecipe(input: CreateRecipeInput) {
  const categoryId = asTrimmedString(input.category_id);
  if (!categoryId) throw new RecipeError('category_id 不能为空');

  const category = await getActiveCategory(categoryId);
  if (!category) throw new RecipeError('分类不存在', 404);

  const title = asTrimmedString(input.title);
  const ingredientsJson = toJsonText(input.ingredients_json, 'ingredients_json');
  const stepsJson = toJsonText(input.steps_json, 'steps_json');
  const notes = input.notes == null ? null : asTrimmedString(input.notes) || null;
  const finishedImageUri =
    input.finished_image_uri == null ? null : asTrimmedString(input.finished_image_uri) || null;

  const id = asTrimmedString(input.id) || randomUUID();
  const now = nowUtcMysql();

  try {
    await db.query(
      `INSERT INTO recipe_items
         (id, category_id, title, ingredients_json, steps_json, notes,
          finished_image_uri, created_at, updated_at, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')`,
      [id, categoryId, title, ingredientsJson, stepsJson, notes, finishedImageUri, now, now],
    );
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      throw new RecipeError('菜谱已存在', 409);
    }
    throw err;
  }

  const created = await getActiveRecipe(id);
  if (!created) throw new RecipeError('创建菜谱失败', 500);
  return formatRecipe(created);
}

export type UpdateRecipeInput = {
  category_id?: unknown;
  title?: unknown;
  ingredients_json?: unknown;
  steps_json?: unknown;
  notes?: unknown;
  finished_image_uri?: unknown;
};

/** 编辑菜谱 */
export async function updateRecipe(recipeId: string, input: UpdateRecipeInput) {
  const id = recipeId.trim();
  if (!id) throw new RecipeError('id 不能为空');

  const existing = await getActiveRecipe(id);
  if (!existing) throw new RecipeError('菜谱不存在', 404);

  const updates: string[] = [];
  const values: unknown[] = [];

  if (input.category_id !== undefined) {
    const categoryId = asTrimmedString(input.category_id);
    if (!categoryId) throw new RecipeError('category_id 不能为空');
    const category = await getActiveCategory(categoryId);
    if (!category) throw new RecipeError('分类不存在', 404);
    updates.push('category_id = ?');
    values.push(categoryId);
  }
  if (input.title !== undefined) {
    updates.push('title = ?');
    values.push(asTrimmedString(input.title));
  }
  if (input.ingredients_json !== undefined) {
    updates.push('ingredients_json = ?');
    values.push(toJsonText(input.ingredients_json, 'ingredients_json'));
  }
  if (input.steps_json !== undefined) {
    updates.push('steps_json = ?');
    values.push(toJsonText(input.steps_json, 'steps_json'));
  }
  if (input.notes !== undefined) {
    updates.push('notes = ?');
    values.push(input.notes == null ? null : asTrimmedString(input.notes) || null);
  }
  if (input.finished_image_uri !== undefined) {
    updates.push('finished_image_uri = ?');
    values.push(
      input.finished_image_uri == null
        ? null
        : asTrimmedString(input.finished_image_uri) || null,
    );
  }

  if (updates.length === 0) throw new RecipeError('没有可更新的字段');

  const now = nowUtcMysql();
  updates.push('updated_at = ?', `sync_status = 'synced'`);
  values.push(now, id);

  const [result] = await db.query<ResultSetHeader>(
    `UPDATE recipe_items
     SET ${updates.join(', ')}
     WHERE id = ? AND ${ACTIVE_RECIPE_SQL}`,
    values,
  );
  if (result.affectedRows === 0) throw new RecipeError('菜谱不存在', 404);

  const updated = await getActiveRecipe(id);
  if (!updated) throw new RecipeError('菜谱不存在', 404);
  return formatRecipe(updated);
}

/** 删除菜谱（软删：sync_status=pending_delete） */
export async function deleteRecipe(recipeId: string) {
  const id = recipeId.trim();
  if (!id) throw new RecipeError('id 不能为空');

  const existing = await getActiveRecipe(id);
  if (!existing) throw new RecipeError('菜谱不存在', 404);

  const now = nowUtcMysql();
  const [result] = await db.query<ResultSetHeader>(
    `UPDATE recipe_items
     SET sync_status = 'pending_delete', updated_at = ?
     WHERE id = ? AND ${ACTIVE_RECIPE_SQL}`,
    [now, id],
  );
  if (result.affectedRows === 0) throw new RecipeError('菜谱不存在', 404);

  return { id, deleted_at: formatDbDateTimeForApi(now, 'utc') ?? now };
}
