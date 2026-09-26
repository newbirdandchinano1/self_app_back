# 已归档的一次性 DB 脚本

这些脚本的逻辑已迁入 `src/db/migrations/`（启动时按 `schema_migrations` 版本执行一次）。

| 原脚本 | 对应 migration |
|--------|----------------|
| `drop-deleted-at-version.mjs` | `001_drop_deleted_at_version` |
| `add-projects-priority.mjs` | `002_projects_priority` |
| `ensure-frog-schedule-once.mjs` | `011_frog_schedule` |

勿再挂回 `package.json`；新环境只需启动后端即可。
