-- 已有库升级：菜谱制作次数 / 最近制作时间（排序：最近制作、做过最多）
ALTER TABLE `recipe_items`
  ADD COLUMN `times_cooked` int NOT NULL DEFAULT 0 AFTER `finished_image_uri`,
  ADD COLUMN `last_cooked_at` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL AFTER `times_cooked`;
