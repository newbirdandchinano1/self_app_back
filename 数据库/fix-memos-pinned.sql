-- 备忘录置顶字段（幂等）
-- 执行后重启后端；客户端同步会带上 is_pinned。

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'memos'
    AND COLUMN_NAME = 'is_pinned'
);

SET @sql := IF(
  @col_exists = 0,
  'ALTER TABLE `memos` ADD COLUMN `is_pinned` TINYINT NOT NULL DEFAULT 0 COMMENT ''置顶 0/1'' AFTER `dimension_id`',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
