-- 本周任务表：时段 + 格子内容
-- 与 App SQLite weekly_task_schedule_slots / weekly_task_schedule_cells 对齐
-- 执行前请备份数据库

CREATE TABLE IF NOT EXISTS `weekly_task_schedule_slots` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `start_hour` tinyint NOT NULL,
  `end_hour` tinyint NOT NULL,
  `sort_order` int NOT NULL DEFAULT 1000,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `sync_status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending_create',
  `extra_data` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`),
  KEY `idx_wtss_sort_order` (`sort_order`),
  KEY `idx_wtss_updated_at` (`updated_at`),
  CONSTRAINT `chk_wtss_hours` CHECK (`end_hour` > `start_hour`),
  CONSTRAINT `chk_wtss_range` CHECK (`start_hour` >= 0 AND `end_hour` <= 24)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `weekly_task_schedule_cells` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `slot_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `day_of_week` tinyint NOT NULL,
  `content` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `sync_status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending_create',
  `extra_data` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_wtsc_slot_day` (`slot_id`, `day_of_week`),
  KEY `idx_wtsc_slot_id` (`slot_id`),
  KEY `idx_wtsc_updated_at` (`updated_at`),
  CONSTRAINT `chk_wtsc_dow` CHECK (`day_of_week` >= 0 AND `day_of_week` <= 6),
  CONSTRAINT `fk_wtsc_slot` FOREIGN KEY (`slot_id`)
    REFERENCES `weekly_task_schedule_slots` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
