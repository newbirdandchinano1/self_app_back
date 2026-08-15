import type { RowDataPacket } from 'mysql2';
import { db } from './index.js';

/**
 * 幂等：users 表补齐 persona_portrait（人物画像/自我介绍）。
 * 部署启动时自动执行，无需单独跑 npm 脚本。
 */
export async function ensureUsersPersonaPortraitColumn(): Promise<void> {
  const [cols] = await db.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS columnName
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = 'persona_portrait'`,
  );

  if (cols.length > 0) return;

  const [avatarCols] = await db.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS columnName
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = 'avatar_uri'`,
  );
  const afterClause = avatarCols.length > 0 ? ' AFTER `avatar_uri`' : '';
  await db.query(
    `ALTER TABLE \`users\`
     ADD COLUMN \`persona_portrait\` TEXT NULL
     COMMENT '人物画像/自我介绍，客户端限制最多 500 字'${afterClause}`,
  );
  console.log('[DB] 已添加 users.persona_portrait');
}
