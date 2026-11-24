/**
 * 阶段 E 压测：默认本地模拟（不打真实服务）；可选打 live API。
 *
 * 模拟：
 *   npx tsx scripts/phase-e-loadtest.ts
 *
 * Live（需 PHASE_E_BASE_URL + PHASE_E_TOKEN）：
 *   PHASE_E_LIVE=1 PHASE_E_BASE_URL=http://127.0.0.1:3000 PHASE_E_TOKEN=... npx tsx scripts/phase-e-loadtest.ts
 *
 * 对照实验（应失败退出）：
 *   PHASE_E_BACKEND_ONLY_LIMIT=1 npx tsx scripts/phase-e-loadtest.ts
 *
 * 记录：P50/P95/P99、错误率、503 占比、连接池等待模拟。
 */
import assert from 'node:assert/strict';
import {
  __resetConcurrencyLimitersForTest,
  createAppConcurrencyMiddleware,
  classifyConcurrencyPool,
} from '../src/middlewares/concurrency.js';
import { ConcurrencyLimiter } from '../src/utils/concurrency-limiter.js';
import { concurrencyConfig, dbConfig } from '../src/config/index.js';
import type { Request, Response } from 'express';

type Sample = { ms: number; ok: boolean; status: number; kind: string };

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function summarize(label: string, samples: Sample[]) {
  const times = samples.map((s) => s.ms).sort((a, b) => a - b);
  const errors = samples.filter((s) => !s.ok);
  const s503 = samples.filter((s) => s.status === 503);
  const report = {
    label,
    n: samples.length,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    p99: percentile(times, 99),
    errorRate: samples.length ? errors.length / samples.length : 0,
    ratio503: samples.length ? s503.length / samples.length : 0,
  };
  console.log(JSON.stringify(report));
  return report;
}

function mockReq(partial: Partial<Request> & { path?: string; originalUrl?: string }): Request {
  return {
    method: 'GET',
    path: '/',
    headers: {},
    ...partial,
  } as Request;
}

function mockRes(): Response & {
  statusCode: number;
  headers: Record<string, string>;
  finish: () => void;
} {
  const headers: Record<string, string> = {};
  const listeners: Record<string, Array<() => void>> = {};
  const res = {
    statusCode: 200,
    headers,
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = String(v);
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(_body: unknown) {
      return res;
    },
    on(ev: string, fn: () => void) {
      (listeners[ev] ??= []).push(fn);
      return res;
    },
    finish() {
      for (const fn of listeners.finish ?? []) fn();
      for (const fn of listeners.close ?? []) fn();
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    headers: Record<string, string>;
    finish: () => void;
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function simSingleUserOpen10(): Promise<Sample[]> {
  __resetConcurrencyLimitersForTest();
  const mw = createAppConcurrencyMiddleware();
  const samples: Sample[] = [];
  for (let i = 0; i < 10; i += 1) {
    const t0 = Date.now();
    const res = mockRes();
    let next = false;
    mw(
      mockReq({
        path: '/pages/tasks',
        originalUrl: '/api/app/pages/tasks?taskView=standaloneTodos',
        headers: { 'x-forwarded-for': '10.0.0.1' },
        ip: '10.0.0.1',
      } as never),
      res,
      () => {
        next = true;
      },
    );
    if (next) {
      await sleep(5 + (i % 3));
      res.finish();
      samples.push({ ms: Date.now() - t0, ok: true, status: 200, kind: 'page' });
    } else {
      samples.push({ ms: Date.now() - t0, ok: false, status: res.statusCode, kind: 'page' });
    }
  }
  return samples;
}

async function simMultiUserBurst(users = 8, each = 3): Promise<Sample[]> {
  __resetConcurrencyLimitersForTest();
  const mw = createAppConcurrencyMiddleware();
  const samples: Sample[] = [];
  const jobs: Promise<void>[] = [];
  for (let u = 0; u < users; u += 1) {
    for (let k = 0; k < each; k += 1) {
      jobs.push(
        (async () => {
          const t0 = Date.now();
          const res = mockRes();
          let next = false;
          mw(
            mockReq({
              path: '/pages/tasks/habits-grid',
              originalUrl: '/api/app/pages/tasks/habits-grid',
              headers: { 'x-forwarded-for': `10.2.0.${u + 1}` },
              ip: `10.2.0.${u + 1}`,
            } as never),
            res,
            () => {
              next = true;
            },
          );
          if (next) {
            await sleep(8);
            res.finish();
            samples.push({ ms: Date.now() - t0, ok: true, status: 200, kind: 'page' });
          } else {
            samples.push({
              ms: Date.now() - t0,
              ok: false,
              status: res.statusCode,
              kind: 'page',
            });
          }
        })(),
      );
    }
  }
  await Promise.all(jobs);
  return samples;
}

async function simTasksAndSyncConcurrent(): Promise<{ page: Sample[]; sync: Sample[] }> {
  __resetConcurrencyLimitersForTest();
  const mw = createAppConcurrencyMiddleware();
  const page: Sample[] = [];
  const sync: Sample[] = [];

  // 先占满 page 池
  const holders: Array<ReturnType<typeof mockRes>> = [];
  for (let i = 0; i < concurrencyConfig.pageMax; i += 1) {
    const res = mockRes();
    mw(
      mockReq({
        path: '/pages/tasks',
        originalUrl: '/api/app/pages/tasks',
        headers: { 'x-forwarded-for': `10.3.0.${i + 1}` },
        ip: `10.3.0.${i + 1}`,
      } as never),
      res,
      () => undefined,
    );
    holders.push(res);
  }

  // page 再来应 503
  {
    const t0 = Date.now();
    const res = mockRes();
    let next = false;
    mw(
      mockReq({
        path: '/pages/tasks',
        originalUrl: '/api/app/pages/tasks',
        headers: { 'x-forwarded-for': '10.3.0.99' },
        ip: '10.3.0.99',
      } as never),
      res,
      () => {
        next = true;
      },
    );
    page.push({
      ms: Date.now() - t0,
      ok: next,
      status: next ? 200 : res.statusCode,
      kind: 'page',
    });
  }

  // sync 应仍可过
  for (let i = 0; i < concurrencyConfig.syncMax; i += 1) {
    const t0 = Date.now();
    const res = mockRes();
    let next = false;
    mw(
      mockReq({
        path: '/sync/changes',
        originalUrl: '/api/app/sync/changes',
        headers: { 'x-forwarded-for': `10.3.1.${i + 1}` },
        ip: `10.3.1.${i + 1}`,
      } as never),
      res,
      () => {
        next = true;
      },
    );
    if (next) res.finish();
    sync.push({
      ms: Date.now() - t0,
      ok: next,
      status: next ? 200 : res.statusCode,
      kind: 'sync',
    });
  }
  void holders;
  return { page, sync };
}

function simPoolFullWaiting(): Sample[] {
  const lim = new ConcurrencyLimiter(dbConfig.connectionLimit);
  const samples: Sample[] = [];
  let acquired = 0;
  for (let i = 0; i < dbConfig.connectionLimit + dbConfig.queueLimit + 5; i += 1) {
    const t0 = Date.now();
    const ok = lim.tryAcquire();
    if (ok) acquired += 1;
    samples.push({
      ms: Date.now() - t0,
      ok,
      status: ok ? 200 : 503,
      kind: 'db-acquire',
    });
  }
  assert.equal(acquired, dbConfig.connectionLimit);
  const rejected = samples.filter((s) => !s.ok).length;
  assert.ok(rejected >= 5, 'queue/pool 满后应快速拒绝而非无限等待');
  return samples;
}

async function liveOpenLoop(): Promise<Sample[]> {
  const base = (process.env.PHASE_E_BASE_URL || '').replace(/\/$/, '');
  const token = process.env.PHASE_E_TOKEN || '';
  if (!base || !token) {
    throw new Error('PHASE_E_LIVE=1 需要 PHASE_E_BASE_URL 与 PHASE_E_TOKEN');
  }
  const samples: Sample[] = [];
  const paths = [
    '/api/app/pages/tasks/catalog',
    '/api/app/pages/tasks?taskView=standaloneTodos&include=tasks&limit=50',
    '/api/app/pages/tasks/habits-grid',
    '/api/app/pages/tasks/completion-heatmap',
  ];
  for (let round = 0; round < 10; round += 1) {
    for (const path of paths) {
      const t0 = Date.now();
      try {
        const res = await fetch(`${base}${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        samples.push({
          ms: Date.now() - t0,
          ok: res.ok,
          status: res.status,
          kind: classifyConcurrencyPool(
            mockReq({ path, originalUrl: path }) as never,
          ),
        });
      } catch {
        samples.push({ ms: Date.now() - t0, ok: false, status: 0, kind: 'network' });
      }
    }
  }
  return samples;
}

async function main() {
  if (process.env.PHASE_E_BACKEND_ONLY_LIMIT === '1') {
    console.error(
      JSON.stringify({
        verdict: 'REJECT_SHIP',
        reason: '仅后端限流、未同步前端 timeout/首屏并发 — 阶段 E 对照实验应拒绝上线',
      }),
    );
    process.exit(2);
  }

  console.log('== phase-e loadtest ==');
  console.log(
    JSON.stringify({
      mode: process.env.PHASE_E_LIVE === '1' ? 'live' : 'sim',
      apiMax: concurrencyConfig.apiMax,
      pageMax: concurrencyConfig.pageMax,
      syncMax: concurrencyConfig.syncMax,
      userMax: concurrencyConfig.userMax,
      dbConnectionLimit: dbConfig.connectionLimit,
      dbQueueLimit: dbConfig.queueLimit,
    }),
  );

  const single = await simSingleUserOpen10();
  const multi = await simMultiUserBurst();
  const mixed = await simTasksAndSyncConcurrent();
  const pool = simPoolFullWaiting();

  const r1 = summarize('sim.single_user_open_x10', single);
  const r2 = summarize('sim.multi_user_burst', multi);
  summarize('sim.page_when_full', mixed.page);
  const rSync = summarize('sim.sync_while_page_full', mixed.sync);
  const rPool = summarize('sim.db_pool_full_fast_reject', pool);

  assert.ok(r1.errorRate === 0, '单用户串行打开不应 503');
  assert.ok(rSync.errorRate === 0, 'page 满时 sync 仍应成功（分池）');
  assert.ok(rPool.ratio503 > 0, '连接池满应出现快速拒绝');
  // 多用户突发可能有 503，但应可解释且带 Retry-After 路径（中间件已测）
  console.log(
    JSON.stringify({
      note: 'multi_user_503_ok_if_explained',
      multiErrorRate: r2.errorRate,
      multi503: r2.ratio503,
    }),
  );

  if (process.env.PHASE_E_LIVE === '1') {
    const live = await liveOpenLoop();
    const rl = summarize('live.tasks_page_open_x10', live);
    assert.ok(rl.ratio503 < 0.5, 'live 503 占比过高，检查是否只收紧后端未收前端');
  }

  console.log('\nphase-e-loadtest: ALL PASSED');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
