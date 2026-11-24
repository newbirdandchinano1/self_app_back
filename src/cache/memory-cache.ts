/**
 * 进程内缓存：TTL + stale-while-revalidate + 按 tag 失效 + 统计 + single-flight。
 * 多实例可后置 Redis，不阻塞本阶段。
 */

export type CacheStats = {
  hits: number;
  misses: number;
  staleHits: number;
  sets: number;
  deletes: number;
  errors: number;
  size: number;
  inflight: number;
};

export type CacheGetOrSetOptions = {
  /** 新鲜期（ms） */
  ttlMs: number;
  /** 过期后仍可返回旧值并后台刷新的窗口（ms）；0=关闭 SWR */
  swrMs?: number;
  /** 失效标签 */
  tags?: string[];
  /** single-flight 最长等待（ms）；超时则本请求自行加载，不接驳旧 inflight */
  maxWaitMs?: number;
};

export type CacheHitKind = 'hit' | 'miss' | 'stale';

type CacheEntry = {
  value: unknown;
  /** 新鲜截止 */
  freshUntil: number;
  /** SWR 截止（>= freshUntil） */
  staleUntil: number;
  tags: string[];
};

type InflightRecord = {
  promise: Promise<unknown>;
  startedAt: number;
};

const DEFAULT_MAX_WAIT_MS = 8_000;

export class MemoryCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, InflightRecord>();
  private readonly tagIndex = new Map<string, Set<string>>();
  private hits = 0;
  private misses = 0;
  private staleHits = 0;
  private sets = 0;
  private deletes = 0;
  private errors = 0;

  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      staleHits: this.staleHits,
      sets: this.sets,
      deletes: this.deletes,
      errors: this.errors,
      size: this.store.size,
      inflight: this.inflight.size,
    };
  }

  /** 测试 / 运维：清空全部条目与 inflight */
  clear(): void {
    this.store.clear();
    this.inflight.clear();
    this.tagIndex.clear();
  }

  get<T>(key: string): { value: T; kind: CacheHitKind } | undefined {
    const now = Date.now();
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (now <= entry.freshUntil) {
      this.hits += 1;
      return { value: entry.value as T, kind: 'hit' };
    }
    if (now <= entry.staleUntil) {
      this.staleHits += 1;
      return { value: entry.value as T, kind: 'stale' };
    }
    this.store.delete(key);
    this.unindexKey(key, entry.tags);
    return undefined;
  }

  set<T>(key: string, value: T, opts: CacheGetOrSetOptions): void {
    const now = Date.now();
    const ttl = Math.max(0, opts.ttlMs);
    const swr = Math.max(0, opts.swrMs ?? 0);
    const tags = [...new Set((opts.tags ?? []).filter(Boolean))];
    const prev = this.store.get(key);
    if (prev) this.unindexKey(key, prev.tags);

    this.store.set(key, {
      value,
      freshUntil: now + ttl,
      staleUntil: now + ttl + swr,
      tags,
    });
    this.indexKey(key, tags);
    this.sets += 1;
  }

  delete(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    this.store.delete(key);
    this.unindexKey(key, entry.tags);
    this.deletes += 1;
    return true;
  }

  invalidateByTag(tag: string): number {
    const keys = this.tagIndex.get(tag);
    if (!keys || keys.size === 0) return 0;
    let n = 0;
    for (const key of [...keys]) {
      if (this.delete(key)) n += 1;
    }
    return n;
  }

  invalidateByPrefix(prefix: string): number {
    let n = 0;
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix) && this.delete(key)) n += 1;
    }
    return n;
  }

  /**
   * 带 SWR 与 single-flight 的读穿。
   * - fresh hit：直接返回
   * - stale：立即返回旧值，并后台刷新（不阻塞）
   * - miss：single-flight 加载；异常不写入缓存
   */
  async getOrSet<T>(
    key: string,
    loader: () => Promise<T>,
    opts: CacheGetOrSetOptions,
  ): Promise<{ value: T; kind: CacheHitKind }> {
    const existing = this.get<T>(key);
    if (existing?.kind === 'hit') {
      return existing;
    }

    if (existing?.kind === 'stale') {
      void this.runLoader(key, loader, opts).catch(() => {
        /* 后台刷新失败保留 stale；错误已记 stats */
      });
      return existing;
    }

    const value = await this.runLoader(key, loader, opts);
    return { value, kind: 'miss' };
  }

  private async runLoader<T>(
    key: string,
    loader: () => Promise<T>,
    opts: CacheGetOrSetOptions,
  ): Promise<T> {
    const maxWait = Math.max(0, opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
    const current = this.inflight.get(key);
    if (current) {
      const waited = Date.now() - current.startedAt;
      if (waited < maxWait) {
        try {
          return (await current.promise) as T;
        } catch (err) {
          // 同行失败：若未超时则继续自行加载
          if (Date.now() - current.startedAt >= maxWait) throw err;
        }
      }
    }

    const startedAt = Date.now();
    let settle!: (value: unknown) => void;
    let fail!: (err: unknown) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    this.inflight.set(key, { promise, startedAt });
    this.misses += 1;

    void (async () => {
      try {
        const value = await loader();
        this.set(key, value, opts);
        settle(value);
      } catch (err) {
        this.errors += 1;
        fail(err);
      } finally {
        const still = this.inflight.get(key);
        if (still?.promise === promise) {
          this.inflight.delete(key);
        }
      }
    })();

    return promise as Promise<T>;
  }

  private indexKey(key: string, tags: string[]): void {
    for (const tag of tags) {
      let set = this.tagIndex.get(tag);
      if (!set) {
        set = new Set();
        this.tagIndex.set(tag, set);
      }
      set.add(key);
    }
  }

  private unindexKey(key: string, tags: string[]): void {
    for (const tag of tags) {
      const set = this.tagIndex.get(tag);
      if (!set) continue;
      set.delete(key);
      if (set.size === 0) this.tagIndex.delete(tag);
    }
  }
}

/** 默认全局进程内缓存（任务页 / 日界等共用） */
export const memoryCache = new MemoryCache();
