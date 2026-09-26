import type { RowDataPacket } from 'mysql2';
import { db } from './index.js';
import { tableExists } from './schema-helpers.js';

/**
 * 幂等：权威标签体系 tags + 多态关联 tag_links（entity_type）。
 * 若库中仍有遗留 project_tags / project_tag_links，启动时一次性拷贝到权威表；
 * 不再为新环境创建旧表，旧表也不再进入 API/后台白名单。
 */
export async function ensureProjectTagsTables(): Promise<void> {
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

  // 遗留表：仅在存在时做只读迁移，不新建、不写入
  if (await tableExists('project_tags')) {
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
  }

  if (await tableExists('project_tag_links')) {
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
}
