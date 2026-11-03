-- 我的道路 · 年季月节点（对照 ensure-life-road-nodes.ts / migration 021）
-- 运行时以 ensure 迁移为准；本文件供对照 / 手工补库。

CREATE TABLE IF NOT EXISTS `life_road_nodes` (
  `id` VARCHAR(36) NOT NULL,
  `kind` VARCHAR(16) NOT NULL COMMENT 'multi | farther | year | quarter | month',
  `title` VARCHAR(40) NOT NULL COMMENT '方向短句，1–40 字',
  `note` VARCHAR(200) NULL COMMENT '说明，0–200 字',
  `calendar_year` INT NULL COMMENT '公历年；年/季/月必填',
  `quarter` TINYINT NULL COMMENT '1–4；季/月使用',
  `month` TINYINT NULL COMMENT '1–12；月目标使用',
  `parent_id` VARCHAR(36) NULL COMMENT '季→年、月→季；可空',
  `status` VARCHAR(16) NOT NULL DEFAULT 'on_track'
    COMMENT 'on_track | paused | arrived | dropped',
  `sort_order` INT NOT NULL DEFAULT 1000,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `sync_status` VARCHAR(32) NOT NULL DEFAULT 'pending_create',
  `extra_data` JSON NULL,
  `server_rev` BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调',
  `mutation_id` VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id',
  PRIMARY KEY (`id`),
  KEY `idx_life_road_nodes_kind_year` (`kind`, `calendar_year`, `quarter`, `month`, `sort_order`),
  KEY `idx_life_road_nodes_parent` (`parent_id`),
  KEY `idx_life_road_nodes_status` (`status`),
  KEY `idx_life_road_nodes_updated_at` (`updated_at`),
  CONSTRAINT `chk_life_road_nodes_kind`
    CHECK (`kind` IN ('multi', 'farther', 'year', 'quarter', 'month')),
  CONSTRAINT `chk_life_road_nodes_status`
    CHECK (`status` IN ('on_track', 'paused', 'arrived', 'dropped'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- projects.life_month_goal_id（无强制 FK）
-- ALTER TABLE `projects` ADD COLUMN `life_month_goal_id` VARCHAR(36) NULL
--   COMMENT '归属月目标 life_road_nodes.id，可空' AFTER `life_bet_id`;
-- CREATE INDEX `idx_projects_life_month_goal_id` ON `projects` (`life_month_goal_id`);
