import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { db } from './index.js';

async function tableExists(tableName: string): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS tableName
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [tableName],
  );
  return rows.length > 0;
}

async function columnExists(tableName: string, columnName: string): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS columnName
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [tableName, columnName],
  );
  return rows.length > 0;
}

async function indexExists(tableName: string, indexName: string): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT INDEX_NAME AS indexName
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND INDEX_NAME = ?
     LIMIT 1`,
    [tableName, indexName],
  );
  return rows.length > 0;
}

/**
 * 幂等：心愿板三表 + default 钱包 + 弹层增量字段。
 * 部署启动时自动执行，无需单独跑 SQL。
 */
export async function ensureWishBoardTables(): Promise<void> {
  if (!(await tableExists('points_wallet'))) {
    await db.query(`
      CREATE TABLE points_wallet (
        id VARCHAR(36) NOT NULL COMMENT '固定 default',
        balance INT NOT NULL DEFAULT 0 COMMENT '当前可用积分，>=0',
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        sync_status VARCHAR(32) NOT NULL DEFAULT 'synced',
        extra_data JSON NULL,
        PRIMARY KEY (id),
        CONSTRAINT chk_points_wallet_balance CHECK (balance >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[DB] 已创建表 points_wallet');
  }

  if (!(await tableExists('wish_board_items'))) {
    await db.query(`
      CREATE TABLE wish_board_items (
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[DB] 已创建表 wish_board_items');
  } else {
    await ensureWishBoardItemColumns();
  }

  if (!(await tableExists('points_ledger'))) {
    await db.query(`
      CREATE TABLE points_ledger (
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[DB] 已创建表 points_ledger');
  }

  const [result] = await db.query<ResultSetHeader>(
    `INSERT INTO points_wallet (id, balance, created_at, updated_at, sync_status)
     VALUES ('default', 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), 'synced')
     ON DUPLICATE KEY UPDATE id = id`,
  );
  if (result.affectedRows === 1) {
    console.log('[DB] 已初始化 points_wallet.default');
  }
}

/** 初版表补齐 description / icon_key / wish_type 并回填 */
async function ensureWishBoardItemColumns(): Promise<void> {
  if (!(await columnExists('wish_board_items', 'description'))) {
    await db.query(`
      ALTER TABLE wish_board_items
      ADD COLUMN description VARCHAR(500) NULL
        COMMENT '描述（可选），对应添加弹层「描述」'
        AFTER title
    `);
    console.log('[DB] 已添加 wish_board_items.description');
  }

  if (!(await columnExists('wish_board_items', 'icon_key'))) {
    const after = (await columnExists('wish_board_items', 'note')) ? ' AFTER note' : '';
    await db.query(`
      ALTER TABLE wish_board_items
      ADD COLUMN icon_key VARCHAR(64) NULL
        COMMENT '图标 key，如 card-giftcard / movie'${after}
    `);
    console.log('[DB] 已添加 wish_board_items.icon_key');
  }

  if (!(await columnExists('wish_board_items', 'wish_type'))) {
    const after = (await columnExists('wish_board_items', 'icon_key'))
      ? ' AFTER icon_key'
      : '';
    await db.query(`
      ALTER TABLE wish_board_items
      ADD COLUMN wish_type VARCHAR(16) NOT NULL DEFAULT 'once'
        COMMENT 'once=一次性，repeat=重复性'${after}
    `);
    console.log('[DB] 已添加 wish_board_items.wish_type');
  }

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
