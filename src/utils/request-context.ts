import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export type RequestDbTimings = {
  acquireWaitMs: number;
  queryMs: number;
  queryCount: number;
};

export type RequestMetricsState = {
  requestId: string;
  route: string;
  identityMasked: string;
  db: RequestDbTimings;
  /** 慢 SQL 模板哈希（生产不记参数） */
  slowSqlHashes: string[];
};

const als = new AsyncLocalStorage<RequestMetricsState>();

export function createRequestId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand}`;
}

/** 脱敏身份：admin id / username → 短哈希 */
export function maskIdentity(raw: string | undefined | null): string {
  const t = (raw ?? '').trim();
  if (!t) return '-';
  return createHash('sha256').update(t).digest('hex').slice(0, 10);
}

/** SQL 模板归一化后哈希（去多余空白；不包含绑定参数） */
export function hashSqlTemplate(sql: string): string {
  const normalized = sql.replace(/\s+/g, ' ').trim().slice(0, 2000);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export function runWithRequestContext<T>(state: RequestMetricsState, fn: () => T): T {
  return als.run(state, fn);
}

export function getRequestContext(): RequestMetricsState | undefined {
  return als.getStore();
}

export function recordDbAcquireWait(ms: number): void {
  const store = als.getStore();
  if (!store) return;
  store.db.acquireWaitMs += Math.max(0, ms);
}

export function recordDbQuery(ms: number, sql?: string, slowThresholdMs = 200): void {
  const store = als.getStore();
  if (!store) return;
  store.db.queryMs += Math.max(0, ms);
  store.db.queryCount += 1;
  if (sql && ms >= slowThresholdMs) {
    const h = hashSqlTemplate(sql);
    if (store.slowSqlHashes.length < 20) {
      store.slowSqlHashes.push(`${h}:${Math.round(ms)}`);
    }
  }
}
