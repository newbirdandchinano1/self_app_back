import type { Request } from 'express';
import { resolveDeviceIdFromHeader } from '../services/sync-change-log.js';

/** 从请求头读取 X-Device-Id（多端同步回声抑制） */
export function deviceIdFromReq(req: Request): string | null {
  return resolveDeviceIdFromHeader(req.headers['x-device-id']);
}
