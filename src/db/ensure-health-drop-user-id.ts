import { db } from './index.js';
import { columnExists, indexExists, tableExists } from './schema-helpers.js';

/**
 * 幂等：健康表去掉多余的 user_id（单用户 App 无意义）。
 * - health_daily_targets：按 day_ymd 去重后改唯一索引，再删列
 * - health_records：删复合索引与列，补 record_date 索引
 */
export async function ensureHealthDropUserId(): Promise<void> {
  if (await tableExists('health_daily_targets')) {
    if (await columnExists('health_daily_targets', 'user_id')) {
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
