import './bootstrap/timezone.js';
import app from './app.js';
import { config } from './config/index.js';
import { testConnection } from './db/index.js';
import { ensureDropEarnedRewards } from './db/ensure-drop-earned-rewards.js';
import { ensureHealthDropUserId } from './db/ensure-health-drop-user-id.js';
import { ensureProjectsPriorityColumn } from './db/ensure-projects-priority.js';
import { ensureUsersPersonaPortraitColumn } from './db/ensure-users-persona-portrait.js';
import { ensureWishBoardTables } from './db/ensure-wish-board.js';
import { initAdminTable } from './db/init-admin.js';
import { ensureInboxCatalogSeed } from './services/pages/catalog-inbox-seed.js';
import { ensureHealthIntakeUploadDir } from './services/health-intake-upload.js';

async function waitForDb(maxAttempts = 30, intervalMs = 2000): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await testConnection();
      console.log('[DB] MySQL 连接成功');
      return;
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
      console.warn(`[DB] 连接失败，${intervalMs / 1000}s 后重试 (${attempt}/${maxAttempts})`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

async function bootstrap() {
  await waitForDb();
  await initAdminTable();
  await ensureProjectsPriorityColumn();
  await ensureUsersPersonaPortraitColumn();
  await ensureDropEarnedRewards();
  await ensureHealthDropUserId();
  await ensureWishBoardTables();
  await ensureInboxCatalogSeed();
  await ensureHealthIntakeUploadDir();
}

bootstrap()
  .then(() => {
    app.listen(config.port, () => {
      console.log(`[Server] 运行在 http://localhost:${config.port} (${config.nodeEnv})`);
    });
  })
  .catch((error) => {
    console.error('[Server] 启动失败', error);
    process.exit(1);
  });
