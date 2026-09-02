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

async function checkConstraintExists(tableName: string, constraintName: string): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT CONSTRAINT_NAME AS constraintName
     FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = ?
       AND CONSTRAINT_TYPE = 'CHECK'
     LIMIT 1`,
    [tableName, constraintName],
  );
  return rows.length > 0;
}

async function columnDataType(tableName: string, columnName: string): Promise<string | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT DATA_TYPE AS dataType
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [tableName, columnName],
  );
  const t = rows[0]?.dataType;
  return t == null ? null : String(t).toLowerCase();
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
        balance DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '当前可用积分（可为负）',
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        sync_status VARCHAR(32) NOT NULL DEFAULT 'synced',
        extra_data JSON NULL,
        PRIMARY KEY (id)
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

  if (!(await tableExists('points_ledger'))) {
    await db.query(`
      CREATE TABLE points_ledger (
        id VARCHAR(36) NOT NULL,
        delta DECIMAL(12,2) NOT NULL COMMENT '正数增加、负数扣减',
        balance_after DECIMAL(12,2) NOT NULL COMMENT '变动后余额（可为负）',
        reason VARCHAR(64) NOT NULL COMMENT '如 wish_redeem / points_reset / habit_check_in / task_complete / project_complete 及对应 _undo',
        ref_type VARCHAR(32) NULL COMMENT '如 wish_board_item / points_wallet / habit / task / project',
        ref_id VARCHAR(36) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        sync_status VARCHAR(32) NOT NULL DEFAULT 'pending_create',
        extra_data JSON NULL,
        PRIMARY KEY (id),
        KEY idx_points_ledger_created_at (created_at),
        KEY idx_points_ledger_ref (ref_type, ref_id),
        KEY idx_points_ledger_reason (reason, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[DB] 已创建表 points_ledger');
  } else {
    await ensurePointsLedgerIndexes();
  }

  await ensurePointsDecimalAndSignedBalance();

  const [result] = await db.query<ResultSetHeader>(
    `INSERT INTO points_wallet (id, balance, created_at, updated_at, sync_status)
     VALUES ('default', 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), 'synced')
     ON DUPLICATE KEY UPDATE id = id`,
  );
  if (result.affectedRows === 1) {
    console.log('[DB] 已初始化 points_wallet.default');
  }
}

/** 流水按 reason / 时间查询（已兑换 = wish_redeem） */
async function ensurePointsLedgerIndexes(): Promise<void> {
  if (!(await indexExists('points_ledger', 'idx_points_ledger_reason'))) {
    await db.query(
      `CREATE INDEX idx_points_ledger_reason ON points_ledger (reason, created_at)`,
    );
    console.log('[DB] 已创建索引 idx_points_ledger_reason');
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

/**
 * 积分字段改 DECIMAL；钱包允许负数；心愿所需积分保持 >= 0。
 */
async function ensurePointsDecimalAndSignedBalance(): Promise<void> {
  if (await checkConstraintExists('points_wallet', 'chk_points_wallet_balance')) {
    await db.query(`ALTER TABLE points_wallet DROP CHECK chk_points_wallet_balance`);
    console.log('[DB] 已移除 points_wallet.chk_points_wallet_balance（允许负余额）');
  }

  const walletType = await columnDataType('points_wallet', 'balance');
  if (walletType && walletType !== 'decimal') {
    await db.query(`
      ALTER TABLE points_wallet
      MODIFY COLUMN balance DECIMAL(12,2) NOT NULL DEFAULT 0
        COMMENT '当前可用积分（可为负）'
    `);
    console.log('[DB] 已将 points_wallet.balance 改为 DECIMAL(12,2)');
  }

  // 先去掉旧的非负约束，改类型并钳制负 cost，再加回 >=0
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

  const deltaType = await columnDataType('points_ledger', 'delta');
  if (deltaType && deltaType !== 'decimal') {
    await db.query(`
      ALTER TABLE points_ledger
      MODIFY COLUMN delta DECIMAL(12,2) NOT NULL COMMENT '正数增加、负数扣减',
      MODIFY COLUMN balance_after DECIMAL(12,2) NOT NULL COMMENT '变动后余额（可为负）'
    `);
    console.log('[DB] 已将 points_ledger.delta/balance_after 改为 DECIMAL(12,2)');
  }
}
