import { columnExists, ensureColumn } from './schema-helpers.js';

/**
 * 幂等：users 表补齐 persona_portrait（人物画像/自我介绍）。
 */
export async function ensureUsersPersonaPortraitColumn(): Promise<void> {
  const after = (await columnExists('users', 'avatar_uri')) ? 'avatar_uri' : undefined;
  await ensureColumn(
    'users',
    'persona_portrait',
    `TEXT NULL COMMENT '人物画像/自我介绍，客户端限制最多 500 字'`,
    { after },
  );
}
