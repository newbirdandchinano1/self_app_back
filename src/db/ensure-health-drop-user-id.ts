import type { RowDataPacket } from 'mysql2';
import { db } from './index.js';

async function tableExists(table: string): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS tableName
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [table],
  );
  return rows.length > 0;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS col
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [table, column],
  );
  return rows.length > 0;
}

async function indexExists(table: string, indexName: string): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT INDEX_NAME AS indexName
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND INDEX_NAME = ?
     LIMIT 1`,
    [table, indexName],
  );
  return rows.length > 0;
}

/**
 * 幂等：健康表去掉多余的 user_id（单用户 App 无意义）。
 * - health_daily_targets：按 day_ymd 去重后改唯一索引，再删列
 * - health_records：删复合索引与列，补 record_date 索引
 */
export async function ensureHealthDropUserId(): Promise<void> {
  if (await tableExists('health_daily_targets')) {
    if (await columnExists('health_daily_targets', 'user_id')) {
      // 同一逻辑日可能多用户残留多行：保留 updated_at 最新的一条
      await db.query(`
        DELETE t1 FROM health_daily_targets t1
        INNER JOIN health_daily_targets t2
          ON t1.day_ymd = t2.day_ymd
         AND (
           t1.updated_at < t2.updated_at
           OR (t1.updated_at = t2.updated_at AND t1.id < t2.id)
         )
      `);

      if (await indexExists('health_daily_targets', 'uk_health_daily_targets_user_day')) {
        await db.query(
          'ALTER TABLE `health_daily_targets` DROP INDEX `uk_health_daily_targets_user_day`',
        );
      }

      await db.query('ALTER TABLE `health_daily_targets` DROP COLUMN `user_id`');
      console.log('[DB] health_daily_targets 已删除列 user_id');
    }

    if (!(await indexExists('health_daily_targets', 'uk_health_daily_targets_day_ymd'))) {
      await db.query(
        'ALTER TABLE `health_daily_targets` ADD UNIQUE INDEX `uk_health_daily_targets_day_ymd` (`day_ymd`)',
      );
      console.log('[DB] health_daily_targets 已添加唯一索引 uk_health_daily_targets_day_ymd');
    }

    if (await indexExists('health_daily_targets', 'idx_health_daily_targets_day_ymd')) {
      await db.query(
        'ALTER TABLE `health_daily_targets` DROP INDEX `idx_health_daily_targets_day_ymd`',
      );
    }
  }

  if (await tableExists('health_records')) {
    if (await columnExists('health_records', 'user_id')) {
      if (await indexExists('health_records', 'idx_health_records_user_record_date')) {
        await db.query(
          'ALTER TABLE `health_records` DROP INDEX `idx_health_records_user_record_date`',
        );
      }

      await db.query('ALTER TABLE `health_records` DROP COLUMN `user_id`');
      console.log('[DB] health_records 已删除列 user_id');
    }

    if (!(await indexExists('health_records', 'idx_health_records_record_date'))) {
      await db.query(
        'ALTER TABLE `health_records` ADD INDEX `idx_health_records_record_date` (`record_date`)',
      );
      console.log('[DB] health_records 已添加索引 idx_health_records_record_date');
    }
  }
}
