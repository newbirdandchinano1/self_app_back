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
 * 幂等：通用标签字典 tags + 多态关联 tag_links。
 * 兼容旧表 project_tags / project_tag_links：一次性拷贝，不删旧表以免历史同步残留。
 * 字段对齐 App 本地 SQLite（无 deleted_at / version），部署启动时自动建表。
 */
export async function ensureProjectTagsTables(): Promise<void> {
  // 旧表仍建，供尚未迁移的客户端/历史数据可读
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

  if (!(await tableExists('tags'))) {
    await db.query(`
      CREATE TABLE tags (
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
        KEY idx_tags_weight (weight),
        KEY idx_tags_updated_at (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[DB] 已创建表 tags');
  }

  if (!(await tableExists('tag_links'))) {
    await db.query(`
      CREATE TABLE tag_links (
        id VARCHAR(255) NOT NULL,
        entity_type VARCHAR(32) NOT NULL,
        entity_id VARCHAR(255) NOT NULL,
        tag_id VARCHAR(255) NOT NULL,
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL,
        sync_status VARCHAR(255) NOT NULL DEFAULT 'pending_create',
        PRIMARY KEY (id),
        KEY idx_tag_links_entity (entity_type, entity_id),
        KEY idx_tag_links_tag_id (tag_id),
        KEY idx_tag_links_updated_at (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[DB] 已创建表 tag_links');
  }

  // 字典：project_tags → tags（按 id 幂等）
  const [copiedTags] = await db.query<RowDataPacket[]>(
    `INSERT IGNORE INTO tags (
       id, name, color, description, weight, created_at, updated_at, sync_status, extra_data
     )
     SELECT id, name, color, description, weight, created_at, updated_at, sync_status, extra_data
     FROM project_tags`,
  );
  const tagAffected = Number((copiedTags as { affectedRows?: number })?.affectedRows ?? 0);
  if (tagAffected > 0) {
    console.log(`[DB] 已从 project_tags 迁移 ${tagAffected} 条到 tags`);
  }

  // 关联：project_tag_links → tag_links（entity_type=project）
  const [copiedLinks] = await db.query<RowDataPacket[]>(
    `INSERT IGNORE INTO tag_links (
       id, entity_type, entity_id, tag_id, created_at, updated_at, sync_status
     )
     SELECT id, 'project', project_id, tag_id, created_at, updated_at, sync_status
     FROM project_tag_links`,
  );
  const linkAffected = Number((copiedLinks as { affectedRows?: number })?.affectedRows ?? 0);
  if (linkAffected > 0) {
    console.log(`[DB] 已从 project_tag_links 迁移 ${linkAffected} 条到 tag_links`);
  }
}
