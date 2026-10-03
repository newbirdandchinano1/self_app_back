import type { Request } from 'express';
import {
  resolveDeviceIdFromHeader,
  type SyncWriteOptions,
} from '../services/sync-change-log.js';
import { extractSyncWriteMeta } from '../services/sync-revision.js';

/** 从请求头读取 X-Device-Id（多端同步回声抑制） */
export function deviceIdFromReq(req: Request): string | null {
  return resolveDeviceIdFromHeader(req.headers['x-device-id']);
}

export function syncWriteOptionsFromReq(req: Request): SyncWriteOptions {
  const body =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  const query = req.query && typeof req.query === 'object' ? req.query : {};
  const fromBody = extractSyncWriteMeta(body);
  const fromQuery = extractSyncWriteMeta(query as Record<string, unknown>);
  return {
    deviceId: deviceIdFromReq(req),
    mutationId: fromBody.meta.mutationId ?? fromQuery.meta.mutationId,
    expectedRev: fromBody.meta.expectedRev ?? fromQuery.meta.expectedRev,
  };
}
