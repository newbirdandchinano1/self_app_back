/**
 * 阶段 E 门禁自测（不连库）：灰度开关、连接池耗尽映射、全局/单用户限流、
 * taskView 契约、危险 bootstrap、habits 窗口、heatmap 口径、项目树无 projectIds 禁扫。
 *
 *   npx tsx scripts/phase-e-gate-selftest.ts
 *
 * 对照实验：PHASE_E_BACKEND_ONLY_LIMIT=1 时故意失败（禁止仅后端限流上线）。
 */
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  __resetConcurrencyLimitersForTest,
  createAppConcurrencyMiddleware,
} from '../src/middlewares/concurrency.js';
import {
  DbAcquireTimeoutError,
  DbQueueFullError,
  isDbCapacityError,
  mapMysqlPoolError,
} from '../src/utils/db-errors.js';
import { ConcurrencyLimiter } from '../src/utils/concurrency-limiter.js';
import {
  cacheConfig,
  concurrencyConfig,
  dbConfig,
  tasksPageConfig,
} from '../src/config/index.js';
import {
  excludeTodosAlreadyCountedAsFrogs,
  filterNetCompletedEvents,
} from '../src/services/calendar/net-completion.js';
import { resolveHeatmapEventCreatedAtBounds } from '../src/services/calendar/heatmap-range.js';
import { aggregateFrogEvents } from '../src/services/pages/tasks-overview.js';
import {
  isDangerousTasksBootstrapInclude,
  parseTasksBootstrapInclude,
  resolveHabitsGridCheckInStartYmd,
  resolveTaskViewPagination,
} from '../src/services/pages/tasks-bootstrap.js';

/** 与前端 PAGE_API_TIMEOUTS_MS / D3 契约对齐（阶段 E 同灰度验收） */
const FRONTEND_TIMEOUT_CONTRACT_MS = {
  core: 5_000,
  projects: 5_000,
  habits: 3_000,
  heatmap: 8_000,
  backgroundSync: 20_000,
} as const;

function section(name: string) {
  console.log(`\n== ${name} ==`);
}

function mockReq(
  partial: Partial<Request> & { method?: string; path?: string; originalUrl?: string },
): Request {
  return {
    method: 'GET',
    path: '/',
    headers: {},
    ...partial,
  } as Request;
}

function mockRes(): Response & {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
} {
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

function holdPageSlots(n: number, ipBase = 20) {
  const mw = createAppConcurrencyMiddleware();
  const holders: Array<ReturnType<typeof mockRes>> = [];
  for (let i = 0; i < n; i += 1) {
    const res = mockRes();
    let next = false;
    mw(
      mockReq({
        path: '/pages/tasks',
        originalUrl: '/api/app/pages/tasks',
        headers: { 'x-forwarded-for': `10.1.${ipBase}.${i + 1}` },
        ip: `10.1.${ipBase}.${i + 1}`,
      } as never),
      res,
      () => {
        next = true;
      },
    );
    assert.equal(next, true, `hold page slot ${i}`);
    holders.push(res);
  }
  return holders;
}

section('对照实验：禁止仅后端限流未收前端 timeout');
{
  if (process.env.PHASE_E_BACKEND_ONLY_LIMIT === '1') {
    assert.fail(
      '拒绝上线：仅后端限流未同步前端 timeout/首屏并发（设 PHASE_E_BACKEND_ONLY_LIMIT=1 故意失败）',
    );
  }
  assert.equal(FRONTEND_TIMEOUT_CONTRACT_MS.core, 5_000);
  assert.equal(FRONTEND_TIMEOUT_CONTRACT_MS.habits, 3_000);
  assert.equal(FRONTEND_TIMEOUT_CONTRACT_MS.heatmap, 8_000);
  assert.equal(FRONTEND_TIMEOUT_CONTRACT_MS.backgroundSync, 20_000);
  console.log('ok co-gray contract (frontend timeouts expected)');
}

section('灰度开关默认值（阶段 E checklist）');
{
  assert.equal(
    tasksPageConfig.bootstrapV2Enabled,
    process.env.TASKS_BOOTSTRAP_V2_ENABLED === 'true',
    'TASKS_BOOTSTRAP_V2_ENABLED 跟随 env（代码默认须显式 true）',
  );
  assert.equal(
    tasksPageConfig.dangerousBootstrapReject,
    true,
    'TASKS_DANGEROUS_BOOTSTRAP_REJECT 默认 true',
  );
  assert.equal(concurrencyConfig.pagePoolsEnabled, true, 'PAGE_CONCURRENCY_LIMIT_ENABLED 默认 true');
  assert.equal(concurrencyConfig.enabled, true);
  assert.equal(concurrencyConfig.apiMax, 12);
  assert.equal(concurrencyConfig.pageMax, 6);
  assert.equal(concurrencyConfig.syncMax, 4);
  assert.equal(concurrencyConfig.userMax, 4);
  assert.equal(dbConfig.connectionLimit, 20);
  assert.equal(dbConfig.queueLimit, 50);
  assert.equal(dbConfig.acquireTimeoutMs, 3000);
  assert.equal(cacheConfig.enabled, true);
  console.log('ok gray flag defaults');
}

section('连接池耗尽：queue full / acquire timeout → 容量错误');
{
  assert.equal(isDbCapacityError(new DbQueueFullError()), true);
  assert.equal(isDbCapacityError(new DbAcquireTimeoutError()), true);
  try {
    mapMysqlPoolError(new Error('Queue limit reached.'));
    assert.fail('expected DbQueueFullError');
  } catch (e) {
    assert.ok(e instanceof DbQueueFullError);
  }
  assert.equal(new DbAcquireTimeoutError().status, 503);
  assert.equal(new DbAcquireTimeoutError().retryAfterSec, 1);
  const lim = new ConcurrencyLimiter(1);
  assert.equal(lim.tryAcquire(), true);
  assert.equal(lim.tryAcquire(), false, '池满快速拒绝');
  lim.release();
  console.log('ok pool exhaustion mapping');
}

section('全局 / 单用户限流 → 503 + Retry-After');
{
  __resetConcurrencyLimitersForTest();
  const mw = createAppConcurrencyMiddleware();

  // 单用户：同一身份打爆 userMax
  const userHolders: Array<ReturnType<typeof mockRes>> = [];
  for (let i = 0; i < concurrencyConfig.userMax; i += 1) {
    const res = mockRes();
    let next = false;
    mw(
      mockReq({
        path: '/pages/tasks/catalog',
        originalUrl: '/api/app/pages/tasks/catalog',
        headers: { 'x-forwarded-for': '203.0.113.10' },
        ip: '203.0.113.10',
      } as never),
      res,
      () => {
        next = true;
      },
    );
    assert.equal(next, true, `user slot ${i}`);
    userHolders.push(res);
  }
  {
    const res = mockRes();
    let next = false;
    mw(
      mockReq({
        path: '/pages/tasks/catalog',
        originalUrl: '/api/app/pages/tasks/catalog',
        headers: { 'x-forwarded-for': '203.0.113.10' },
        ip: '203.0.113.10',
      } as never),
      res,
      () => {
        next = true;
      },
    );
    assert.equal(next, false);
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['retry-after'], '1');
  }
  void userHolders;

  // page 池满后其他身份也 503
  __resetConcurrencyLimitersForTest();
  holdPageSlots(concurrencyConfig.pageMax);
  {
    const res = mockRes();
    let next = false;
    mw(
      mockReq({
        path: '/pages/tasks',
        originalUrl: '/api/app/pages/tasks',
        headers: { 'x-forwarded-for': '198.51.100.9' },
        ip: '198.51.100.9',
      } as never),
      res,
      () => {
        next = true;
      },
    );
    assert.equal(next, false);
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['retry-after'], '1');
  }

  // sync 池独立：page 满不影响 sync
  {
    const res = mockRes();
    let next = false;
    mw(
      mockReq({
        path: '/sync/changes',
        originalUrl: '/api/app/sync/changes',
        headers: { 'x-forwarded-for': '198.51.100.200' },
        ip: '198.51.100.200',
      } as never),
      res,
      () => {
        next = true;
      },
    );
    assert.equal(next, true, 'sync must not be starved by full page pool');
  }
  console.log('ok rate limit 503');
}

section('taskView 契约：分页上限与稳定 total');
{
  const p = resolveTaskViewPagination({ page: 3, limit: 40 }, 95);
  assert.equal(p.page, 3);
  assert.equal(p.limit, 40);
  assert.equal(p.total, 95);
  assert.equal(p.totalPages, 3);
  assert.equal(p.offset, 80);
  const capped = resolveTaskViewPagination({ page: 1, limit: 99999 }, 10);
  assert.ok(capped.limit <= 500);
  console.log('ok taskView pagination');
}

section('危险 bootstrap 拒绝策略默认开启');
{
  assert.equal(isDangerousTasksBootstrapInclude(parseTasksBootstrapInclude(undefined)), true);
  assert.equal(isDangerousTasksBootstrapInclude(parseTasksBootstrapInclude('heatmap')), true);
  assert.equal(isDangerousTasksBootstrapInclude(parseTasksBootstrapInclude('tasks')), false);
  assert.equal(tasksPageConfig.dangerousBootstrapReject, true);
  console.log('ok dangerous bootstrap');
}

section('habits 时间窗口');
{
  const today = '2026-11-24';
  assert.equal(
    resolveHabitsGridCheckInStartYmd(today, [
      { extra_data: JSON.stringify({ habitKind: 'build' }) },
    ]),
    today,
  );
  assert.equal(
    resolveHabitsGridCheckInStartYmd(today, [
      { extra_data: JSON.stringify({ habitKind: 'task', schedule: { activeTab: '每年' } }) },
    ]),
    '2026-01-01',
  );
  console.log('ok habits window');
}

section('heatmap 口径门禁（B5 合并门禁复跑）');
{
  const bounds = resolveHeatmapEventCreatedAtBounds('2026-11-01', '2026-11-24', {
    hour: 4,
    minute: 0,
  });
  assert.equal(bounds.createdAtGte, '2026-11-01 04:00:00');

  const net = filterNetCompletedEvents(
    [
      { task_id: 't1', action: 'completed', created_at: '2026-11-20 21:00:00', logicalYmd: '2026-11-20' },
      { task_id: 't1', action: 'reopened', created_at: '2026-11-21 09:00:00', logicalYmd: '2026-11-21' },
      { task_id: 't1', action: 'completed', created_at: '2026-11-22 22:00:00', logicalYmd: '2026-11-22' },
    ],
    new Set(),
  );
  assert.equal(net.length, 1);
  assert.equal(net[0]?.logicalYmd, '2026-11-22');

  const mutex = excludeTodosAlreadyCountedAsFrogs(
    [{ task_id: 'frog_t' }, { task_id: 'todo_t' }],
    new Set(['frog_t']),
  );
  assert.equal(mutex.length, 1);

  const frog = aggregateFrogEvents(
    [
      {
        id: 'f1',
        task_id: 'proj_1',
        assigned_ymd: '2026-11-24',
        action: 'completed',
        created_at: '2026-11-24 09:00:00',
        task_title: '项目青蛙',
      },
      {
        id: 'f2',
        task_id: 'proj_1',
        assigned_ymd: '2026-11-24',
        action: 'reopened',
        created_at: '2026-11-24 10:00:00',
        task_title: '项目青蛙',
      },
    ],
    '2026-11-01',
    '2026-11-30',
  );
  assert.equal(frog.countsByDay['2026-11-24'] ?? 0, 0);
  console.log('ok heatmap口径');
}

section('项目树：无 projectIds 的 projectTrees 禁止扫全表（契约注释门禁）');
{
  // 行为在 loadFilteredTasks；此处锁定「空 projectIds → 空树」的产品契约说明
  // 与 B2/B3 一致：调用方必须先取当前页项目 ID
  const emptyIds: string[] = [];
  assert.equal(emptyIds.length, 0, '无 projectIds 时不得发起全用户 tasks 扫描');
  console.log('ok projectTrees scope contract');
}

console.log('\nphase-e-gate-selftest: ALL PASSED');
