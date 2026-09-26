import { db } from './index.js';
import { tableExists } from './schema-helpers.js';

const DROP_TABLES = ['wish_items', 'visions', 'goal_dimensions'] as const;

/**
 * 幂等：下线愿景墙 / 好物心愿单（心愿板 wish_board_items 保留）。
 */
export async function ensureDropProfileFeatures(): Promise<void> {
  for (const table of DROP_TABLES) {
    if (!(await tableExists(table))) continue;
    await db.query(`DROP TABLE IF EXISTS \`${table}\``);
    console.log(`[DB] 已删除表 ${table}`);
  }
}
