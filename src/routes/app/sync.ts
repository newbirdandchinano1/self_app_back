import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { createRateLimitMiddleware } from '../../middlewares/rate-limit.js';
import { success, fail } from '../../utils/response.js';
import { pullSyncChanges } from '../../services/sync-pull.js';
import { resolveDeviceIdFromHeader, DEFAULT_SYNC_USER_ID } from '../../services/sync-change-log.js';
import {
  registerSyncSseConnection,
  unregisterSyncSseConnection,
  startSyncSseHeartbeat,
  getSyncSseStats,
} from '../../services/sync-sse-hub.js';
import { getSyncMetricsSnapshot, syncMetricInc } from '../../services/sync-metrics.js';
import { syncConfig } from '../../config/index.js';

const router = Router();

router.use(requireAuth);

/** Pull 限流：默认每设备 / IP 每分钟 60 次 */
const syncChangesRateLimit = createRateLimitMiddleware({
  max: syncConfig.pullRateMax,
  windowMs: syncConfig.pullRateWindowMs,
  message: '同步拉取过于频繁，请稍后重试',
  keyFn: (req) => {
    const device = resolveDeviceIdFromHeader(req.headers['x-device-id']);
    if (device) return `sync-pull:device:${device}`;
    const xf = req.headers['x-forwarded-for'];
    const ip =
      (typeof xf === 'string' && xf.split(',')[0]?.trim()) ||
      req.ip ||
      req.socket.remoteAddress ||
      'unknown';
    return `sync-pull:ip:${ip}`;
  },
});

/**
 * GET /api/app/sync/changes?since={cursor}&limit=200
 * 按 Change Log 游标拉取增量事件摘要（不含业务行本体）。
 */
router.get(
  '/changes',
  (req, res, next) => {
    // 包装限流：命中 429 时记指标
    const origJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode === 429) {
        syncMetricInc('pullRateLimited');
      }
      return origJson(body);
    }) as typeof res.json;
    return syncChangesRateLimit(req, res, next);
  },
  async (req, res, next) => {
    try {
      syncMetricInc('pullRequests');
      const data = await pullSyncChanges({
        since: req.query.since as string | undefined,
        limit: req.query.limit as string | undefined,
      });
      if (data.needFullSync) {
        syncMetricInc('pullNeedFullSync');
        console.log(
          `[sync-pull] needFullSync since=${req.query.since ?? 0} cursor=${data.cursor}`,
        );
      }
      success(res, data);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/app/sync/snapshot-meta
 * Bootstrap 会话开始：读一次 cursor0，后续 snapshot 分页原样回传。
 */
router.get('/snapshot-meta', async (_req, res, next) => {
  try {
    const { getSnapshotCursor0 } = await import('../../services/sync-snapshot.js');
    success(res, { syncCursor: await getSnapshotCursor0(), serverTime: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/app/sync/snapshot?table=tasks&limit=200&after=lastPk
 * 账号级全量快照分页（完整表，无日期过滤）。不是 /sync/full 新协议，
 * 而是 bootstrap 家族的 snapshot 模式；taskView 视图不走这里。
 */
router.get('/snapshot', async (req, res, next) => {
  try {
    const { pullSnapshotTable } = await import('../../services/sync-snapshot.js');
    const table = String(req.query.table ?? '');
    const after = req.query.after == null || req.query.after === '' ? null : String(req.query.after);
    const limit = Number(req.query.limit ?? 200);
    const cursor0 = Number(req.query.cursor0 ?? NaN);
    const { getSnapshotCursor0 } = await import('../../services/sync-snapshot.js');
    const c0 = Number.isFinite(cursor0) && cursor0 >= 0 ? Math.floor(cursor0) : await getSnapshotCursor0();
    const data = await pullSnapshotTable(table, after, limit, c0);
    success(res, data);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/app/sync/stats
 * 运维：SSE 在线人数 + 进程内同步计数器（不含业务数据）。
 */
router.get('/stats', (_req, res) => {
  success(res, {
    sse: getSyncSseStats(),
    metrics: getSyncMetricsSnapshot(),
  });
});

/**
 * GET /api/app/sync/stream
 * SSE：鉴权后长连接；写成功后推送轻量 { type, cursor, dirtyTables }。
 * 客户端收到后应再 pull，勿信任推送内业务数据。
 */
router.get('/stream', (req, res) => {
  const deviceId = resolveDeviceIdFromHeader(req.headers['x-device-id']);

  // 同 device 并发连接上限，防止重连风暴占满
  if (deviceId && syncConfig.sseMaxPerDevice > 0) {
    const stats = getSyncSseStats();
    const userBucket = stats.byUser.find((u) => u.userId === DEFAULT_SYNC_USER_ID);
    const sameDevice = userBucket?.devices.filter((d) => d === deviceId).length ?? 0;
    if (sameDevice >= syncConfig.sseMaxPerDevice) {
      return fail(res, '该设备 SSE 连接数已达上限，请关闭旧会话后重试', -1, 429);
    }
  }

  // 关闭压缩 / 代理缓冲，保证心跳与事件及时下发
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // compression 中间件：显式声明不压缩
  (res as typeof res & { flush?: () => void }).flushHeaders?.();

  // 禁用 socket 超时（由心跳保活）
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);

  const conn = registerSyncSseConnection({
    userId: DEFAULT_SYNC_USER_ID,
    deviceId,
    res,
  });
  const stopHeartbeat = startSyncSseHeartbeat(conn);

  const cleanup = () => {
    stopHeartbeat();
    unregisterSyncSseConnection(conn);
  };

  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
});

export { syncChangesRateLimit };
export default router;
