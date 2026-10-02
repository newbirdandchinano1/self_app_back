/**
 * Phase 1 Change Log 自测（连库）
 * 运行：npx tsx scripts/sync-change-log-selftest.ts
 *
 * 验收：写一条任务 → sync_change_log 多一条；事务回滚时无脏 log。
 */
import '../src/bootstrap/timezone.js';
import { randomUUID } from 'crypto';
import type { RowDataPacket } from 'mysql2';
import { db } from '../src/db/index.js';
import { ensureSyncChangeLogTable } from '../src/db/ensure-sync-change-log.js';
import { createRecord, deleteRecord, updateRecord } from '../src/services/crud.js';
import {
  appendChangeLog,
  withSyncTransaction,
} from '../src/services/sync-change-log.js';

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

async function countLogs(sinceId: number): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM sync_change_log WHERE id > ?`,
    [sinceId],
  );
  return Number(rows[0]?.cnt ?? 0);
}

async function maxLogId(): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COALESCE(MAX(id), 0) AS mid FROM sync_change_log`,
  );
  return Number(rows[0]?.mid ?? 0);
}

async function latestLogFor(table: string, pk: string): Promise<RowDataPacket | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, user_id, device_id, table_name, record_pk, op, created_at
     FROM sync_change_log
     WHERE table_name = ? AND record_pk = ?
     ORDER BY id DESC LIMIT 1`,
    [table, pk],
  );
  return rows[0] ?? null;
}

async function main() {
  console.log('=== Phase 1: sync_change_log ===\n');

  await ensureSyncChangeLogTable();
  check('表 sync_change_log 可用', true);

  const beforeMax = await maxLogId();
  const taskId = `sync_selftest_${randomUUID().slice(0, 8)}`;
  const deviceId = `dev_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  console.log('\n--- 写任务 → log ---\n');
  const created = await createRecord(
    'tasks',
    {
      id: taskId,
      title: 'Change Log 自测任务',
      status: 'todo',
      priority: 0,
      created_at: now,
      updated_at: now,
      sync_status: 'synced',
    },
    { deviceId },
  );
  check('创建任务成功', created != null && String(created.id) === taskId);

  const createLog = await latestLogFor('tasks', taskId);
  check('创建后有 upsert log', createLog != null && createLog.op === 'upsert');
  check('log.device_id 正确', createLog?.device_id === deviceId);
  check('log.user_id 为 default', createLog?.user_id === 'default');
  check(
    '游标单调递增',
    createLog != null && Number(createLog.id) > beforeMax,
    `before=${beforeMax} after=${createLog?.id}`,
  );

  console.log('\n--- 更新任务 → log ---\n');
  const afterCreateMax = await maxLogId();
  await updateRecord(
    'tasks',
    taskId,
    { title: 'Change Log 自测任务（已改）', updated_at: now },
    { deviceId },
  );
  const updateLog = await latestLogFor('tasks', taskId);
  check(
    '更新后有新 upsert log',
    updateLog != null && Number(updateLog.id) > afterCreateMax && updateLog.op === 'upsert',
  );

  console.log('\n--- 回滚无脏 log ---\n');
  const beforeRollback = await maxLogId();
  let rolledBack = false;
  try {
    await withSyncTransaction(async (conn) => {
      await appendChangeLog(conn, [
        {
          tableName: 'tasks',
          recordPk: `rollback_${taskId}`,
          op: 'upsert',
          deviceId: 'rollback-test',
        },
      ]);
      throw new Error('force_rollback_for_selftest');
    });
  } catch (err) {
    rolledBack = (err as Error).message === 'force_rollback_for_selftest';
  }
  check('事务抛错已捕获', rolledBack);
  const afterRollback = await maxLogId();
  check(
    '回滚后无脏 log',
    afterRollback === beforeRollback,
    `before=${beforeRollback} after=${afterRollback}`,
  );
  const dirty = await latestLogFor('tasks', `rollback_${taskId}`);
  check('回滚假 pk 不存在于 log', dirty == null);

  console.log('\n--- 删除任务 → log ---\n');
  const beforeDelete = await maxLogId();
  const deleted = await deleteRecord('tasks', taskId, { deviceId });
  check('删除任务成功', deleted === true);
  const deleteLog = await latestLogFor('tasks', taskId);
  check(
    '删除后有 delete log',
    deleteLog != null && deleteLog.op === 'delete' && Number(deleteLog.id) > beforeDelete,
  );

  const delta = await countLogs(beforeMax);
  check('本次至少产生 3 条有序事件（create/update/delete）', delta >= 3, `delta=${delta}`);

  console.log(`\n=== 结果：${passed} passed, ${failed} failed ===`);
  await db.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await db.end();
  } catch {
    // ignore
  }
  process.exit(1);
});
