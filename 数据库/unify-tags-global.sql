-- 权威全局标签（唯一产品面）：字典 tags + 多态关联 tag_links（entity_type）
-- 幂等。若库中仍有遗留 project_tags / project_tag_links，拷贝到权威表后不再作为 API/后台表维护。
-- 新环境勿再建旧表；启动时 ensureProjectTagsTables 也会再跑一遍迁移。

CREATE TABLE IF NOT EXISTS `tags` (
  `id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `color` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#64748B',
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  `weight` int NOT NULL DEFAULT 0,
  `created_at` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `updated_at` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `sync_status` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending_create',
  `extra_data` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  PRIMARY KEY (`id`) USING BTREE,
  INDEX `idx_tags_weight`(`weight`) USING BTREE,
  INDEX `idx_tags_updated_at`(`updated_at`) USING BTREE
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = DYNAMIC;

CREATE TABLE IF NOT EXISTS `tag_links` (
  `id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `entity_type` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'project|habit|task|memo',
  `entity_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `tag_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `updated_at` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `sync_status` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending_create',
  PRIMARY KEY (`id`) USING BTREE,
  INDEX `idx_tag_links_entity`(`entity_type`, `entity_id`) USING BTREE,
  INDEX `idx_tag_links_tag_id`(`tag_id`) USING BTREE,
  INDEX `idx_tag_links_updated_at`(`updated_at`) USING BTREE
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = DYNAMIC;

-- 遗留表 → 权威表（表不存在时请跳过；ensure 会按表存在与否执行）
INSERT IGNORE INTO `tags` (
  `id`, `name`, `color`, `description`, `weight`, `created_at`, `updated_at`, `sync_status`, `extra_data`
)
SELECT `id`, `name`, `color`, `description`, `weight`, `created_at`, `updated_at`, `sync_status`, `extra_data`
FROM `project_tags`;

INSERT IGNORE INTO `tag_links` (
  `id`, `entity_type`, `entity_id`, `tag_id`, `created_at`, `updated_at`, `sync_status`
)
SELECT `id`, 'project', `project_id`, `tag_id`, `created_at`, `updated_at`, `sync_status`
FROM `project_tag_links`;
