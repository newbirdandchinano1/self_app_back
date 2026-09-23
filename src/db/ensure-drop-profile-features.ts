import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { db } from './index.js';

const DROP_TABLES = ['wish_items', 'visions', 'goal_dimensions', 'wish_board_items'] as const;

/**
 * 幂等：下线愿景墙 / 好物心愿单 / 心愿板条目。
 * - DROP wish_items、visions、goal_dimensions、wish_board_items
 * 个人信息（users / persona_portrait）与积分表保留。
 */
export async function ensureDropProfileFeatures(): Promise<void> {
  for (const table of DROP_TABLES) {
    const [tables] = await db.query<RowDataPacket[]>(
      `SELECT TABLE_NAME AS tableName
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?`,
      [table],
    );
    if (tables.length === 0) continue;
    await db.query(`DROP TABLE IF EXISTS \`${table}\``);
    console.log(`[DB] 已删除表 ${table}`);
  }
}
