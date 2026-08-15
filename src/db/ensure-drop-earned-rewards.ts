import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { db } from './index.js';

const ENTITY_TABLES = ['habits', 'tasks', 'projects'] as const;

/**
 * 幂等：方案 B 下线完成奖励。
 * - 删除 earned_rewards 表
 * - 从 habits / tasks / projects 的 extra_data 移除 completion_reward
 * 不触碰 wish_items。
 */
export async function ensureDropEarnedRewards(): Promise<void> {
  const [tables] = await db.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS tableName
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'earned_rewards'`,
  );

  if (tables.length > 0) {
    await db.query('DROP TABLE IF EXISTS `earned_rewards`');
    console.log('[DB] 已删除表 earned_rewards');
  }

  for (const table of ENTITY_TABLES) {
    const [exists] = await db.query<RowDataPacket[]>(
      `SELECT TABLE_NAME AS tableName
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?`,
      [table],
    );
    if (exists.length === 0) continue;

    const [result] = await db.query<ResultSetHeader>(
      `UPDATE \`${table}\`
       SET \`extra_data\` = JSON_REMOVE(\`extra_data\`, '$.completion_reward')
       WHERE \`extra_data\` IS NOT NULL
         AND JSON_VALID(\`extra_data\`)
         AND JSON_CONTAINS_PATH(\`extra_data\`, 'one', '$.completion_reward')`,
    );
    if (result.affectedRows > 0) {
      console.log(
        `[DB] 已从 ${table}.extra_data 移除 completion_reward（${result.affectedRows} 行）`,
      );
    }
  }
}
