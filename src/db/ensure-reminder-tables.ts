import { db } from './index.js';
import { indexExists, tableExists } from './schema-helpers.js';

/**
 * 幂等：服务端提醒调度三表
 * - device_push_tokens：Expo push token
 * - reminder_jobs：待派发任务
 * - reminder_inbox：已派发收件箱（与资讯 app_inbox 分离）
 */
export async function ensureReminderTables(): Promise<void> {
  if (!(await tableExists('device_push_tokens'))) {
    await db.query(`
      CREATE TABLE device_push_tokens (
        id VARCHAR(36) NOT NULL,
        user_id VARCHAR(64) NOT NULL DEFAULT 'default',
        token VARCHAR(512) NOT NULL,
        platform VARCHAR(16) NOT NULL DEFAULT 'unknown',
        updated_at DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY ux_device_push_tokens_token (token),
        KEY ix_device_push_tokens_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[DB] 已创建表 device_push_tokens');
  } else if (!(await indexExists('device_push_tokens', 'ux_device_push_tokens_token'))) {
    await db.query(
      `CREATE UNIQUE INDEX ux_device_push_tokens_token ON device_push_tokens (token)`,
    );
  }

  if (!(await tableExists('reminder_jobs'))) {
    await db.query(`
      CREATE TABLE reminder_jobs (
        id VARCHAR(36) NOT NULL,
        user_id VARCHAR(64) NOT NULL DEFAULT 'default',
        dedupe_key VARCHAR(255) NOT NULL,
        category VARCHAR(64) NOT NULL,
        fire_at DATETIME(3) NOT NULL,
        title VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        payload_json JSON NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        strong TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY ux_reminder_jobs_user_dedupe_fire (user_id, dedupe_key, fire_at),
        KEY ix_reminder_jobs_due (status, fire_at),
        KEY ix_reminder_jobs_user_status (user_id, status, category)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[DB] 已创建表 reminder_jobs');
  }

  if (!(await tableExists('reminder_inbox'))) {
    await db.query(`
      CREATE TABLE reminder_inbox (
        id VARCHAR(36) NOT NULL,
        user_id VARCHAR(64) NOT NULL DEFAULT 'default',
        dedupe_key VARCHAR(255) NOT NULL,
        category VARCHAR(64) NOT NULL,
        title VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        payload_json JSON NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        read_at DATETIME(3) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY ux_reminder_inbox_user_dedupe (user_id, dedupe_key),
        KEY ix_reminder_inbox_user_updated (user_id, updated_at),
        KEY ix_reminder_inbox_user_unread (user_id, read_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[DB] 已创建表 reminder_inbox');
  }
}
