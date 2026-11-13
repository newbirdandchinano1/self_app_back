import type { ResultSetHeader } from 'mysql2';
import { db } from './index.js';
import { tableExists } from './schema-helpers.js';

/**
 * 幂等：下线任务侧标签（project / habit / task）。
 * - 软删对应 tag_links
 * - 软删 domain!='memo' 且已无存活关联的 tags
 * 备忘录标签与 memo 关联不动。
 */
export async function ensureRetireTaskSideTags(): Promise<void> {
  if (!(await tableExists('tag_links'))) return;

  const [linkResult] = await db.query<ResultSetHeader>(
    `UPDATE tag_links
     SET sync_status = 'pending_delete',
         updated_at = DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s')
     WHERE entity_type IN ('project', 'habit', 'task')
       AND (sync_status IS NULL OR sync_status != 'pending_delete')`,
  );
  if (linkResult.affectedRows > 0) {
    console.log(`[DB] 已软删 ${linkResult.affectedRows} 条任务侧 tag_links`);
  }

  if (!(await tableExists('tags'))) return;

  const [tagResult] = await db.query<ResultSetHeader>(
    `UPDATE tags t
     SET t.sync_status = 'pending_delete',
         t.updated_at = DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s')
     WHERE (t.domain IS NULL OR t.domain != 'memo')
       AND (t.sync_status IS NULL OR t.sync_status != 'pending_delete')
       AND NOT EXISTS (
         SELECT 1 FROM tag_links tl
         WHERE tl.tag_id = t.id
           AND (tl.sync_status IS NULL OR tl.sync_status != 'pending_delete')
       )`,
  );
  if (tagResult.affectedRows > 0) {
    console.log(`[DB] 已软删 ${tagResult.affectedRows} 条无存活关联的任务侧 tags`);
  }
}
