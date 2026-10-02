import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',
};

export { APP_TIME_ZONE, APP_MYSQL_TIMEZONE } from './timezone.js';
export const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'self_app',
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '20', 10),
};

export const concurrencyConfig = {
  enabled: process.env.CONCURRENCY_LIMIT_ENABLED !== 'false',
  apiMax: parseInt(process.env.API_CONCURRENCY_MAX || '50', 10),
  aiMax: parseInt(process.env.AI_CONCURRENCY_MAX || '8', 10),
};

/** Phase 5：多端同步硬化配置 */
export const syncConfig = {
  /** GET /sync/changes 滑动窗口内最大次数 */
  pullRateMax: parseInt(process.env.SYNC_PULL_RATE_MAX || '60', 10),
  pullRateWindowMs: parseInt(process.env.SYNC_PULL_RATE_WINDOW_MS || '60000', 10),
  /** 同 deviceId 允许的最大并发 SSE 连接 */
  sseMaxPerDevice: parseInt(process.env.SYNC_SSE_MAX_PER_DEVICE || '3', 10),
  /** Change Log 保留天数 */
  retainDays: parseInt(process.env.SYNC_CHANGE_LOG_RETAIN_DAYS || '14', 10),
  /** 每用户最多保留条数；0 表示不按条数裁 */
  retainMaxRows: parseInt(process.env.SYNC_CHANGE_LOG_RETAIN_MAX_ROWS || '100000', 10),
  /** 是否启用定时清理（默认开） */
  cleanupEnabled: process.env.SYNC_CHANGE_LOG_CLEANUP_ENABLED !== 'false',
};

export const zhipuConfig = {
  apiKey:
    process.env.ZHIPU_API_KEY ||
    process.env.EXPO_PUBLIC_ZHIPU_API_KEY ||
    'd0ab5a5e402040d291d9b77f58996d32.nL1sXtGfaUMXzW7W',
  textModel: process.env.ZHIPU_TEXT_MODEL || 'glm-4-flash',
  visionModel: process.env.ZHIPU_VISION_MODEL || 'glm-4.6v-flash',
};
