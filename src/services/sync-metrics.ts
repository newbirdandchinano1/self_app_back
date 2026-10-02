/**
 * 多端同步进程内指标（限流命中、pull、SSE 广播）。
 * 单实例有效；供 /sync/stats 与日志观测。
 */

type CounterBag = Record<string, number>;

const counters: CounterBag = {
  pullRequests: 0,
  pullNeedFullSync: 0,
  pullRateLimited: 0,
  sseConnects: 0,
  sseDisconnects: 0,
  ssePublishCalls: 0,
  ssePublishDelivered: 0,
  changeLogPurgedRows: 0,
};

export function syncMetricInc(name: keyof typeof counters, by = 1): void {
  counters[name] = (counters[name] ?? 0) + by;
}

export function getSyncMetricsSnapshot(): CounterBag & { updatedAt: string } {
  return { ...counters, updatedAt: new Date().toISOString() };
}

/** 测试用 */
export function resetSyncMetricsForTests(): void {
  for (const k of Object.keys(counters)) {
    counters[k as keyof typeof counters] = 0;
  }
}
