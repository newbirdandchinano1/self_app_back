/**
 * Schema 迁移（版本表 `schema_migrations`）。
 *
 * - 新 DDL / 一次性 DROP：在 `registry.ts` **追加** 一条 `{ id, up }`，勿改已发布 id。
 * - 通用探测用 `../schema-helpers.ts`（`ensureColumn` 等）。
 * - 启动路径：`runPendingMigrations()`（见 `src/index.ts`）；已应用的不再执行。
 * - `ensure-project-tags` / `ensure-frog-schedule` 仍可被 CRUD 热补丁按需调用。
 */
export { runPendingMigrations } from './runner.js';
export { MIGRATIONS } from './registry.js';
export type { Migration } from './types.js';
