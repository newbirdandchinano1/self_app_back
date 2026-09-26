import type { ResultSetHeader } from 'mysql2';
import { db } from './index.js';
import { columnExists, ensureColumn } from './schema-helpers.js';

/**
 * 幂等：projects 表补齐 priority（与 tasks.priority 同口径 0–4）。
 */
export async function ensureProjectsPriorityColumn(): Promise<void> {
  const after = (await columnExists('projects', 'status')) ? 'status' : undefined;
  await ensureColumn(
    'projects',
    'priority',
    `INT NOT NULL DEFAULT 0
       COMMENT '艾森豪威尔优先级：0未设 1不紧急不重要 2不紧急重要 3紧急不重要 4紧急重要'`,
    { after },
  );

  const [result] = await db.query<ResultSetHeader>(
    'UPDATE `projects` SET `priority` = 0 WHERE `priority` IS NULL',
  );
  if (result.affectedRows > 0) {
    console.log(`[DB] 已将 ${result.affectedRows} 行 projects.priority NULL 归一为 0`);
  }
}
