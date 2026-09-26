import type { RowDataPacket } from 'mysql2';
import { db } from './index.js';

const COLUMNS_TO_DROP = ['deleted_at', 'version'] as const;

/**
 * 幂等：全库删除遗留 deleted_at / version 列（精确匹配 version，不删 seed_version）。
 */
export async function ensureDropDeletedAtVersion(): Promise<void> {
  const [colRows] = await db.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND COLUMN_NAME IN (?, ?)
     ORDER BY TABLE_NAME, COLUMN_NAME`,
    [...COLUMNS_TO_DROP],
  );

  const byTable = new Map<string, string[]>();
  for (const row of colRows) {
    const t = String(row.tableName);
    if (!byTable.has(t)) byTable.set(t, []);
    byTable.get(t)!.push(String(row.columnName));
  }

  if (byTable.size === 0) return;

  const [indexRows] = await db.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND COLUMN_NAME IN (?, ?)
       AND INDEX_NAME != 'PRIMARY'`,
    [...COLUMNS_TO_DROP],
  );

  const indexesByTable = new Map<string, Set<string>>();
  for (const row of indexRows) {
    const key = String(row.tableName);
    if (!indexesByTable.has(key)) indexesByTable.set(key, new Set());
    indexesByTable.get(key)!.add(String(row.indexName));
  }

  for (const [table, columns] of byTable) {
    const parts: string[] = [];
    for (const indexName of indexesByTable.get(table) ?? []) {
      parts.push(`DROP INDEX \`${indexName}\``);
    }
    for (const col of columns) {
      parts.push(`DROP COLUMN \`${col}\``);
    }
    await db.query(`ALTER TABLE \`${table}\` ${parts.join(', ')}`);
    console.log(`[DB] ${table} 已删除列 ${columns.join(', ')}`);
  }
}
