import type { RowDataPacket } from 'mysql2';
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

/**
 * 幂等：项目标签 + 项目-标签关联表。
 * 字段对齐 App 本地 SQLite（无 deleted_at / version），部署启动时自动建表。
 */
export async function ensureProjectTagsTables(): Promise<void> {
  if (!(await tableExists('project_tags'))) {
    await db.query(`
      CREATE TABLE project_tags (
        id VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        color VARCHAR(32) NOT NULL DEFAULT '#64748B',
        description TEXT NULL,
        weight INT NOT NULL DEFAULT 0,
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL,
        sync_status VARCHAR(255) NOT NULL DEFAULT 'pending_create',
        extra_data TEXT NULL,
        PRIMARY KEY (id),
        KEY idx_project_tags_weight (weight),
        KEY idx_project_tags_updated_at (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[DB] 已创建表 project_tags');
  }

  if (!(await tableExists('project_tag_links'))) {
    await db.query(`
      CREATE TABLE project_tag_links (
        id VARCHAR(255) NOT NULL,
        project_id VARCHAR(255) NOT NULL,
        tag_id VARCHAR(255) NOT NULL,
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL,
        sync_status VARCHAR(255) NOT NULL DEFAULT 'pending_create',
        PRIMARY KEY (id),
        KEY idx_project_tag_links_project_id (project_id),
        KEY idx_project_tag_links_tag_id (tag_id),
        KEY idx_project_tag_links_updated_at (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[DB] 已创建表 project_tag_links');
  }
}
