import { db } from './index.js';
import { indexExists, tableExists } from './schema-helpers.js';

/**
 * 幂等：资讯 / 采集收件箱 `app_inbox`。
 *
 * 未来扩展（本期不实现）：
 * 1. 后台配置扫描 URL → Worker 抓取 → INSERT app_inbox
 * 2. App 拉取后进「资讯」Tab；未读进铃铛数字
 * 3. 若某条带 module=health 等，本期仍不打业务 Tab 角标
 */
export async function ensureAppInboxTable(): Promise<void> {
  if (!(await tableExists('app_inbox'))) {
    await db.query(`
      CREATE TABLE app_inbox (
        id VARCHAR(36) NOT NULL,
        user_id VARCHAR(64) NOT NULL DEFAULT 'default' COMMENT '账号隔离（单租户预留）',
        title VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        module VARCHAR(32) NOT NULL DEFAULT 'messages' COMMENT 'health|tasks|finance|review|profile|messages',
        href VARCHAR(512) NULL COMMENT '点击跳转；可空',
        source_key VARCHAR(128) NULL COMMENT '未来：站点/任务标识',
        payload_json JSON NULL COMMENT '扩展载荷',
        created_at DATETIME(3) NOT NULL,
        read_at DATETIME(3) NULL,
        PRIMARY KEY (id),
        KEY ix_app_inbox_user_created (user_id, created_at),
        KEY ix_app_inbox_user_unread (user_id, read_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[DB] 已创建表 app_inbox');
    return;
  }

  if (!(await indexExists('app_inbox', 'ix_app_inbox_user_created'))) {
    await db.query(
      `CREATE INDEX ix_app_inbox_user_created ON app_inbox (user_id, created_at)`,
    );
    console.log('[DB] 已创建索引 ix_app_inbox_user_created');
  }
  if (!(await indexExists('app_inbox', 'ix_app_inbox_user_unread'))) {
    await db.query(`CREATE INDEX ix_app_inbox_user_unread ON app_inbox (user_id, read_at)`);
    console.log('[DB] 已创建索引 ix_app_inbox_user_unread');
  }
}
