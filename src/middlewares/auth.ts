import type { Request, Response, NextFunction } from 'express';
import { fail } from '../utils/response.js';
import { verifyToken, type AdminPayload } from '../services/auth.js';

declare global {
  namespace Express {
    interface Request {
      admin?: AdminPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return fail(res, '请先登录', -1, 401);
  }

  try {
    req.admin = verifyToken(header.slice(7));
    next();
  } catch {
    return fail(res, '登录已过期，请重新登录', -1, 401);
  }
}
