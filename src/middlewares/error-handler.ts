import { Request, Response, NextFunction } from 'express';
import { fail } from '../utils/response.js';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  console.error('[Error]', err.message);

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

  return fail(res, err.message || '服务器内部错误', -1, 500);
}
