import app from './app.js';
import { config } from './config/index.js';
import { testConnection } from './db/index.js';
import { initAdminTable } from './db/init-admin.js';

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
