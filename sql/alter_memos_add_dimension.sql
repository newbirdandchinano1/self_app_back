-- memos 增加维度外键与冗余名称字段
ALTER TABLE `memos`
  ADD COLUMN `dimension_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL AFTER `linked_task_id`,
  ADD COLUMN `dimension` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL AFTER `dimension_id`,
  ADD KEY `idx_memos_dimension_id` (`dimension_id`),
  ADD CONSTRAINT `fk_memos_dimension_id` FOREIGN KEY (`dimension_id`) REFERENCES `memo_dimensions` (`id`) ON DELETE SET NULL;
