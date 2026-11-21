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

/** TrendRadar 热点推送（通用 Webhook 回调） */
export const trendRadarConfig = {
  /**
   * 回调 URL 上的 ?token= 校验。
   * 为空表示不校验（仅建议内网/临时使用）；线上请务必配置。
   */
  webhookToken: process.env.TRENDRADAR_WEBHOOK_TOKEN || '',
};
/** 结构化新闻导入（服务器同步脚本调 /api/news/import） */
export const newsImportConfig = {
  /** 脚本侧使用 Authorization: Bearer <token>；同时兼容管理员 JWT */
  token: process.env.NEWS_IMPORT_TOKEN || '',
};

/** 业务后端代调 selfAPP_AIAgent（备忘点评等需落库前的场景 AI） */
export const agentConfig = {
  /** Agent 根地址，如 http://host:8000；容器内勿用 localhost */
  baseUrl: process.env.AGENT_BASE_URL || 'http://127.0.0.1:8000',
  /** 与 Agent `.env` 的 API_KEY 一致，请求头 X-API-Key */
  apiKey: process.env.AGENT_API_KEY || '',
  timeoutMs: parseInt(process.env.AGENT_TIMEOUT_MS || '120000', 10),
};

/** 外部 API 网关：和风天气（QWeather） */
export const qweatherConfig = {
  /** 控制台分配的 API Host，勿带协议 */
  apiHost: (process.env.QWEATHER_API_HOST || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
  /** 控制台 API KEY；请求头 X-QW-Api-Key */
  apiKey: process.env.QWEATHER_API_KEY || '',
  timeoutMs: parseInt(process.env.QWEATHER_TIMEOUT_MS || '15000', 10),
  /** 未传 lat/lng 时的默认位置（成都） */
  defaultLat: parseFloat(process.env.QWEATHER_DEFAULT_LAT || '30.57'),
  defaultLng: parseFloat(process.env.QWEATHER_DEFAULT_LNG || '104.07'),
  defaultLabel: process.env.QWEATHER_DEFAULT_LABEL || '成都',
};
