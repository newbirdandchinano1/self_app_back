import type { Request, Response, NextFunction } from 'express';
import { concurrencyConfig } from '../config/index.js';
import { ConcurrencyLimiter } from '../utils/concurrency-limiter.js';
import { fail } from '../utils/response.js';

const limiters = new Map<string, ConcurrencyLimiter>();

export type ConcurrencyPoolKind = 'light' | 'page' | 'sync' | 'write' | 'global';

function getLimiter(key: string, max: number): ConcurrencyLimiter {
  let limiter = limiters.get(key);
  if (!limiter || limiter.maxConcurrent !== max) {
    limiter = new ConcurrencyLimiter(max);
    limiters.set(key, limiter);
  }
  return limiter;
}

/**
 * SSE / agent 只读快照不占并发槽：
 * - SSE 长连接若计入会一直占槽到断开
 * - Agent 工具轮次短时多域并发，占满后会让 App 同步/CRUD 连环 503
 */
export function shouldSkipConcurrency(req: Request): boolean {
  const path = req.path || '';
  const original = (req as Request & { originalUrl?: string }).originalUrl || '';
  if (path.includes('/sync/stream') || original.includes('/sync/stream')) return true;
  if (path.includes('/agent/') || original.includes('/agent/')) return true;
  const accept = req.headers.accept;
  if (typeof accept === 'string' && accept.includes('text/event-stream')) return true;
  return false;
}

function pathBlob(req: Request): string {
  const path = req.path || '';
  const original = (req as Request & { originalUrl?: string }).originalUrl || '';
  return `${path} ${original}`;
}

/**
 * 按路由分池：轻量读 / 页面重查询 / 同步 / 写入。
 * 验收：同步流量不会挤占任务页槽位。
 */
export function classifyConcurrencyPool(req: Request): ConcurrencyPoolKind {
  const method = (req.method || 'GET').toUpperCase();
  const p = pathBlob(req);

  if (p.includes('/sync')) {
    return 'sync';
  }

  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    return 'write';
  }

  // 页面重查询（任务页核心 + 聚合读）
  if (
    p.includes('/pages/tasks') ||
    p.includes('/pages/projects') ||
    p.includes('habits-grid') ||
    p.includes('completion-heatmap') ||
    p.includes('/pages/tasks/catalog') ||
    p.includes('/overview') ||
    /\/points(\/|$|\?)/.test(p)
  ) {
    return 'page';
  }

  return 'light';
}

function poolMax(kind: ConcurrencyPoolKind): number {
  switch (kind) {
    case 'light':
      return concurrencyConfig.lightMax;
    case 'page':
      return concurrencyConfig.pageMax;
    case 'sync':
      return concurrencyConfig.syncMax;
    case 'write':
      return concurrencyConfig.writeMax;
    case 'global':
    default:
      return concurrencyConfig.apiMax;
  }
}

function identityKey(req: Request): string {
  const admin = req.admin;
  if (admin?.id) return `u:${admin.id}`;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.length > 20) {
    // 未验签；仅作公平性分桶（池上限仍是硬闸）
    try {
      const parts = auth.slice(7).split('.');
      if (parts.length >= 2 && parts[1]) {
        const json = Buffer.from(parts[1], 'base64url').toString('utf8');
        const payload = JSON.parse(json) as { id?: string };
        if (payload?.id) return `u:${payload.id}`;
      }
    } catch {
      /* fall through */
    }
    return `t:${auth.slice(7, 23)}`;
  }
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return `ip:${xf.split(',')[0]!.trim()}`;
  return `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
}

function rejectBusy(res: Response, requestId?: string) {
  res.setHeader('Retry-After', '1');
  if (requestId) res.setHeader('X-Request-Id', requestId);
  return fail(res, '服务器繁忙，请稍后重试', -1, 503, {
    retryAfterSec: 1,
    requestId: requestId ?? null,
  });
}

function attachRelease(res: Response, release: () => void) {
  let released = false;
  const once = () => {
    if (released) return;
    released = true;
    release();
  };
  res.on('finish', once);
  res.on('close', once);
}

/**
 * 单池中间件（admin 路由 / 兼容旧行为）。
 */
export function createConcurrencyMiddleware(
  key: string,
  maxConcurrent: number,
  enabled = true,
) {
  if (!enabled || maxConcurrent < 1) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  const limiter = getLimiter(key, maxConcurrent);

  return (req: Request, res: Response, next: NextFunction) => {
    if (shouldSkipConcurrency(req)) {
      return next();
    }

    if (!limiter.tryAcquire()) {
      return rejectBusy(res, req.requestId);
    }

    attachRelease(res, () => limiter.release());
    next();
  };
}

/**
 * App 分池 + 可选全局帽 + 单用户上限。
 * SSE / agent 继续 skip（见 shouldSkipConcurrency）。
 */
export function createAppConcurrencyMiddleware() {
  const enabled = concurrencyConfig.enabled;
  if (!enabled) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  const usePools = concurrencyConfig.pagePoolsEnabled;
  const globalLimiter =
    concurrencyConfig.apiMax > 0 ? getLimiter('api:global', concurrencyConfig.apiMax) : null;
  const userMax = concurrencyConfig.userMax;

  return (req: Request, res: Response, next: NextFunction) => {
    if (shouldSkipConcurrency(req)) {
      return next();
    }

    const kind: ConcurrencyPoolKind = usePools ? classifyConcurrencyPool(req) : 'global';
    const kindLimiter = getLimiter(
      usePools ? `api:pool:${kind}` : 'api',
      usePools ? poolMax(kind) : concurrencyConfig.apiMax,
    );

    const acquired: ConcurrencyLimiter[] = [];

    const tryAll = (): boolean => {
      if (globalLimiter && usePools) {
        if (!globalLimiter.tryAcquire()) return false;
        acquired.push(globalLimiter);
      }
      if (!kindLimiter.tryAcquire()) return false;
      acquired.push(kindLimiter);

      if (userMax > 0) {
        const userLimiter = getLimiter(`api:user:${identityKey(req)}`, userMax);
        if (!userLimiter.tryAcquire()) return false;
        acquired.push(userLimiter);
      }
      return true;
    };

    if (!tryAll()) {
      for (let i = acquired.length - 1; i >= 0; i -= 1) {
        acquired[i]!.release();
      }
      return rejectBusy(res, req.requestId);
    }

    attachRelease(res, () => {
      for (let i = acquired.length - 1; i >= 0; i -= 1) {
        acquired[i]!.release();
      }
    });
    next();
  };
}

/** @internal 自测 / 运维 */
export function __resetConcurrencyLimitersForTest(): void {
  limiters.clear();
}
