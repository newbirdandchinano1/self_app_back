import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',
};

export { APP_TIME_ZONE, APP_MYSQL_TIMEZONE } from './timezone.js';
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'self_app',
  /** 连接池大小；禁止为掩盖过载而直接扩到 50 */
  connectionLimit: parsePositiveInt(process.env.DB_CONNECTION_LIMIT, 20),
  /**
   * 等待连接的队列上限。旧默认 0=无限等待；阶段 A 默认 50，满则快速失败。
   */
  queueLimit: parseNonNegativeInt(process.env.DB_QUEUE_LIMIT, 50),
  /** 获取连接超时（ms）；超时返回 503 + Retry-After */
  acquireTimeoutMs: parsePositiveInt(process.env.DB_ACQUIRE_TIMEOUT_MS, 3000),
};

export const concurrencyConfig = {
  enabled: process.env.CONCURRENCY_LIMIT_ENABLED !== 'false',
  /**
   * 全局并发上限（单池模式，或分池开启时作为跨池总帽）。
   * 阶段 A 灰度默认 12（旧 50）。
   */
  apiMax: parsePositiveInt(process.env.API_CONCURRENCY_MAX, 12),
  aiMax: parsePositiveInt(process.env.AI_CONCURRENCY_MAX, 8),
  /**
   * 分池开关：轻量读 / 页面重查询 / 同步 / 写入。
   * 与 PAGE_CONCURRENCY_LIMIT_ENABLED 对齐；默认开启。
   */
  pagePoolsEnabled: process.env.PAGE_CONCURRENCY_LIMIT_ENABLED !== 'false',
  lightMax: parsePositiveInt(process.env.API_LIGHT_CONCURRENCY_MAX, 16),
  pageMax: parsePositiveInt(process.env.API_PAGE_CONCURRENCY_MAX, 6),
  syncMax: parsePositiveInt(process.env.API_SYNC_CONCURRENCY_MAX, 4),
  writeMax: parsePositiveInt(process.env.API_WRITE_CONCURRENCY_MAX, 6),
  /** 单身份并发上限；0=关闭 */
  userMax: parseNonNegativeInt(process.env.API_USER_CONCURRENCY_MAX, 4),
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

/**
 * 阶段 B：任务页危险 bootstrap 闸门。
 * true=生产拒绝无 taskView 的大 include 包（410）；false=只告警仍放行（回滚开关）。
 */
export const tasksPageConfig = {
  dangerousBootstrapReject: process.env.TASKS_DANGEROUS_BOOTSTRAP_REJECT !== 'false',
  /**
   * 阶段 C：轻量 bootstrap-v2。默认关，可先于前端消费上线；
   * 不得假设旧大 bootstrap 已消失（B1 拒包另轨）。
   */
  bootstrapV2Enabled: process.env.TASKS_BOOTSTRAP_V2_ENABLED === 'true',
};

/**
 * 阶段 C：进程内缓存（catalog / heatmap / day-boundary / bootstrap-v2）。
 * CACHE_ENABLED=false 可整段旁路；多实例 Redis 可后置。
 */
export const cacheConfig = {
  enabled: process.env.CACHE_ENABLED !== 'false',
  /** catalog：30～120s，默认 60s */
  catalogTtlMs: parsePositiveInt(process.env.CACHE_CATALOG_TTL_MS, 60_000),
  catalogSwrMs: parseNonNegativeInt(process.env.CACHE_CATALOG_SWR_MS, 30_000),
  /** heatmap：按身份+范围，默认 60s */
  heatmapTtlMs: parsePositiveInt(process.env.CACHE_HEATMAP_TTL_MS, 60_000),
  heatmapSwrMs: parseNonNegativeInt(process.env.CACHE_HEATMAP_SWR_MS, 30_000),
  /** day boundary：5 分钟 */
  dayBoundaryTtlMs: parsePositiveInt(process.env.CACHE_DAY_BOUNDARY_TTL_MS, 300_000),
  dayBoundarySwrMs: parseNonNegativeInt(process.env.CACHE_DAY_BOUNDARY_SWR_MS, 60_000),
  /** bootstrap-v2 短窗（single-flight 为主，TTL 偏短） */
  bootstrapV2TtlMs: parsePositiveInt(process.env.CACHE_BOOTSTRAP_V2_TTL_MS, 15_000),
  bootstrapV2SwrMs: parseNonNegativeInt(process.env.CACHE_BOOTSTRAP_V2_SWR_MS, 15_000),
  /** single-flight 最大等待 */
  singleFlightMaxWaitMs: parsePositiveInt(process.env.CACHE_SINGLE_FLIGHT_MAX_WAIT_MS, 8_000),
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

/** 外部 API 网关：万维易源 ShowAPI 星座运势（872-1） */
export const showapiConfig = {
  baseUrl: (process.env.SHOWAPI_BASE_URL || 'https://route.showapi.com').replace(/\/+$/, ''),
  /** 完整 appKey；请求 query appKey= */
  appKey: process.env.SHOWAPI_APP_KEY || '',
  timeoutMs: parseInt(process.env.SHOWAPI_TIMEOUT_MS || '15000', 10),
  /** 星座运势接入点路径 */
  horoscopePath: process.env.SHOWAPI_HOROSCOPE_PATH || '/872-1',
};
