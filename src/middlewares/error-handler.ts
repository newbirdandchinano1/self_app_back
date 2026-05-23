import { Request, Response, NextFunction } from 'express';
import { fail } from '../utils/response.js';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  console.error('[Error]', err.message);
  return fail(res, err.message || '服务器内部错误', -1, 500);
}
