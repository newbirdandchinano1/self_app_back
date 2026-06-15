CREATE TABLE IF NOT EXISTS `memo_dimensions` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '维度名称，与 App 端 name 字段等价',
  `sort_order` int NOT NULL DEFAULT 1000,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `sync_status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending_create',
  `extra_data` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`),
  KEY `idx_memo_dimensions_updated_at` (`updated_at`),
  KEY `idx_memo_dimensions_sort_order` (`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
