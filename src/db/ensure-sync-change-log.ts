import { db } from './index.js';
import { indexExists, tableExists } from './schema-helpers.js';

/**
 * 幂等：多端同步 Change Log 表（账号级有序事件流）。
 * 客户端用 id 作游标；单租户时 user_id 固定为 default。
 */
export async function ensureSyncChangeLogTable(): Promise<void> {
  if (!(await tableExists('sync_change_log'))) {
    await db.query(`
      CREATE TABLE sync_change_log (
        id BIGINT NOT NULL AUTO_INCREMENT COMMENT '全局单调游标',
        user_id VARCHAR(64) NOT NULL DEFAULT 'default' COMMENT '账号隔离（单租户预留）',
        device_id VARCHAR(64) NULL COMMENT '写入端设备 ID，便于跳过回声',
        table_name VARCHAR(64) NOT NULL,
        record_pk VARCHAR(255) NOT NULL,
        op ENUM('upsert', 'delete') NOT NULL,
        updated_at DATETIME(3) NULL COMMENT '业务行时间或服务端写入时间',
        created_at DATETIME(3) NOT NULL COMMENT '入队时间',
        hint JSON NULL COMMENT '可选 pageKeys / dirtyTables 等',
        PRIMARY KEY (id),
        KEY idx_sync_change_log_user_id (user_id, id),
        KEY idx_sync_change_log_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[DB] 已创建表 sync_change_log');
    return;
  }

  if (!(await indexExists('sync_change_log', 'idx_sync_change_log_user_id'))) {
    await db.query(
      `CREATE INDEX idx_sync_change_log_user_id ON sync_change_log (user_id, id)`,
    );
    console.log('[DB] 已创建索引 idx_sync_change_log_user_id');
  }
  if (!(await indexExists('sync_change_log', 'idx_sync_change_log_created_at'))) {
    await db.query(
      `CREATE INDEX idx_sync_change_log_created_at ON sync_change_log (created_at)`,
    );
    console.log('[DB] 已创建索引 idx_sync_change_log_created_at');
  }
}
