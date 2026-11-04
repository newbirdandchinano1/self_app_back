import { columnExists, ensureColumn, tableExists } from './schema-helpers.js';

/**
 * 幂等：recipe_items 表补齐「制作统计」两列（times_cooked / last_cooked_at）。
 *
 * 旧库建表早于该功能，物理表缺少这两列；而 recipes 领域接口的 SELECT/INSERT/UPDATE
 * 硬编码了列名，缺列会抛 `ER_BAD_FIELD_ERROR: Unknown column` 导致 500
 * （/recipes/categories/with-items、/recipes/:id、/pages/profile/recipes 等全部菜谱页）。
 * 与 `数据库/alter_recipe_items_cook_stats.sql`、`数据库/self_app.sql` 保持一致。
 */
export async function ensureRecipeCookStatsColumns(): Promise<void> {
  if (!(await tableExists('recipe_items'))) return;

  const after = (await columnExists('recipe_items', 'finished_image_uri'))
    ? 'finished_image_uri'
    : undefined;

  await ensureColumn('recipe_items', 'times_cooked', 'int NOT NULL DEFAULT 0', { after });
  await ensureColumn(
    'recipe_items',
    'last_cooked_at',
    'varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL',
    { after: 'times_cooked' },
  );
}
