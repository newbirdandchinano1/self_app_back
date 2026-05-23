import app from './app.js';
import { config } from './config/index.js';

app.listen(config.port, () => {
  console.log(`[Server] 运行在 http://localhost:${config.port} (${config.nodeEnv})`);
});
