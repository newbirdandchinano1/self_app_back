/**
 * 一次性：确保课程表相关表存在（对齐 ensure-frog-schedule.ts）。
 * 用法：node scripts/ensure-frog-schedule-once.mjs
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  multipleStatements: true,
});

async function tableExists(name) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME AS tableName
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [name],
  );
  return rows.length > 0;
}

if (!(await tableExists('schedule_week_axis_snapshot'))) {
  await conn.query(`
    CREATE TABLE schedule_week_axis_snapshot (
      week_start_ymd VARCHAR(16) NOT NULL,
      start_minutes INT NOT NULL,
      end_minutes INT NOT NULL,
      slot_hours INT NOT NULL,
      created_at VARCHAR(255) NOT NULL,
      sync_status VARCHAR(64) NOT NULL DEFAULT 'synced',
      PRIMARY KEY (week_start_ymd)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC
  `);
  console.log('created schedule_week_axis_snapshot');
} else {
  console.log('exists schedule_week_axis_snapshot');
}

if (!(await tableExists('schedule_placements'))) {
  await conn.query(`
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
  console.log('created schedule_placements');
} else {
  console.log('exists schedule_placements');
}

const [after] = await conn.query("SHOW TABLES LIKE 'schedule_%'");
console.log('tables:', after);
await conn.end();
