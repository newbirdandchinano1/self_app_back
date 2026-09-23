-- 周课程表（青蛙排程）
-- 全局轴存在 app_settings（key=@selfapp/frog_schedule_axis_v1）；
-- 历史周轴快照 + 占用实例见下表。

CREATE TABLE IF NOT EXISTS `schedule_week_axis_snapshot` (
  `week_start_ymd` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `start_minutes` int NOT NULL,
  `end_minutes` int NOT NULL,
  `slot_hours` int NOT NULL,
  `created_at` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `sync_status` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'synced',
  PRIMARY KEY (`week_start_ymd`) USING BTREE
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = DYNAMIC;

CREATE TABLE IF NOT EXISTS `schedule_placements` (
  `id` varchar(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `week_start_ymd` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `weekday` int NOT NULL,
  `start_slot_index` int NULL DEFAULT NULL,
  `span_slots` int NOT NULL DEFAULT 1,
  `subject_kind` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `subject_id` varchar(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `orphaned` int NOT NULL DEFAULT 0,
  `created_at` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `updated_at` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `sync_status` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'synced',
  PRIMARY KEY (`id`) USING BTREE,
  INDEX `idx_schedule_placements_week` (`week_start_ymd`, `weekday`) USING BTREE,
  INDEX `idx_schedule_placements_subject` (`subject_kind`, `subject_id`) USING BTREE
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = DYNAMIC;
