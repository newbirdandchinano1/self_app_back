import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { newsImportConfig } from '../config/index.js';
import { verifyToken } from '../services/auth.js';
import { fail, success } from '../utils/response.js';
import { createDomainErrorHandler } from '../utils/domain-error-handler.js';
import { importNewsSnapshot, NewsImportError } from '../services/news-import.js';

/**
 * 服务器同步脚本专用接口。
 * 挂载前缀：/api/news
 *
 * POST /import — 接收 output/news/YYYY-MM-DD.db 的结构化快照
 * 认证：Authorization: Bearer <NEWS_IMPORT_TOKEN>（也兼容管理员 JWT）
 */
const router = Router();

const handleNewsImportError = createDomainErrorHandler(NewsImportError);

function requireImportAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const bearer = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : '';
  if (!bearer) return fail(res, '未授权', -1, 401);

  const expected = newsImportConfig.token;
  if (expected && bearer === expected) return next();

  try {
    req.admin = verifyToken(bearer);
    return next();
  } catch {
    return fail(res, '未授权', -1, 401);
  }
}

router.post('/import', requireImportAuth, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { reportDate?: unknown; items?: unknown };
    const data = await importNewsSnapshot(body);
    console.log(
      `[news-import] ${data.reportDate} received=${data.itemsReceived} stored=${data.itemsStored} new=${data.newItems}`,
    );
    return success(res, data, 'ok');
  } catch (err) {
    handleNewsImportError(err, res, next);
  }
});

export default router;