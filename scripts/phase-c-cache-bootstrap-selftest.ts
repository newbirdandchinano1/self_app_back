/**
 * 阶段 C 自测（不连库）：缓存抽象、失效标签、bootstrap-v2 开关与指纹。
 *
 *   npx tsx scripts/phase-c-cache-bootstrap-selftest.ts
 */
import assert from 'node:assert/strict';
import { MemoryCache } from '../src/cache/memory-cache.js';
import {
  CACHE_TAGS,
  __resetTasksPageCacheForTest,
  invalidateTasksCachesForTables,
  memoryCache,
} from '../src/cache/index.js';
import { cacheConfig, tasksPageConfig } from '../src/config/index.js';
import {
  TASKS_BOOTSTRAP_V2_VERSION,
  assertBootstrapV2Enabled,
  fingerprintBootstrapV2Query,
} from '../src/services/pages/tasks-bootstrap-v2.js';
import { TasksBootstrapError } from '../src/services/pages/tasks-bootstrap.js';

function section(name: string) {
  console.log(`\n== ${name} ==`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  section('config defaults');
  {
    assert.equal(cacheConfig.enabled, true);
    assert.ok(cacheConfig.catalogTtlMs >= 30_000 && cacheConfig.catalogTtlMs <= 120_000);
    assert.ok(cacheConfig.heatmapTtlMs >= 30_000 && cacheConfig.heatmapTtlMs <= 120_000);
    assert.equal(cacheConfig.dayBoundaryTtlMs, 300_000);
    assert.equal(tasksPageConfig.bootstrapV2Enabled, false, '默认关，可灰度开启');
    console.log('ok cache + bootstrap-v2 flags');
  }

  section('MemoryCache TTL / hit / miss');
  {
    const c = new MemoryCache();
    let loads = 0;
    const r1 = await c.getOrSet(
      'k1',
      async () => {
        loads += 1;
        return { n: 1 };
      },
      { ttlMs: 5_000, swrMs: 0 },
    );
    assert.equal(r1.kind, 'miss');
    assert.equal(r1.value.n, 1);

    const r2 = await c.getOrSet(
      'k1',
      async () => {
        loads += 1;
        return { n: 2 };
      },
      { ttlMs: 5_000 },
    );
    assert.equal(r2.kind, 'hit');
    assert.equal(r2.value.n, 1);
    assert.equal(loads, 1);

    const stats = c.stats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
    assert.equal(stats.sets, 1);
    console.log('ok TTL hit/miss', stats);
  }

  section('MemoryCache SWR stale + background refresh');
  {
    const c = new MemoryCache();
    let loads = 0;
    await c.getOrSet(
      'swr',
      async () => {
        loads += 1;
        return 'v1';
      },
      { ttlMs: 30, swrMs: 5_000 },
    );

    await sleep(50);
    const stale = await c.getOrSet(
      'swr',
      async () => {
        await sleep(20);
        loads += 1;
        return 'v2';
      },
      { ttlMs: 30, swrMs: 5_000 },
    );
    assert.equal(stale.kind, 'stale');
    assert.equal(stale.value, 'v1');

    await sleep(60);
    const after = c.get<string>('swr');
    assert.ok(after);
    assert.equal(after!.value, 'v2');
    assert.equal(loads, 2);
    assert.ok(c.stats().staleHits >= 1);
    console.log('ok SWR', c.stats());
  }

  section('MemoryCache single-flight + 异常不缓存');
  {
    const c = new MemoryCache();
    let loads = 0;
    const loader = async () => {
      loads += 1;
      await sleep(40);
      return 'ok';
    };
    const [a, b] = await Promise.all([
      c.getOrSet('sf', loader, { ttlMs: 5_000, maxWaitMs: 5_000 }),
      c.getOrSet('sf', loader, { ttlMs: 5_000, maxWaitMs: 5_000 }),
    ]);
    assert.equal(a.value, 'ok');
    assert.equal(b.value, 'ok');
    assert.equal(loads, 1, '并发应 single-flight 合并');

    let failed = 0;
    await assert.rejects(
      () =>
        c.getOrSet(
          'err',
          async () => {
            failed += 1;
            throw new Error('boom');
          },
          { ttlMs: 5_000 },
        ),
      /boom/,
    );
    assert.equal(c.get('err'), undefined, '异常不得写入缓存');
    assert.equal(c.stats().errors, 1);

    await c.getOrSet(
      'err',
      async () => {
        failed += 1;
        return 'recovered';
      },
      { ttlMs: 5_000 },
    );
    assert.equal(failed, 2);
    console.log('ok single-flight + no-cache-on-error');
  }

  section('tag invalidation');
  {
    __resetTasksPageCacheForTest();
    await memoryCache.getOrSet(
      'catalog:anon:full',
      async () => ({ ok: true }),
      { ttlMs: 60_000, tags: [CACHE_TAGS.catalog] },
    );
    await memoryCache.getOrSet(
      'heatmap:anon:x',
      async () => ({ ok: true }),
      { ttlMs: 60_000, tags: [CACHE_TAGS.heatmap] },
    );
    await memoryCache.getOrSet(
      'bootstrap-v2:anon:x',
      async () => ({ ok: true }),
      { ttlMs: 15_000, tags: [CACHE_TAGS.bootstrapV2] },
    );

    const n = invalidateTasksCachesForTables(['projects']);
    assert.ok(n >= 2, `projects 应失效 catalog+bootstrap(+heatmap)，实际 ${n}`);
    assert.equal(memoryCache.get('catalog:anon:full'), undefined);
    assert.equal(memoryCache.get('bootstrap-v2:anon:x'), undefined);
    assert.equal(memoryCache.get('heatmap:anon:x'), undefined);

    await memoryCache.getOrSet(
      'day-boundary:anon',
      async () => ({ h: 4 }),
      { ttlMs: 300_000, tags: [CACHE_TAGS.dayBoundary] },
    );
    invalidateTasksCachesForTables(['app_settings']);
    assert.equal(memoryCache.get('day-boundary:anon'), undefined);
    console.log('ok invalidate by dirty tables');
  }

  section('bootstrap-v2 gate + fingerprint');
  {
    assert.equal(TASKS_BOOTSTRAP_V2_VERSION, 'tasks-bootstrap-v2');
    assert.throws(
      () => assertBootstrapV2Enabled(),
      (err: unknown) => err instanceof TasksBootstrapError && err.status === 404,
    );

    const fp1 = fingerprintBootstrapV2Query({
      dayBoundaryHour: 4,
      dayBoundaryMinute: 0,
      categoryId: 'inbox',
      page: 1,
      limit: 200,
    });
    const fp2 = fingerprintBootstrapV2Query({
      dayBoundaryHour: 4,
      dayBoundaryMinute: 0,
      categoryId: 'inbox',
      page: 1,
      limit: 200,
    });
    const fp3 = fingerprintBootstrapV2Query({
      dayBoundaryHour: 4,
      dayBoundaryMinute: 0,
      categoryId: 'other',
      page: 1,
      limit: 200,
    });
    assert.equal(fp1, fp2);
    assert.notEqual(fp1, fp3);
    assert.equal(fp1.length, 24);
    console.log('ok gate + fingerprint', fp1);
  }

  section('excluded fields contract');
  {
    const excluded = [
      'habits',
      'habitCheckIns',
      'habitContexts',
      'taskExecutionEvents',
      'frogCompletionEvents',
      'heatmap',
      'pointsWallet',
    ];
    assert.equal(excluded.length, 7);
    console.log('ok excluded contract');
  }

  __resetTasksPageCacheForTest();
  console.log('\nphase-c-cache-bootstrap-selftest: ALL PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
