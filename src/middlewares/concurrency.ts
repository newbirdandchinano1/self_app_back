import type { Request, Response, NextFunction } from 'express';
import { ConcurrencyLimiter } from '../utils/concurrency-limiter.js';
import { fail } from '../utils/response.js';

const limiters = new Map<string, ConcurrencyLimiter>();

function getLimiter(key: string, max: number): ConcurrencyLimiter {
  let limiter = limiters.get(key);
  if (!limiter || limiter.maxConcurrent !== max) {
    limiter = new ConcurrencyLimiter(max);
    limiters.set(key, limiter);
  }
  return limiter;
}

function shouldSkipConcurrency(req: Request): boolean {
  // SSE 等长连接若计入并发槽，会一直占着直到断开，把短请求挤成 503「服务器繁忙」
  const path = req.path || '';
  const original = (req as Request & { originalUrl?: string }).originalUrl || '';
  if (path.includes('/sync/stream') || original.includes('/sync/stream')) return true;
  // Agent 只读快照：工具轮次可能短时并发打多个域，占满槽后会让 App 同步/CRUD 连环 503 弹「服务器繁忙」
  if (path.includes('/agent/') || original.includes('/agent/')) return true;
  const accept = req.headers.accept;
  if (typeof accept === 'string' && accept.includes('text/event-stream')) return true;
  return false;
}

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
      res.setHeader('Retry-After', '1');
      return fail(res, '服务器繁忙，请稍后重试', -1, 503);
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      limiter.release();
    };

    res.on('finish', release);
    res.on('close', release);
    next();
  };
}
