import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { db } from './index.js';

const DROP_TABLES = ['wish_items', 'visions', 'goal_dimensions'] as const;

/**
 * 幂等：下线愿景墙 / 好物心愿单（心愿板 wish_board_items 保留）。
 * - DROP wish_items、visions、goal_dimensions
 * 个人信息（users / persona_portrait）、积分表与心愿板保留。
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
