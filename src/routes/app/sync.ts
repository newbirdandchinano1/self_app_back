import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success } from '../../utils/response.js';
import { pullSyncChanges } from '../../services/sync-pull.js';
import { resolveDeviceIdFromHeader, DEFAULT_SYNC_USER_ID } from '../../services/sync-change-log.js';
import {
  registerSyncSseConnection,
  unregisterSyncSseConnection,
  startSyncSseHeartbeat,
} from '../../services/sync-sse-hub.js';

const router = Router();

router.use(requireAuth);

/**
 * GET /api/app/sync/changes?since={cursor}&limit=200
 * 按 Change Log 游标拉取增量事件摘要（不含业务行本体）。
 */
router.get('/changes', async (req, res, next) => {
  try {
    const data = await pullSyncChanges({
      since: req.query.since as string | undefined,
      limit: req.query.limit as string | undefined,
    });
    success(res, data);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/app/sync/stream
 * SSE：鉴权后长连接；写成功后推送轻量 { type, cursor, dirtyTables }。
 * 客户端收到后应再 pull，勿信任推送内业务数据。
 */
router.get('/stream', (req, res) => {
  const deviceId = resolveDeviceIdFromHeader(req.headers['x-device-id']);

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

export default router;
