/**
 * 领域错误 → HTTP 响应（P1-09）：
 * 各 routes/app 原先各自写一套 handleXxxError / sendXxxError，行为几乎相同。
 */
import type { NextFunction, Response } from 'express';
import { fail } from './response.js';

type DomainErrorLike = Error & {
  status?: number;
  httpStatus?: number;
  body?: Record<string, unknown>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ErrorCtor = abstract new (...args: any[]) => Error;

export type DomainErrorHandlerOptions = {
  /**
   * 把 err.body 里除 ok/error 外的字段作为 fail 的 data
   *（PointsError / WishBoardError 会带 balance、cost_points 等）
   */
  includeBodyExtras?: boolean;
  /** HTTP 状态字段；AI 场景用 httpStatus */
  statusKey?: 'status' | 'httpStatus';
};

/**
 * 返回 `(err, res, next) => void`：命中任一 Error 类则 fail，否则 next。
 */
export function createDomainErrorHandler(
  ErrorClass: ErrorCtor | ErrorCtor[],
  options: DomainErrorHandlerOptions = {},
): (err: unknown, res: Response, next: NextFunction) => void {
  const classes = Array.isArray(ErrorClass) ? ErrorClass : [ErrorClass];
  const statusKey = options.statusKey ?? 'status';
  const includeBodyExtras = options.includeBodyExtras === true;

  return function handleDomainError(err: unknown, res: Response, next: NextFunction) {
    for (const Ctor of classes) {
      if (!(err instanceof Ctor)) continue;
      const e = err as DomainErrorLike;
      const status =
        statusKey === 'httpStatus'
          ? (typeof e.httpStatus === 'number' ? e.httpStatus : 400)
          : (typeof e.status === 'number' ? e.status : 400);

      let data: unknown = null;
      if (includeBodyExtras && e.body && typeof e.body === 'object') {
        const { ok: _ok, error: _error, ...rest } = e.body;
        data = Object.keys(rest).length ? rest : null;
      }

      return fail(res, e.message, -1, status, data);
    }
    next(err);
  };
}
