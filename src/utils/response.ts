import { Response } from 'express';

export function success(res: Response, data: unknown = null, message = 'ok') {
  return res.json({ code: 0, message, data });
}

export function fail(
  res: Response,
  message = 'error',
  code = -1,
  status = 400,
  data: unknown = null,
) {
  return res.status(status).json({ code, message, data });
}
