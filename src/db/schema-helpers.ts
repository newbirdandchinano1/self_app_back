import type { RowDataPacket } from 'mysql2';
import { db } from './index.js';

/** information_schema 探测 + 通用 ensureColumn，供迁移 / ensure-* 复用 */

export async function tableExists(tableName: string): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS tableName
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [tableName],
  );
  return rows.length > 0;
}

export async function columnExists(tableName: string, columnName: string): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS columnName
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [tableName, columnName],
  );
  return rows.length > 0;
}

export async function indexExists(tableName: string, indexName: string): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT INDEX_NAME AS indexName
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND INDEX_NAME = ?
     LIMIT 1`,
    [tableName, indexName],
  );
  return rows.length > 0;
}

export async function checkConstraintExists(
  tableName: string,
  constraintName: string,
): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT CONSTRAINT_NAME AS constraintName
     FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = ?
       AND CONSTRAINT_TYPE = 'CHECK'
     LIMIT 1`,
    [tableName, constraintName],
  );
  return rows.length > 0;
}

export async function columnDataType(
  tableName: string,
  columnName: string,
): Promise<string | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT DATA_TYPE AS dataType
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [tableName, columnName],
  );
  const t = rows[0]?.dataType;
  return t == null ? null : String(t).toLowerCase();
}

/**
 * 缺列则 ADD。`columnSql` 为列定义（不含列名），如 `INT NOT NULL DEFAULT 0 COMMENT '…'`。
 * @returns 是否实际执行了 ADD
 */
export async function ensureColumn(
  tableName: string,
  columnName: string,
  columnSql: string,
  options?: { after?: string },
): Promise<boolean> {
  if (await columnExists(tableName, columnName)) return false;

  let afterClause = '';
  if (options?.after && (await columnExists(tableName, options.after))) {
    afterClause = ` AFTER \`${options.after}\``;
  }

  try {
    await db.query(
      `ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${columnSql}${afterClause}`,
    );
  } catch (err) {
    // 并发 ensure 时另一路径可能已加列
    if ((err as { code?: string }).code === 'ER_DUP_FIELDNAME') return false;
    throw err;
  }
  console.log(`[DB] 已添加 ${tableName}.${columnName}`);
  return true;
}
