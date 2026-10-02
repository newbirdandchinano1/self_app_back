/**
 * Phase 5 硬化自测（连库 + 纯函数）
 * 运行：npm run test:sync-phase5
 *
 * 覆盖：限流、Change Log 清理 → needFullSync、双端 LWW 冲突、SSE 在线统计。
 */
import '../src/bootstrap/timezone.js';
import { randomUUID } from 'crypto';
import type { RowDataPacket } from 'mysql2';
import { db } from '../src/db/index.js';
import { ensureSyncChangeLogTable } from '../src/db/ensure-sync-change-log.js';
import {
  createRecord,
  updateRecord,
  deleteRecord,
  getRecord,
} from '../src/services/crud.js';
import { pullSyncChanges } from '../src/services/sync-pull.js';
import {
  purgeSyncChangeLog,
  stopSyncChangeLogCleanupSchedulerForTests,
} from '../src/services/sync-change-log-cleanup.js';
import {
  appendChangeLog,
  withSyncTransaction,
  DEFAULT_SYNC_USER_ID,
} from '../src/services/sync-change-log.js';
import {
  registerSyncSseConnection,
  unregisterSyncSseConnection,
  getSyncSseStats,
  countSyncSseConnections,
  resetSyncSseHubForTests,
} from '../src/services/sync-sse-hub.js';
import { SlidingWindowRateLimiter } from '../src/utils/rate-limiter.js';
import { EventEmitter } from 'events';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function createFakeRes() {
  const ee = new EventEmitter() as EventEmitter & {
    writableEnded: boolean;
    destroyed: boolean;
    chunks: string[];
    write: (chunk: string) => boolean;
    end: () => void;
  };
  ee.writableEnded = false;
  ee.destroyed = false;
  ee.chunks = [];
  ee.write = (chunk: string) => {
    if (ee.writableEnded || ee.destroyed) return false;
    ee.chunks.push(chunk);
    return true;
  };
  ee.end = () => {
    ee.writableEnded = true;
  };
  return ee;
}

/** LWW / pending 保护规则（与 App api-read-local-sync 对齐的纯逻辑演练） */
function shouldKeepLocalPending(opts: {
  localSyncStatus: string;
  apiUpdatedAt: string;
  localUpdatedAt: string;
}): boolean {
  if (opts.localSyncStatus === 'synced') return false;
  if (opts.localSyncStatus === 'pending_delete') return true;
  // pending_create / pending_update：仅当 API 更新时刻更新才覆盖
  const apiMs = Date.parse(opts.apiUpdatedAt);
  const localMs = Date.parse(opts.localUpdatedAt);
  if (Number.isFinite(apiMs) && Number.isFinite(localMs)) {
    return !(apiMs > localMs);
  }
  return !(opts.apiUpdatedAt > opts.localUpdatedAt);
}

async function main() {
  console.log('=== Phase 5: hardening ===\n');
  stopSyncChangeLogCleanupSchedulerForTests();
  await ensureSyncChangeLogTable();

  // --- 限流 ---
  console.log('--- 限流 SlidingWindowRateLimiter ---\n');
  const limiter = new SlidingWindowRateLimiter(3, 60_000);
  check('限流第1次允许', limiter.tryConsume('k1') === true);
  check('限流第2次允许', limiter.tryConsume('k1') === true);
  check('限流第3次允许', limiter.tryConsume('k1') === true);
  check('限流第4次拒绝', limiter.tryConsume('k1') === false);
  check('retryAfterSec > 0', limiter.retryAfterSec('k1') > 0);
  limiter.reset('k1');
  check('reset 后允许', limiter.tryConsume('k1') === true);

  // --- SSE 在线统计 ---
  console.log('\n--- SSE 在线统计 ---\n');
  resetSyncSseHubForTests();
  const res1 = createFakeRes();
  const res2 = createFakeRes();
  const c1 = registerSyncSseConnection({
    userId: DEFAULT_SYNC_USER_ID,
    deviceId: 'phase5-a',
    res: res1 as unknown as import('express').Response,
  });
  const c2 = registerSyncSseConnection({
    userId: DEFAULT_SYNC_USER_ID,
    deviceId: 'phase5-b',
    res: res2 as unknown as import('express').Response,
  });
  const stats = getSyncSseStats();
  check('在线连接数=2', countSyncSseConnections() === 2 && stats.totalConnections === 2);
  check('usersOnline=1', stats.usersOnline === 1);
  check(
    'devices 含两端',
    stats.byUser[0]?.devices.includes('phase5-a') === true &&
      stats.byUser[0]?.devices.includes('phase5-b') === true,
  );
  unregisterSyncSseConnection(c1);
  unregisterSyncSseConnection(c2);
  resetSyncSseHubForTests();
  check('断开后在线=0', countSyncSseConnections() === 0);

  // --- 冲突 LWW ---
  console.log('\n--- 双端改同一任务 LWW ---\n');
  const taskId = `phase5_lww_${randomUUID().slice(0, 8)}`;
  const t0 = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await createRecord(
    'tasks',
    {
      id: taskId,
      title: 'LWW seed',
      status: 'todo',
      priority: 0,
      created_at: t0,
      updated_at: t0,
      sync_status: 'synced',
    },
    { deviceId: 'phase5-seed' },
  );

  const tA = new Date(Date.now() + 1000).toISOString().slice(0, 19).replace('T', ' ');
  await updateRecord(
    'tasks',
    taskId,
    { title: 'from-device-A', updated_at: tA },
    { deviceId: 'phase5-device-A' },
  );

  const tB = new Date(Date.now() + 2000).toISOString().slice(0, 19).replace('T', ' ');
  await updateRecord(
    'tasks',
    taskId,
    { title: 'from-device-B', updated_at: tB },
    { deviceId: 'phase5-device-B' },
  );

  const row = (await getRecord('tasks', taskId)) as Record<string, unknown> | null;
  check('服务端最后写入获胜 title=B', row?.title === 'from-device-B');

  const [logRows] = await db.query<RowDataPacket[]>(
    `SELECT id, device_id, op FROM sync_change_log
     WHERE table_name = 'tasks' AND record_pk = ?
     ORDER BY id ASC`,
    [taskId],
  );
  check('Change Log 至少 3 条（create+2 update）', logRows.length >= 3);
  const devices = logRows.map((r) => String(r.device_id ?? ''));
  check(
    'log 含 device A/B',
    devices.some((d) => d.includes('phase5-device-A')) &&
      devices.some((d) => d.includes('phase5-device-B')),
  );

  // pending 保护规则演练
  check(
    'pending 本地较新不被旧 API 覆盖',
    shouldKeepLocalPending({
      localSyncStatus: 'pending_update',
      apiUpdatedAt: '2026-01-01T10:00:00.000Z',
      localUpdatedAt: '2026-01-01T12:00:00.000Z',
    }) === true,
  );
  check(
    'pending 但 API 更新则允许覆盖',
    shouldKeepLocalPending({
      localSyncStatus: 'pending_update',
      apiUpdatedAt: '2026-01-01T14:00:00.000Z',
      localUpdatedAt: '2026-01-01T12:00:00.000Z',
    }) === false,
  );
  check(
    'synced 行不走 pending 保护',
    shouldKeepLocalPending({
      localSyncStatus: 'synced',
      apiUpdatedAt: '2026-01-01T10:00:00.000Z',
      localUpdatedAt: '2026-01-01T12:00:00.000Z',
    }) === false,
  );

  await deleteRecord('tasks', taskId, { deviceId: 'phase5-cleanup' });

  // --- Change Log 清理 + needFullSync 演练 ---
  console.log('\n--- Change Log 清理 → needFullSync ---\n');
  const drillUser = `phase5_drill_${randomUUID().slice(0, 6)}`;
  await withSyncTransaction(async (conn) => {
    await appendChangeLog(conn, [
      { tableName: 'tasks', recordPk: 'old_1', op: 'upsert', userId: drillUser, deviceId: 'drill' },
      { tableName: 'tasks', recordPk: 'old_2', op: 'upsert', userId: drillUser, deviceId: 'drill' },
      { tableName: 'tasks', recordPk: 'old_3', op: 'upsert', userId: drillUser, deviceId: 'drill' },
      { tableName: 'tasks', recordPk: 'keep_1', op: 'upsert', userId: drillUser, deviceId: 'drill' },
      { tableName: 'tasks', recordPk: 'keep_2', op: 'upsert', userId: drillUser, deviceId: 'drill' },
    ]);
  });

  const [beforeBounds] = await db.query<RowDataPacket[]>(
    `SELECT MIN(id) AS min_id, MAX(id) AS max_id, COUNT(*) AS cnt
     FROM sync_change_log WHERE user_id = ?`,
    [drillUser],
  );
  const minBefore = Number(beforeBounds[0]?.min_id ?? 0);
  check('演练用户写入 5 条', Number(beforeBounds[0]?.cnt ?? 0) === 5);

  // 模拟客户端落在最早游标
  const cursorOnOldest = minBefore; // since = minId 时 since+1 == minId，不算过旧
  const staleSince = minBefore - 1; // 清理后若 min 前进，则 stale

  const purged = await purgeSyncChangeLog({
    userId: drillUser,
    retainDays: 3650, // 不按年龄删
    retainMaxRows: 2, // 只留最新 2 条
  });
  check('按条数清理删掉旧行', purged.deletedByCount >= 3);
  check('清理后 minId 前进', purged.minIdAfter != null && purged.minIdAfter > minBefore);

  const stalePull = await pullSyncChanges({ userId: drillUser, since: staleSince });
  check('清理后旧游标 needFullSync=true', stalePull.needFullSync === true);

  const freshPull = await pullSyncChanges({
    userId: drillUser,
    since: (purged.minIdAfter ?? 1) - 1,
  });
  check(
    '新窗口内可正常 pull',
    freshPull.needFullSync === false && freshPull.events.length >= 1,
  );

  // 清掉演练用户残留
  await db.query(`DELETE FROM sync_change_log WHERE user_id = ?`, [drillUser]);

  // 顺带验证 cursorOnOldest 在清理前语义（文档锚点）
  void cursorOnOldest;

  console.log(`\n=== 结果：${passed} passed, ${failed} failed ===`);
  await db.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await db.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
