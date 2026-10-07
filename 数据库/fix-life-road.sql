-- 我的道路（方案 A）：总方向 + 年度赌注；projects.life_bet_id 可空归属
-- 运行时以 ensure-life-road.ts 迁移为准；本文件供对照 / 手工补库。

CREATE TABLE IF NOT EXISTS `life_directions` (
  `id` VARCHAR(36) NOT NULL,
  `body` TEXT NOT NULL COMMENT '总方向，1–200 字',
  `year_theme` VARCHAR(40) NULL COMMENT '年主题，0–40 字',
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `sync_status` VARCHAR(32) NOT NULL DEFAULT 'pending_create',
  `extra_data` JSON NULL,
  `server_rev` BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调',
  `mutation_id` VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id',
  PRIMARY KEY (`id`),
  KEY `idx_life_directions_updated_at` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `life_bets` (
  `id` VARCHAR(36) NOT NULL,
  `title` VARCHAR(40) NOT NULL COMMENT '赌注标题，1–40 字',
  `horizon` VARCHAR(16) NOT NULL COMMENT 'year | multi | farther',
  `year` INT NULL COMMENT '公历年；horizon=year 时必填',
  `note` VARCHAR(200) NULL COMMENT '做成了长什么样，0–200 字',
  `status` VARCHAR(16) NOT NULL DEFAULT 'on_track' COMMENT 'on_track | paused | arrived | dropped',
  `sort_order` INT NOT NULL DEFAULT 1000,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `sync_status` VARCHAR(32) NOT NULL DEFAULT 'pending_create',
  `extra_data` JSON NULL,
  `server_rev` BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调',
  `mutation_id` VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id',
  PRIMARY KEY (`id`),
  KEY `idx_life_bets_horizon_year_sort` (`horizon`, `year`, `sort_order`),
  KEY `idx_life_bets_status` (`status`),
  KEY `idx_life_bets_updated_at` (`updated_at`),
  CONSTRAINT `chk_life_bets_horizon` CHECK (`horizon` IN ('year', 'multi', 'farther')),
  CONSTRAINT `chk_life_bets_status` CHECK (`status` IN ('on_track', 'paused', 'arrived', 'dropped'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- projects.life_bet_id（无强制 FK）
-- ALTER TABLE `projects` ADD COLUMN `life_bet_id` VARCHAR(36) NULL COMMENT '归属道路赌注 life_bets.id，可空' AFTER `category_id`;
-- CREATE INDEX `idx_projects_life_bet_id` ON `projects` (`life_bet_id`);
