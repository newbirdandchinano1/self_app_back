import type { Request, Response, NextFunction } from 'express';
import {
  createRequestId,
  maskIdentity,
  runWithRequestContext,
  type RequestMetricsState,
} from '../utils/request-context.js';
import { getPoolStats } from '../db/index.js';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

function resolveRoute(req: Request): string {
  const base = req.baseUrl || '';
  const routePath = req.route?.path;
  if (typeof routePath === 'string') {
    return `${base}${routePath}`;
  }
  const url = (req.originalUrl || req.url || req.path || '').split('?')[0] ?? '';
  return url || req.path || '-';
}

function resolveIdentity(req: Request): string {
  const admin = req.admin;
  if (admin?.id) return maskIdentity(admin.id);
  if (admin?.username) return maskIdentity(admin.username);
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.length > 20) {
    return maskIdentity(auth.slice(7, 39));
  }
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) {
    return maskIdentity(`ip:${xf.split(',')[0]!.trim()}`);
  }
  return maskIdentity(`ip:${req.ip || req.socket.remoteAddress || 'unknown'}`);
}

/**
 * 请求级指标：request_id、耗时拆分、连接池快照。
 * 生产日志不含 SQL 参数，仅模板哈希。
 */
export function requestMetricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers['x-request-id'];
  const requestId =
    typeof incoming === 'string' && incoming.trim()
      ? incoming.trim().slice(0, 64)
      : createRequestId();

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const state: RequestMetricsState = {
    requestId,
    route: resolveRoute(req),
    identityMasked: '-',
    db: { acquireWaitMs: 0, queryMs: 0, queryCount: 0 },
    slowSqlHashes: [],
  };

  const started = Date.now();
  let serializeMs = 0;
  let responseBytes = 0;

  const origJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    const t0 = Date.now();
    try {
      responseBytes = Buffer.byteLength(JSON.stringify(body ?? null), 'utf8');
    } catch {
      responseBytes = 0;
    }
    serializeMs = Date.now() - t0;
    return origJson(body);
  }) as Response['json'];

  const origSend = res.send.bind(res);
  res.send = ((body?: unknown) => {
    if (responseBytes === 0 && body != null) {
      if (typeof body === 'string') responseBytes = Buffer.byteLength(body, 'utf8');
      else if (Buffer.isBuffer(body)) responseBytes = body.length;
    }
    return origSend(body as never);
  }) as Response['send'];

  res.on('finish', () => {
    // auth 之后才有 admin；finish 时再取一次
    state.identityMasked = resolveIdentity(req);
    state.route = resolveRoute(req);

    const totalMs = Date.now() - started;
    const dbAcquire = state.db.acquireWaitMs;
    const dbQuery = state.db.queryMs;
    const nodeComputeMs = Math.max(0, totalMs - dbAcquire - dbQuery - serializeMs);
    const pool = getPoolStats();

    const line = {
      type: 'http_metrics',
      request_id: state.requestId,
      identity: state.identityMasked,
      method: req.method,
      route: state.route,
      status: res.statusCode,
      total_ms: totalMs,
      db_acquire_wait_ms: Math.round(dbAcquire),
      db_query_ms: Math.round(dbQuery),
      db_query_count: state.db.queryCount,
      node_compute_ms: Math.round(nodeComputeMs),
      serialize_ms: Math.round(serializeMs),
      response_bytes: responseBytes,
      pool_active: pool.active,
      pool_idle: pool.idle,
      pool_waiting: pool.waiting,
      pool_limit: pool.limit,
      ...(state.slowSqlHashes.length > 0 ? { slow_sql: state.slowSqlHashes } : {}),
    };

    // 覆盖热点路由或慢请求 / 错误
    const hot =
      /\/pages\/tasks|\/pages\/projects|\/habits-grid|completion-heatmap|\/points|\/sync/.test(
        state.route,
      );
    if (hot || totalMs >= 500 || res.statusCode >= 400 || dbAcquire >= 50) {
      console.log(JSON.stringify(line));
    }
  });

  runWithRequestContext(state, () => next());
}
