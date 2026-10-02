import type { Response } from 'express';
import { DEFAULT_SYNC_USER_ID } from './sync-change-log.js';
import { syncMetricInc } from './sync-metrics.js';

export type SyncSseSignal = {
  type: 'changes';
  cursor: number;
  dirtyTables: string[];
};

export type SyncSseConnection = {
  id: string;
  userId: string;
  deviceId: string | null;
  res: Response;
  createdAt: number;
};

const HEARTBEAT_MS = 20_000;

/** userId → 在线连接 */
const connectionsByUser = new Map<string, Set<SyncSseConnection>>();

let connSeq = 0;

function nextConnId(): string {
  connSeq += 1;
  return `sse_${Date.now().toString(36)}_${connSeq}`;
}

function writeSse(res: Response, event: string, data: unknown): boolean {
  try {
    if (res.writableEnded || res.destroyed) return false;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function writeComment(res: Response, text: string): boolean {
  try {
    if (res.writableEnded || res.destroyed) return false;
    res.write(`: ${text}\n\n`);
    return true;
  } catch {
    return false;
  }
}

export function registerSyncSseConnection(input: {
  userId?: string | null;
  deviceId?: string | null;
  res: Response;
}): SyncSseConnection {
  const userId = (input.userId && String(input.userId).trim()) || DEFAULT_SYNC_USER_ID;
  const deviceId =
    input.deviceId == null || input.deviceId === ''
      ? null
      : String(input.deviceId).slice(0, 64);

  const conn: SyncSseConnection = {
    id: nextConnId(),
    userId,
    deviceId,
    res: input.res,
    createdAt: Date.now(),
  };

  let set = connectionsByUser.get(userId);
  if (!set) {
    set = new Set();
    connectionsByUser.set(userId, set);
  }
  set.add(conn);
  syncMetricInc('sseConnects');
  console.log(
    `[sync-sse] connect id=${conn.id} user=${userId} device=${deviceId ?? '-'} online=${set.size}`,
  );

  // 立即确认连接，便于客户端测活
  writeSse(input.res, 'ready', {
    type: 'ready',
    connectionId: conn.id,
    serverTime: new Date().toISOString(),
  });

  return conn;
}

export function unregisterSyncSseConnection(conn: SyncSseConnection): void {
  const set = connectionsByUser.get(conn.userId);
  if (!set) return;
  const had = set.delete(conn);
  if (had) {
    syncMetricInc('sseDisconnects');
    console.log(
      `[sync-sse] disconnect id=${conn.id} user=${conn.userId} device=${conn.deviceId ?? '-'} online=${set.size}`,
    );
  }
  if (set.size === 0) connectionsByUser.delete(conn.userId);
}

/**
 * 事务提交后广播轻量信号。
 * 可选跳过写入端 deviceId（回声抑制）。
 */
export function publishSyncSignal(input: {
  userId?: string | null;
  /** 写入端；同 device 的连接默认跳过 */
  skipDeviceId?: string | null;
  cursor: number;
  dirtyTables: string[];
}): number {
  const userId = (input.userId && String(input.userId).trim()) || DEFAULT_SYNC_USER_ID;
  const set = connectionsByUser.get(userId);
  if (!set || set.size === 0) return 0;

  const dirtyTables = [...new Set(input.dirtyTables.map((t) => String(t).trim()).filter(Boolean))].sort();
  const payload: SyncSseSignal = {
    type: 'changes',
    cursor: Math.floor(Number(input.cursor) || 0),
    dirtyTables,
  };

  const skip =
    input.skipDeviceId == null || input.skipDeviceId === ''
      ? null
      : String(input.skipDeviceId).slice(0, 64);

  let sent = 0;
  const dead: SyncSseConnection[] = [];

  for (const conn of set) {
    if (skip && conn.deviceId && conn.deviceId === skip) continue;
    if (writeSse(conn.res, 'changes', payload)) {
      sent += 1;
    } else {
      dead.push(conn);
    }
  }

  for (const d of dead) {
    unregisterSyncSseConnection(d);
    try {
      d.res.end();
    } catch {
      /* ignore */
    }
  }

  syncMetricInc('ssePublishCalls');
  syncMetricInc('ssePublishDelivered', sent);
  if (sent > 0 || dirtyTables.length > 0) {
    console.log(
      `[sync-sse] publish user=${userId} cursor=${payload.cursor} tables=${dirtyTables.join(',')} sent=${sent} skip=${skip ?? '-'}`,
    );
  }

  return sent;
}

/** 心跳：注释行，避免代理超时断开 */
export function startSyncSseHeartbeat(conn: SyncSseConnection): () => void {
  const timer = setInterval(() => {
    if (!writeComment(conn.res, `ping ${Date.now()}`)) {
      clearInterval(timer);
      unregisterSyncSseConnection(conn);
      try {
        conn.res.end();
      } catch {
        /* ignore */
      }
    }
  }, HEARTBEAT_MS);

  return () => clearInterval(timer);
}

/** 测试 / 运维：当前在线连接数 */
export function countSyncSseConnections(userId?: string | null): number {
  if (userId != null && String(userId).trim()) {
    return connectionsByUser.get(String(userId).trim())?.size ?? 0;
  }
  let n = 0;
  for (const set of connectionsByUser.values()) n += set.size;
  return n;
}

export type SyncSseStats = {
  totalConnections: number;
  usersOnline: number;
  byUser: Array<{
    userId: string;
    connections: number;
    devices: string[];
  }>;
};

/** 运维：在线会话摘要（不含业务数据） */
export function getSyncSseStats(): SyncSseStats {
  const byUser: SyncSseStats['byUser'] = [];
  let total = 0;
  for (const [userId, set] of connectionsByUser.entries()) {
    total += set.size;
    const devices = [...set]
      .map((c) => c.deviceId ?? '(none)')
      .sort();
    byUser.push({ userId, connections: set.size, devices });
  }
  byUser.sort((a, b) => a.userId.localeCompare(b.userId));
  return {
    totalConnections: total,
    usersOnline: byUser.length,
    byUser,
  };
}

/** 仅自测用：清空注册表 */
export function resetSyncSseHubForTests(): void {
  for (const set of connectionsByUser.values()) {
    for (const conn of set) {
      try {
        conn.res.end();
      } catch {
        /* ignore */
      }
    }
  }
  connectionsByUser.clear();
}
