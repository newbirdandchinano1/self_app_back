import { db } from './index.js';
import { columnExists, ensureColumn, indexExists, tableExists } from './schema-helpers.js';
import { SYNC_CHANGE_LOG_TABLES } from '../services/sync-change-log.js';

const REV_SQL = `BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调'`;
const MUTATION_SQL = `VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id'`;

/** 业务表 + 日界 app_settings */
function revisionTables(): string[] {
  const tables = new Set<string>(SYNC_CHANGE_LOG_TABLES);
  tables.add('app_settings');
  return [...tables];
}

async function ensureTombstonesTable(): Promise<void> {
  if (!(await tableExists('sync_tombstones'))) {
    await db.query(`
      CREATE TABLE sync_tombstones (
        user_id VARCHAR(64) NOT NULL DEFAULT 'default',
        table_name VARCHAR(64) NOT NULL,
        record_pk VARCHAR(255) NOT NULL,
        server_rev BIGINT NOT NULL,
        mutation_id VARCHAR(36) NULL,
        created_at DATETIME(3) NOT NULL,
        PRIMARY KEY (user_id, table_name, record_pk),
        KEY idx_sync_tombstones_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[DB] 已创建表 sync_tombstones');
    return;
  }
  await ensureColumn('sync_tombstones', 'server_rev', REV_SQL);
  await ensureColumn('sync_tombstones', 'mutation_id', MUTATION_SQL);
  if (!(await indexExists('sync_tombstones', 'idx_sync_tombstones_created_at'))) {
    await db.query(
      `CREATE INDEX idx_sync_tombstones_created_at ON sync_tombstones (created_at)`,
    );
  }
}

async function ensureChangeLogRevColumns(): Promise<void> {
  if (!(await tableExists('sync_change_log'))) return;
  await ensureColumn(
    'sync_change_log',
    'server_rev',
    `BIGINT NULL COMMENT '该事件对应的 server_rev'`,
  );
  await ensureColumn(
    'sync_change_log',
    'mutation_id',
    `VARCHAR(36) NULL COMMENT '客户端 Push mutation_id'`,
  );
}

/**
 * Phase 1：业务表 server_rev + mutation_id；tombstone 表；change log 列。
 */
export async function ensureSyncRevisionSchema(): Promise<void> {
  await ensureTombstonesTable();
  await ensureChangeLogRevColumns();

  for (const table of revisionTables()) {
    if (!(await tableExists(table))) continue;
    await ensureColumn(table, 'server_rev', REV_SQL, {
      after: (await columnExists(table, 'updated_at')) ? 'updated_at' : undefined,
    });
    await ensureColumn(table, 'mutation_id', MUTATION_SQL, {
      after: (await columnExists(table, 'server_rev')) ? 'server_rev' : undefined,
    });
  }
}
