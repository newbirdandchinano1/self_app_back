-- 项目完成履历（轻量摘要；完整项目树过期压缩后仍可查询）
CREATE TABLE IF NOT EXISTS `project_completion_logs`  (
  `id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `project_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL COMMENT '原项目 id（实体删除后仍保留）',
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '项目名快照',
  `completed_ymd` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '完成日 YYYY-MM-DD',
  `completed_at` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '完成墙上时钟',
  `task_count` int NOT NULL DEFAULT 0,
  `done_task_count` int NOT NULL DEFAULT 0,
  `points_delta` double NOT NULL DEFAULT 0,
  `tag_names` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL COMMENT 'JSON 标签名数组',
  `note` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL COMMENT '备注快照（截断）',
  `source` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'archive' COMMENT 'archive|compress|manual_delete',
  `created_at` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `sync_status` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending_create',
  PRIMARY KEY (`id`) USING BTREE,
  INDEX `idx_pcl_completed_ymd`(`completed_ymd`) USING BTREE,
  INDEX `idx_pcl_project_id`(`project_id`) USING BTREE
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = DYNAMIC;
