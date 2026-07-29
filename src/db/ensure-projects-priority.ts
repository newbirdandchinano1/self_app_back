import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { db } from './index.js';

/**
 * 幂等：projects 表补齐 priority（与 tasks.priority 同口径 0–4）。
 * 部署启动时自动执行，无需单独跑 npm 脚本。
 */
export async function ensureProjectsPriorityColumn(): Promise<void> {
  const [cols] = await db.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS columnName
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'projects'
       AND COLUMN_NAME = 'priority'`,
  );

  if (cols.length === 0) {
    const [statusCols] = await db.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME AS columnName
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'projects'
         AND COLUMN_NAME = 'status'`,
    );
    const afterClause = statusCols.length > 0 ? ' AFTER `status`' : '';
    await db.query(
      `ALTER TABLE \`projects\`
       ADD COLUMN \`priority\` INT NOT NULL DEFAULT 0
       COMMENT '艾森豪威尔优先级：0未设 1不紧急不重要 2不紧急重要 3紧急不重要 4紧急重要'${afterClause}`,
    );
    console.log('[DB] 已添加 projects.priority');
  }

  const [result] = await db.query<ResultSetHeader>(
    'UPDATE `projects` SET `priority` = 0 WHERE `priority` IS NULL',
  );
  if (result.affectedRows > 0) {
    console.log(`[DB] 已将 ${result.affectedRows} 行 projects.priority NULL 归一为 0`);
  }
}
