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
 * 幂等：积分钱包/流水表 + default 钱包；并 DROP 已下线的 wish_board_items。
 */
export async function ensurePointsTables(): Promise<void> {
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

  if (!(await tableExists('points_ledger'))) {
    await db.query(`
      CREATE TABLE points_ledger (
        id VARCHAR(36) NOT NULL,
        delta DECIMAL(12,2) NOT NULL COMMENT '正数增加、负数扣减',
        balance_after DECIMAL(12,2) NOT NULL COMMENT '变动后余额（可为负）',
        reason VARCHAR(64) NOT NULL COMMENT '如 points_reset / habit_check_in / task_complete / project_complete 及对应 _undo',
        ref_type VARCHAR(32) NULL COMMENT '如 points_wallet / habit / task / project',
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

  // 历史心愿板表下线（保留积分表）
  if (await tableExists('wish_board_items')) {
    await db.query(`DROP TABLE IF EXISTS wish_board_items`);
    console.log('[DB] 已删除表 wish_board_items（心愿板功能下线）');
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

async function ensurePointsLedgerIndexes(): Promise<void> {
  if (!(await indexExists('points_ledger', 'idx_points_ledger_reason'))) {
    await db.query(
      `CREATE INDEX idx_points_ledger_reason ON points_ledger (reason, created_at)`,
    );
    console.log('[DB] 已创建索引 idx_points_ledger_reason');
  }
}

/** 积分字段改 DECIMAL；钱包允许负数 */
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
