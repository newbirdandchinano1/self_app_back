import { db } from './index.js';
import { tableExists } from './schema-helpers.js';

/**
 * 幂等：体重日志表（原仅 App 本地 weight_logs，现云端可读写）。
 * 同日一行（recorded_ymd UNIQUE）；供健康 / 我的页趋势与 Agent 快照。
 */
export async function ensureWeightLogsTable(): Promise<void> {
  if (await tableExists('weight_logs')) return;

  await db.query(`
    CREATE TABLE weight_logs (
      id VARCHAR(36) NOT NULL,
      recorded_ymd VARCHAR(10) NOT NULL COMMENT '记录日 YYYY-MM-DD',
      weight_kg DECIMAL(6,2) NOT NULL COMMENT '体重 kg',
      created_at VARCHAR(255) NOT NULL,
      updated_at VARCHAR(255) NOT NULL,
      sync_status VARCHAR(32) NOT NULL DEFAULT 'pending_create',
      server_rev BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本',
      mutation_id VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id',
      PRIMARY KEY (id),
      UNIQUE KEY uk_weight_logs_ymd (recorded_ymd),
      KEY idx_weight_logs_ymd (recorded_ymd),
      KEY idx_weight_logs_updated_at (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  console.log('[DB] 已创建表 weight_logs');
}
