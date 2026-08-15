-- 心愿板（Wish Board）：积分钱包 / 心愿条目 / 积分流水
-- 与购物向 wish_items（心愿清单）无关，请勿混用
-- 含补充字段：description / icon_key / wish_type

CREATE TABLE IF NOT EXISTS points_wallet (
  id VARCHAR(36) NOT NULL COMMENT '固定 default',
  balance INT NOT NULL DEFAULT 0 COMMENT '当前可用积分，>=0',
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  sync_status VARCHAR(32) NOT NULL DEFAULT 'synced',
  extra_data JSON NULL,
  PRIMARY KEY (id),
  CONSTRAINT chk_points_wallet_balance CHECK (balance >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO points_wallet (id, balance, created_at, updated_at, sync_status)
VALUES ('default', 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), 'synced')
ON DUPLICATE KEY UPDATE id = id;

CREATE TABLE IF NOT EXISTS wish_board_items (
  id VARCHAR(36) NOT NULL,
  title VARCHAR(80) NOT NULL COMMENT '心愿标题',
  description VARCHAR(500) NULL COMMENT '描述（可选），对应添加弹层「描述」',
  cost_points INT NOT NULL DEFAULT 0 COMMENT '兑换所需积分，>=0',
  note VARCHAR(500) NULL COMMENT '备注（可与 description 对齐）',
  icon_key VARCHAR(64) NULL COMMENT '图标 key，如 card-giftcard / movie',
  wish_type VARCHAR(16) NOT NULL DEFAULT 'once' COMMENT 'once=一次性，repeat=重复性',
  status VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active | redeemed',
  redeemed_at DATETIME(3) NULL,
  sort_order INT NOT NULL DEFAULT 1000,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  sync_status VARCHAR(32) NOT NULL DEFAULT 'pending_create',
  extra_data JSON NULL,
  PRIMARY KEY (id),
  KEY idx_wish_board_items_status (status),
  KEY idx_wish_board_items_updated_at (updated_at),
  KEY idx_wish_board_items_sort_order (sort_order),
  KEY idx_wish_board_items_wish_type (wish_type),
  CONSTRAINT chk_wish_board_cost CHECK (cost_points >= 0),
  CONSTRAINT chk_wish_board_status CHECK (status IN ('active', 'redeemed')),
  CONSTRAINT chk_wish_board_wish_type CHECK (wish_type IN ('once', 'repeat'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS points_ledger (
  id VARCHAR(36) NOT NULL,
  delta INT NOT NULL COMMENT '正数增加、负数扣减',
  balance_after INT NOT NULL COMMENT '变动后余额',
  reason VARCHAR(64) NOT NULL COMMENT '如 wish_redeem / habit_check_in / task_complete / project_complete 及对应 _undo',
  ref_type VARCHAR(32) NULL COMMENT '如 wish_board_item / habit / task / project',
  ref_id VARCHAR(36) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  sync_status VARCHAR(32) NOT NULL DEFAULT 'pending_create',
  extra_data JSON NULL,
  PRIMARY KEY (id),
  KEY idx_points_ledger_created_at (created_at),
  KEY idx_points_ledger_ref (ref_type, ref_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
