/**
 * 从当前库所有表中删除 deleted_at、version 列（列名精确匹配 version，不删 seed_version）
 * 用法: node scripts/drop-deleted-at-version.mjs
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const COLUMNS_TO_DROP = ['deleted_at', 'version'];

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || process.env.DB_ROOT_PASSWORD || '',
    database: process.env.DB_NAME || 'self_app',
    multipleStatements: true,
  });

  const [colRows] = await conn.query(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND COLUMN_NAME IN ('deleted_at', 'version')
     ORDER BY TABLE_NAME, COLUMN_NAME`,
  );

  const byTable = new Map();
  for (const row of colRows) {
    const t = row.tableName;
    if (!byTable.has(t)) byTable.set(t, []);
    byTable.get(t).push(row.columnName);
  }

  if (byTable.size === 0) {
    console.log('未发现 deleted_at / version 列，无需迁移。');
    await conn.end();
    return;
  }

  const [indexRows] = await conn.query(
    `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName, COLUMN_NAME AS columnName
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND COLUMN_NAME IN ('deleted_at', 'version')
       AND INDEX_NAME != 'PRIMARY'`,
  );

  const indexesByTable = new Map();
  for (const row of indexRows) {
    const key = row.tableName;
    if (!indexesByTable.has(key)) indexesByTable.set(key, new Set());
    indexesByTable.get(key).add(row.indexName);
  }

  console.log(`将处理 ${byTable.size} 张表…`);

  for (const [table, columns] of byTable) {
    const parts = [];

    for (const indexName of indexesByTable.get(table) ?? []) {
      parts.push(`DROP INDEX \`${indexName}\``);
    }
    for (const col of columns) {
      parts.push(`DROP COLUMN \`${col}\``);
    }

    const sql = `ALTER TABLE \`${table}\` ${parts.join(', ')}`;
    console.log(`→ ${table}: ${columns.join(', ')}`);
    await conn.query(sql);
  }

  await conn.end();
  console.log('完成：已删除所有 deleted_at、version 列。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
