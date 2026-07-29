/**
 * projects 表增加 priority 列（与 tasks.priority 同口径：0–4 艾森豪威尔）
 * 用法: node scripts/add-projects-priority.mjs
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || process.env.DB_ROOT_PASSWORD || '',
    database: process.env.DB_NAME || 'self_app',
  });

  const [cols] = await conn.query(
    `SELECT COLUMN_NAME AS columnName
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'projects'
       AND COLUMN_NAME = 'priority'`,
  );

  if (cols.length > 0) {
    console.log('projects.priority 已存在，跳过 ADD COLUMN。');
  } else {
    const [statusCols] = await conn.query(
      `SELECT COLUMN_NAME AS columnName
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'projects'
         AND COLUMN_NAME = 'status'`,
    );
    const afterClause = statusCols.length > 0 ? ' AFTER `status`' : '';
    const sql = `ALTER TABLE \`projects\`
  ADD COLUMN \`priority\` INT NOT NULL DEFAULT 0
  COMMENT '艾森豪威尔优先级：0未设 1不紧急不重要 2不紧急重要 3紧急不重要 4紧急重要'${afterClause}`;
    console.log('→', sql.replace(/\s+/g, ' ').trim());
    await conn.query(sql);
    console.log('已添加 projects.priority。');
  }

  const [result] = await conn.query(
    'UPDATE `projects` SET `priority` = 0 WHERE `priority` IS NULL',
  );
  const affected = result?.affectedRows ?? 0;
  if (affected > 0) {
    console.log(`已将 ${affected} 行 NULL priority 归一为 0。`);
  }

  await conn.end();
  console.log('完成：projects.priority 可用。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
