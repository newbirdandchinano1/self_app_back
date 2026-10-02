import type { Request, Response, NextFunction } from 'express';
import { SlidingWindowRateLimiter } from '../utils/rate-limiter.js';
import { fail } from '../utils/response.js';

export type RateLimitOptions = {
  /** 窗口内最大请求数 */
  max: number;
  /** 窗口毫秒 */
  windowMs: number;
  /** 限流键；默认 IP */
  keyFn?: (req: Request) => string;
  /** 超限文案 */
  message?: string;
};

/**
 * Express 滑动窗口限流中间件。
 */
export function createRateLimitMiddleware(opts: RateLimitOptions) {
  const limiter = new SlidingWindowRateLimiter(opts.max, opts.windowMs);
  const keyFn =
    opts.keyFn ??
    ((req: Request) => {
      const xf = req.headers['x-forwarded-for'];
      if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0]!.trim();
      return req.ip || req.socket.remoteAddress || 'unknown';
    });
  const message = opts.message ?? '请求过于频繁，请稍后重试';

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const key = keyFn(req);
    if (!limiter.tryConsume(key)) {
      const retry = limiter.retryAfterSec(key);
      if (retry > 0) res.setHeader('Retry-After', String(retry));
      return fail(res, message, -1, 429);
    }
    next();
  };

  /** 测试 / 运维：清空计数 */
  (middleware as typeof middleware & { reset: (key?: string) => void }).reset = (key?: string) =>
    limiter.reset(key);

  return middleware as typeof middleware & { reset: (key?: string) => void };
}
