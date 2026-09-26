import { columnExists, ensureColumn } from './schema-helpers.js';

/**
 * 幂等：memos 表补齐 is_pinned（置顶 0/1）。
 */
export async function ensureMemosPinnedColumn(): Promise<void> {
  const after = (await columnExists('memos', 'dimension_id')) ? 'dimension_id' : undefined;
  await ensureColumn(
    'memos',
    'is_pinned',
    `TINYINT NOT NULL DEFAULT 0 COMMENT '置顶 0/1'`,
    { after },
  );
}
