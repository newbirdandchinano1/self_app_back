import type { ResultSetHeader } from 'mysql2';
import { db } from './index.js';
import {
  checkConstraintExists,
  columnDataType,
  columnExists,
  ensureColumn,
  indexExists,
  tableExists,
} from './schema-helpers.js';

/**
 * 幂等：仅心愿板条目表（积分钱包/流水由 ensurePointsTables 负责）。
 */
export async function ensureWishBoardTables(): Promise<void> {
  if (!(await tableExists('wish_board_items'))) {
    await db.query(`
      CREATE TABLE wish_board_items (
        id VARCHAR(36) NOT NULL,
        title VARCHAR(80) NOT NULL COMMENT '心愿标题',
        description VARCHAR(500) NULL COMMENT '描述（可选），对应添加弹层「描述」',
        cost_points DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '兑换所需积分，>=0，可含小数',
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[DB] 已创建表 wish_board_items');
  } else {
    await ensureWishBoardItemColumns();
  }

  await ensureWishBoardCostDecimal();
}

/** 初版表补齐 description / icon_key / wish_type 并回填 */
async function ensureWishBoardItemColumns(): Promise<void> {
  await ensureColumn(
    'wish_board_items',
    'description',
    `VARCHAR(500) NULL COMMENT '描述（可选），对应添加弹层「描述」'`,
    { after: 'title' },
  );

  const iconAfter = (await columnExists('wish_board_items', 'note')) ? 'note' : undefined;
  await ensureColumn(
    'wish_board_items',
    'icon_key',
    `VARCHAR(64) NULL COMMENT '图标 key，如 card-giftcard / movie'`,
    { after: iconAfter },
  );

  const typeAfter = (await columnExists('wish_board_items', 'icon_key'))
    ? 'icon_key'
    : undefined;
  await ensureColumn(
    'wish_board_items',
    'wish_type',
    `VARCHAR(16) NOT NULL DEFAULT 'once' COMMENT 'once=一次性，repeat=重复性'`,
    { after: typeAfter },
  );

  const [descResult] = await db.query<ResultSetHeader>(
    `UPDATE wish_board_items
     SET description = note
     WHERE (description IS NULL OR TRIM(description) = '')
       AND note IS NOT NULL
       AND TRIM(note) != ''`,
  );
  if (descResult.affectedRows > 0) {
    console.log(`[DB] 已回填 wish_board_items.description（${descResult.affectedRows} 行）`);
  }

  const [iconResult] = await db.query<ResultSetHeader>(
    `UPDATE wish_board_items
     SET icon_key = 'card-giftcard'
     WHERE icon_key IS NULL OR TRIM(icon_key) = ''`,
  );
  if (iconResult.affectedRows > 0) {
    console.log(`[DB] 已回填 wish_board_items.icon_key（${iconResult.affectedRows} 行）`);
  }

  const [typeResult] = await db.query<ResultSetHeader>(
    `UPDATE wish_board_items
     SET wish_type = 'once'
     WHERE wish_type IS NULL
        OR TRIM(wish_type) = ''
        OR wish_type NOT IN ('once', 'repeat')`,
  );
  if (typeResult.affectedRows > 0) {
    console.log(`[DB] 已回填 wish_board_items.wish_type（${typeResult.affectedRows} 行）`);
  }

  if (!(await indexExists('wish_board_items', 'idx_wish_board_items_wish_type'))) {
    await db.query(
      `CREATE INDEX idx_wish_board_items_wish_type ON wish_board_items (wish_type)`,
    );
    console.log('[DB] 已创建索引 idx_wish_board_items_wish_type');
  }
}

/** 心愿所需积分改 DECIMAL，保持 >= 0 */
async function ensureWishBoardCostDecimal(): Promise<void> {
  if (!(await tableExists('wish_board_items'))) return;

  if (await checkConstraintExists('wish_board_items', 'chk_wish_board_cost')) {
    await db.query(`ALTER TABLE wish_board_items DROP CHECK chk_wish_board_cost`);
  }

  const costType = await columnDataType('wish_board_items', 'cost_points');
  if (costType && costType !== 'decimal') {
    await db.query(`
      ALTER TABLE wish_board_items
      MODIFY COLUMN cost_points DECIMAL(12,2) NOT NULL DEFAULT 0
        COMMENT '兑换所需积分，>=0，可含小数'
    `);
    console.log('[DB] 已将 wish_board_items.cost_points 改为 DECIMAL(12,2)');
  }

  const [clampResult] = await db.query<ResultSetHeader>(
    `UPDATE wish_board_items SET cost_points = 0 WHERE cost_points < 0`,
  );
  if (clampResult.affectedRows > 0) {
    console.log(`[DB] 已将 ${clampResult.affectedRows} 条负所需积分钳制为 0`);
  }

  if (!(await checkConstraintExists('wish_board_items', 'chk_wish_board_cost'))) {
    await db.query(`
      ALTER TABLE wish_board_items
      ADD CONSTRAINT chk_wish_board_cost CHECK (cost_points >= 0)
    `);
    console.log('[DB] 已添加 wish_board_items.chk_wish_board_cost（所需积分非负）');
  }
}
