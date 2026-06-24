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
