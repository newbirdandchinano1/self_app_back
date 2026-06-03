import app from './app.js';
import { config } from './config/index.js';
import { testConnection } from './db/index.js';
import { initAdminTable } from './db/init-admin.js';

async function bootstrap() {
  await testConnection();
  console.log('[DB] MySQL 连接成功');

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
