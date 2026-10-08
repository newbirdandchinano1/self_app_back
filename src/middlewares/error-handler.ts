import { Request, Response, NextFunction } from 'express';
import { fail } from '../utils/response.js';

/** 未捕获异常对外统一文案；原文只写日志，避免 SQL/堆栈/驱动信息泄漏到 App */
const INTERNAL_ERROR_MESSAGE = '服务器繁忙，请稍后重试';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  // express.json() 解析失败时的 SyntaxError，避免把原始 "Unexpected token…" 直接甩给 App
  const isBodyJsonSyntax =
    err instanceof SyntaxError ||
    /unexpected token|unexpected end of json|is not valid json/i.test(err.message);
  if (isBodyJsonSyntax && (err as { status?: number; type?: string }).type === 'entity.parse.failed') {
    return fail(res, '请求体不是合法 JSON，请检查客户端序列化', -1, 400);
  }
  if (isBodyJsonSyntax && /in JSON at position/i.test(err.message)) {
    return fail(res, '请求体不是合法 JSON，请检查客户端序列化', -1, 400);
  }

  console.error('[Error]', err.message);
  if (err.stack) {
    console.error(err.stack);
  }
  return fail(res, INTERNAL_ERROR_MESSAGE, -1, 500);
}
