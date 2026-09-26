import type { RowDataPacket } from 'mysql2';
import { db } from './index.js';
import { ensureColumn, tableExists } from './schema-helpers.js';

/**
 * 幂等：权威标签体系 tags + 多态关联 tag_links（entity_type）。
 * 若库中仍有遗留 project_tags / project_tag_links，启动时一次性拷贝到权威表；
 * 不再为新环境创建旧表，旧表也不再进入 API/后台白名单。
 *
 * tags.domain：task（项目/习惯/待办）与 memo（备忘录）分域，互不混选。
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
        domain VARCHAR(16) NOT NULL DEFAULT 'task',
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL,
        sync_status VARCHAR(255) NOT NULL DEFAULT 'pending_create',
        extra_data TEXT NULL,
        PRIMARY KEY (id),
        KEY idx_tags_weight (weight),
        KEY idx_tags_domain (domain),
        KEY idx_tags_updated_at (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[DB] 已创建表 tags');
  } else {
    const after = 'weight';
    await ensureColumn(
      'tags',
      'domain',
      `VARCHAR(16) NOT NULL DEFAULT 'task' COMMENT 'task=任务侧 memo=备忘录'`,
      { after },
    );
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

  // 仅挂在备忘录上的标签归为 memo；其余保持/设为 task（幂等）
  try {
    await db.query(`
      UPDATE tags
      SET domain = 'task'
      WHERE domain IS NULL OR domain = '' OR domain NOT IN ('task', 'memo')
    `);
    const [memoOnly] = await db.query<RowDataPacket[]>(
      `UPDATE tags
       SET domain = 'memo',
           updated_at = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'),
           sync_status = CASE WHEN sync_status = 'synced' THEN 'pending_update' ELSE sync_status END
       WHERE sync_status != 'pending_delete'
         AND id IN (
           SELECT tag_id FROM (
             SELECT DISTINCT tl.tag_id AS tag_id
             FROM tag_links tl
             WHERE tl.sync_status != 'pending_delete'
               AND tl.entity_type = 'memo'
               AND tl.tag_id NOT IN (
                 SELECT DISTINCT tl2.tag_id
                 FROM tag_links tl2
                 WHERE tl2.sync_status != 'pending_delete'
                   AND tl2.entity_type IN ('project', 'habit', 'task')
               )
           ) AS memo_only_tags
         )
         AND domain != 'memo'`,
    );
    const n = Number((memoOnly as { affectedRows?: number })?.affectedRows ?? 0);
    if (n > 0) {
      console.log(`[DB] 已将 ${n} 个仅备忘录标签归为 domain=memo`);
    }
  } catch (err) {
    console.warn('[DB] tags.domain 分类迁移跳过', err);
  }
}
