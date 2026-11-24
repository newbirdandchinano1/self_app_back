/**
 * 阶段 A 自测：分池分类、并发闸、request 指标工具、DB 容量错误映射。
 * 不依赖真实 MySQL。
 *
 *   npx tsx scripts/phase-a-capacity-selftest.ts
 */
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  __resetConcurrencyLimitersForTest,
  classifyConcurrencyPool,
  createAppConcurrencyMiddleware,
  createConcurrencyMiddleware,
  shouldSkipConcurrency,
} from '../src/middlewares/concurrency.js';
import { ConcurrencyLimiter } from '../src/utils/concurrency-limiter.js';
import {
  DbAcquireTimeoutError,
  DbQueueFullError,
  isDbCapacityError,
  mapMysqlPoolError,
} from '../src/utils/db-errors.js';
import {
  createRequestId,
  hashSqlTemplate,
  maskIdentity,
  runWithRequestContext,
  getRequestContext,
  recordDbAcquireWait,
  recordDbQuery,
} from '../src/utils/request-context.js';
import { dbConfig, concurrencyConfig } from '../src/config/index.js';

function mockReq(partial: Partial<Request> & { method?: string; path?: string; originalUrl?: string }): Request {
  return {
    method: 'GET',
    path: '/',
    headers: {},
    ...partial,
  } as Request;
}

function mockRes(): Response & { statusCode: number; body: unknown; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    body: null as unknown,
    headers,
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = String(v);
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    on(_ev: string, _fn: () => void) {
      return res;
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    body: unknown;
    headers: Record<string, string>;
  };
}

function section(name: string) {
  console.log(`\n== ${name} ==`);
}

section('config defaults');
assert.equal(dbConfig.connectionLimit, 20);
assert.equal(dbConfig.queueLimit, 50);
assert.equal(dbConfig.acquireTimeoutMs, 3000);
assert.equal(concurrencyConfig.apiMax, 12);
assert.equal(concurrencyConfig.pageMax, 6);
assert.equal(concurrencyConfig.syncMax, 4);
assert.equal(concurrencyConfig.writeMax, 6);
assert.equal(concurrencyConfig.lightMax, 16);
console.log('ok config');

section('classifyConcurrencyPool');
assert.equal(
  classifyConcurrencyPool(mockReq({ path: '/pages/tasks/habits-grid', originalUrl: '/api/app/pages/tasks/habits-grid' })),
  'page',
);
assert.equal(
  classifyConcurrencyPool(
    mockReq({ path: '/pages/tasks/completion-heatmap', originalUrl: '/api/app/pages/tasks/completion-heatmap' }),
  ),
  'page',
);
assert.equal(
  classifyConcurrencyPool(mockReq({ path: '/pages/projects', originalUrl: '/api/app/pages/projects' })),
  'page',
);
assert.equal(
  classifyConcurrencyPool(mockReq({ path: '/sync/changes', originalUrl: '/api/app/sync/changes' })),
  'sync',
);
assert.equal(
  classifyConcurrencyPool(
    mockReq({ method: 'POST', path: '/pages/tasks/frog-assign', originalUrl: '/api/app/pages/tasks/frog-assign' }),
  ),
  'write',
);
assert.equal(
  classifyConcurrencyPool(mockReq({ path: '/calendar/tasks/grid', originalUrl: '/api/app/calendar/tasks/grid' })),
  'light',
);
assert.equal(
  classifyConcurrencyPool(mockReq({ method: 'PUT', path: '/sync/push', originalUrl: '/api/app/sync/push' })),
  'sync',
);
console.log('ok classify');

section('shouldSkipConcurrency');
assert.equal(
  shouldSkipConcurrency(mockReq({ path: '/sync/stream', originalUrl: '/api/app/sync/stream' })),
  true,
);
assert.equal(
  shouldSkipConcurrency(mockReq({ path: '/agent/snapshot/tasks', originalUrl: '/api/app/agent/snapshot/tasks' })),
  true,
);
assert.equal(
  shouldSkipConcurrency(
    mockReq({
      path: '/pages/tasks',
      originalUrl: '/api/app/pages/tasks',
      headers: { accept: 'text/event-stream' },
    } as never),
  ),
  true,
);
assert.equal(
  shouldSkipConcurrency(mockReq({ path: '/pages/tasks', originalUrl: '/api/app/pages/tasks' })),
  false,
);
console.log('ok skip');

section('ConcurrencyLimiter');
{
  const lim = new ConcurrencyLimiter(2);
  assert.equal(lim.tryAcquire(), true);
  assert.equal(lim.tryAcquire(), true);
  assert.equal(lim.tryAcquire(), false);
  lim.release();
  assert.equal(lim.tryAcquire(), true);
}
console.log('ok limiter');

section('createConcurrencyMiddleware 503 + Retry-After');
{
  __resetConcurrencyLimitersForTest();
  const mw = createConcurrencyMiddleware('test-a', 1, true);
  const res1 = mockRes();
  let next1 = false;
  mw(mockReq({ path: '/x' }), res1, () => {
    next1 = true;
  });
  assert.equal(next1, true);

  const res2 = mockRes();
  let next2 = false;
  mw(mockReq({ path: '/x' }), res2, () => {
    next2 = true;
  });
  assert.equal(next2, false);
  assert.equal(res2.statusCode, 503);
  assert.equal(res2.headers['retry-after'], '1');
}
console.log('ok middleware busy');

section('createAppConcurrencyMiddleware sync 不挤占 page');
{
  __resetConcurrencyLimitersForTest();
  const mw = createAppConcurrencyMiddleware();
  const pageHolders: Array<ReturnType<typeof mockRes>> = [];
  // 每个请求不同身份，避免 API_USER_CONCURRENCY_MAX 先于 page 池耗尽
  for (let i = 0; i < concurrencyConfig.pageMax; i += 1) {
    const res = mockRes();
    let next = false;
    mw(
      mockReq({
        path: '/pages/tasks',
        originalUrl: '/api/app/pages/tasks',
        headers: { 'x-forwarded-for': `10.0.0.${i + 1}` },
        ip: `10.0.0.${i + 1}`,
      } as never),
      res,
      () => {
        next = true;
      },
    );
    assert.equal(next, true, `page slot ${i}`);
    pageHolders.push(res);
  }
  // page 已满
  {
    const res = mockRes();
    let next = false;
    mw(
      mockReq({
        path: '/pages/tasks',
        originalUrl: '/api/app/pages/tasks',
        headers: { 'x-forwarded-for': '10.0.0.99' },
        ip: '10.0.0.99',
      } as never),
      res,
      () => {
        next = true;
      },
    );
    assert.equal(next, false);
    assert.equal(res.statusCode, 503);
  }
  // sync 仍可过（独立池）；默认 apiMax=12 >= pageMax+1
  {
    const res = mockRes();
    let next = false;
    mw(
      mockReq({
        path: '/sync/changes',
        originalUrl: '/api/app/sync/changes',
        headers: { 'x-forwarded-for': '10.0.0.200' },
        ip: '10.0.0.200',
      } as never),
      res,
      () => {
        next = true;
      },
    );
    assert.equal(next, true, 'sync should not be blocked by full page pool');
  }
  void pageHolders;
}
console.log('ok pool isolation');

section('db errors');
assert.equal(isDbCapacityError(new DbAcquireTimeoutError()), true);
assert.equal(isDbCapacityError(new DbQueueFullError()), true);
assert.equal(isDbCapacityError(new Error('x')), false);
try {
  mapMysqlPoolError(new Error('Queue limit reached.'));
  assert.fail('expected throw');
} catch (e) {
  assert.ok(e instanceof DbQueueFullError);
}
console.log('ok db errors');

section('request context');
{
  const id = createRequestId();
  assert.ok(id.length > 4);
  assert.equal(maskIdentity('admin-1').length, 10);
  assert.notEqual(maskIdentity('a'), maskIdentity('b'));
  const h1 = hashSqlTemplate('SELECT * FROM tasks WHERE id = ?');
  const h2 = hashSqlTemplate('SELECT   *   FROM  tasks WHERE id = ?');
  assert.equal(h1, h2);
  runWithRequestContext(
    {
      requestId: id,
      route: '/pages/tasks',
      identityMasked: maskIdentity('u1'),
      db: { acquireWaitMs: 0, queryMs: 0, queryCount: 0 },
      slowSqlHashes: [],
    },
    () => {
      recordDbAcquireWait(12);
      recordDbQuery(250, 'SELECT * FROM tasks WHERE id = ?', 200);
      const ctx = getRequestContext();
      assert.ok(ctx);
      assert.equal(ctx!.db.acquireWaitMs, 12);
      assert.equal(ctx!.db.queryMs, 250);
      assert.equal(ctx!.db.queryCount, 1);
      assert.equal(ctx!.slowSqlHashes.length, 1);
    },
  );
}
console.log('ok request context');

console.log('\nphase-a-capacity-selftest: ALL PASSED');
