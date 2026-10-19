import { db } from './index.js';
import { columnDataType, columnExists, tableExists } from './schema-helpers.js';

/**
 * 幂等：wish_board_items.description / note → TEXT，
 * 以便描述里插入统一图片库 uri（`![img](/uploads/images/...)`）。
 */
export async function ensureWishBoardDescriptionText(): Promise<void> {
  if (!(await tableExists('wish_board_items'))) return;

  for (const column of ['description', 'note'] as const) {
    if (!(await columnExists('wish_board_items', column))) continue;
    const dataType = await columnDataType('wish_board_items', column);
    if (!dataType || dataType === 'text' || dataType === 'mediumtext' || dataType === 'longtext') {
      continue;
    }
    const comment =
      column === 'description'
        ? '描述（可选，可含图片 uri 标记）'
        : '备注（可与 description 对齐）';
    await db.query(`
      ALTER TABLE wish_board_items
      MODIFY COLUMN ${column} TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL
        COMMENT '${comment}'
    `);
    console.log(`[DB] 已将 wish_board_items.${column} 改为 TEXT`);
  }
}
