-- 移除 deleted_at、version 列（全库业务表，保留 seed_version 等业务字段）
-- 执行前请备份数据库。可重复执行：仅当列存在时才会 DROP（见 scripts/drop-deleted-at-version.mjs）

-- habit_check_ins 上 deleted_at 有独立索引，需先删索引
ALTER TABLE `habit_check_ins` DROP INDEX `idx_habit_check_ins_deleted_at`;
