import { db } from './index.js';
import { columnDataType, columnExists } from './schema-helpers.js';

/**
 * 幂等：memos.body TEXT → MEDIUMTEXT（RichDoc JSON 可达 512KB，TEXT≈64KB 会截断）。
 */
export async function ensureMemosBodyMediumText(): Promise<void> {
  if (!(await columnExists('memos', 'body'))) return;

  const dataType = await columnDataType('memos', 'body');
  if (!dataType || dataType === 'mediumtext' || dataType === 'longtext') return;

  await db.query(`
    ALTER TABLE memos
    MODIFY COLUMN body MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL
  `);
  console.log('[DB] 已将 memos.body 改为 MEDIUMTEXT');
}
