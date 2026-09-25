import type { RowDataPacket } from 'mysql2';
import { db } from './index.js';

async function tableExists(tableName: string): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS tableName
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [tableName],
  );
  return rows.length > 0;
}

/**
 * 幂等：周课程表轴快照 + 占用实例。
 * 对齐 数据库/fix-frog-schedule.sql 与 App 本地 SQLite，部署启动时自动建表。
 */
export async function ensureFrogScheduleTables(): Promise<void> {
  if (!(await tableExists('schedule_week_axis_snapshot'))) {
    await db.query(`
      CREATE TABLE schedule_week_axis_snapshot (
        week_start_ymd VARCHAR(16) NOT NULL,
        start_minutes INT NOT NULL,
        end_minutes INT NOT NULL,
        slot_hours INT NOT NULL,
        breaks_json TEXT NULL,
        created_at VARCHAR(255) NOT NULL,
        sync_status VARCHAR(64) NOT NULL DEFAULT 'synced',
        PRIMARY KEY (week_start_ymd)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC
    `);
    console.log('[DB] 已创建表 schedule_week_axis_snapshot');
  } else {
    const [cols] = await db.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'schedule_week_axis_snapshot'
         AND COLUMN_NAME = 'breaks_json'`,
    );
    if (cols.length === 0) {
      await db.query(
        `ALTER TABLE schedule_week_axis_snapshot ADD COLUMN breaks_json TEXT NULL`,
      );
      console.log('[DB] schedule_week_axis_snapshot 已添加 breaks_json');
    }
  }

  if (!(await tableExists('schedule_placements'))) {
    await db.query(`
      CREATE TABLE schedule_placements (
        id VARCHAR(36) NOT NULL,
        week_start_ymd VARCHAR(16) NOT NULL,
        weekday INT NOT NULL,
        start_slot_index INT NULL DEFAULT NULL,
        span_slots INT NOT NULL DEFAULT 1,
        subject_kind VARCHAR(16) NOT NULL,
        subject_id VARCHAR(36) NOT NULL,
        orphaned INT NOT NULL DEFAULT 0,
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL,
        sync_status VARCHAR(64) NOT NULL DEFAULT 'synced',
        PRIMARY KEY (id),
        KEY idx_schedule_placements_week (week_start_ymd, weekday),
        KEY idx_schedule_placements_subject (subject_kind, subject_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC
    `);
    console.log('[DB] 已创建表 schedule_placements');
  }
}
