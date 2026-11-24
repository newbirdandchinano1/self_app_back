/**
 * 任务页相关缓存键、TTL、按表失效。
 */
import { cacheConfig } from '../config/index.js';
import { getRequestContext } from '../utils/request-context.js';
import { memoryCache, type CacheGetOrSetOptions, type CacheHitKind } from './memory-cache.js';

export const CACHE_TAGS = {
  catalog: 'tasks:catalog',
  heatmap: 'tasks:heatmap',
  dayBoundary: 'tasks:day-boundary',
  bootstrapV2: 'tasks:bootstrap-v2',
} as const;

export type TasksCacheTag = (typeof CACHE_TAGS)[keyof typeof CACHE_TAGS];

const TABLE_TO_TAGS: Record<string, TasksCacheTag[]> = {
  projects: [CACHE_TAGS.catalog, CACHE_TAGS.bootstrapV2, CACHE_TAGS.heatmap],
  project_categories: [CACHE_TAGS.catalog, CACHE_TAGS.bootstrapV2],
  task_categories: [CACHE_TAGS.catalog, CACHE_TAGS.bootstrapV2],
  tasks: [CACHE_TAGS.bootstrapV2, CACHE_TAGS.heatmap],
  task_execution_events: [CACHE_TAGS.heatmap],
  frog_completion_events: [CACHE_TAGS.heatmap],
  app_settings: [CACHE_TAGS.dayBoundary, CACHE_TAGS.heatmap, CACHE_TAGS.bootstrapV2],
};

export function cacheIdentityKey(): string {
  return getRequestContext()?.identityMasked ?? 'anon';
}

export function catalogCacheKey(updatedSince?: string): string {
  const since = updatedSince?.trim() || 'full';
  return `catalog:${cacheIdentityKey()}:${since}`;
}

export function dayBoundaryCacheKey(): string {
  return `day-boundary:${cacheIdentityKey()}`;
}

export function heatmapCacheKey(parts: {
  start: string;
  end: string;
  hour: number;
  minute: number;
  day?: string;
  includeDayDetail?: boolean;
}): string {
  const detail =
    parts.includeDayDetail === true && parts.day?.trim()
      ? `detail:${parts.day.trim()}`
      : 'counts';
  return `heatmap:${cacheIdentityKey()}:${parts.start}:${parts.end}:b${parts.hour}:${parts.minute}:${detail}`;
}

export function bootstrapV2CacheKey(queryFingerprint: string): string {
  return `bootstrap-v2:${cacheIdentityKey()}:${queryFingerprint}`;
}

export function catalogCacheOpts(): CacheGetOrSetOptions {
  return {
    ttlMs: cacheConfig.catalogTtlMs,
    swrMs: cacheConfig.catalogSwrMs,
    tags: [CACHE_TAGS.catalog],
    maxWaitMs: cacheConfig.singleFlightMaxWaitMs,
  };
}

export function dayBoundaryCacheOpts(): CacheGetOrSetOptions {
  return {
    ttlMs: cacheConfig.dayBoundaryTtlMs,
    swrMs: cacheConfig.dayBoundarySwrMs,
    tags: [CACHE_TAGS.dayBoundary],
    maxWaitMs: cacheConfig.singleFlightMaxWaitMs,
  };
}

export function heatmapCacheOpts(): CacheGetOrSetOptions {
  return {
    ttlMs: cacheConfig.heatmapTtlMs,
    swrMs: cacheConfig.heatmapSwrMs,
    tags: [CACHE_TAGS.heatmap],
    maxWaitMs: cacheConfig.singleFlightMaxWaitMs,
  };
}

export function bootstrapV2CacheOpts(): CacheGetOrSetOptions {
  return {
    ttlMs: cacheConfig.bootstrapV2TtlMs,
    swrMs: cacheConfig.bootstrapV2SwrMs,
    tags: [CACHE_TAGS.bootstrapV2],
    maxWaitMs: cacheConfig.singleFlightMaxWaitMs,
  };
}

/** 写入后按 dirty tables 失效相关缓存 */
export function invalidateTasksCachesForTables(tables: Iterable<string>): number {
  const tags = new Set<TasksCacheTag>();
  for (const raw of tables) {
    const table = String(raw ?? '').trim();
    const mapped = TABLE_TO_TAGS[table];
    if (!mapped) continue;
    for (const tag of mapped) tags.add(tag);
  }
  let n = 0;
  for (const tag of tags) {
    n += memoryCache.invalidateByTag(tag);
  }
  return n;
}

export function invalidateAllTasksPageCaches(): number {
  let n = 0;
  for (const tag of Object.values(CACHE_TAGS)) {
    n += memoryCache.invalidateByTag(tag);
  }
  return n;
}

export async function cachedGetOrSet<T>(
  key: string,
  loader: () => Promise<T>,
  opts: CacheGetOrSetOptions,
): Promise<{ value: T; kind: CacheHitKind }> {
  if (!cacheConfig.enabled) {
    return { value: await loader(), kind: 'miss' };
  }
  return memoryCache.getOrSet(key, loader, opts);
}

export function getTasksPageCacheStats() {
  return memoryCache.stats();
}

/** 仅自测 */
export function __resetTasksPageCacheForTest(): void {
  memoryCache.clear();
}
