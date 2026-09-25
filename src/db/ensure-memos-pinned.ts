import type { RowDataPacket } from 'mysql2';
import { db } from './index.js';

/**
 * 幂等：memos 表补齐 is_pinned（置顶 0/1）。
 * 部署启动时自动执行，无需单独跑 SQL。
 */
export async function ensureMemosPinnedColumn(): Promise<void> {
  const [cols] = await db.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS columnName
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'memos'
       AND COLUMN_NAME = 'is_pinned'`,
  );

  if (cols.length > 0) return;

  const [dimCols] = await db.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS columnName
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'memos'
       AND COLUMN_NAME = 'dimension_id'`,
  );
  const afterClause = dimCols.length > 0 ? ' AFTER `dimension_id`' : '';
  await db.query(
    `ALTER TABLE \`memos\`
     ADD COLUMN \`is_pinned\` TINYINT NOT NULL DEFAULT 0
     COMMENT '置顶 0/1'${afterClause}`,
  );
  console.log('[DB] 已添加 memos.is_pinned');
}
