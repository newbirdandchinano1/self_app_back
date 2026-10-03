/**
 * Phase 2 Change Log Pull 自测（连库）
 * 运行：npx tsx scripts/sync-pull-selftest.ts
 */
import '../src/bootstrap/timezone.js';
import { randomUUID } from 'crypto';
import type { RowDataPacket } from 'mysql2';
import { db } from '../src/db/index.js';
import { ensureSyncChangeLogTable } from '../src/db/ensure-sync-change-log.js';
import { createRecord, deleteRecord } from '../src/services/crud.js';
import { pullSyncChanges } from '../src/services/sync-pull.js';

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

async function main() {
  console.log('=== Phase 2: GET sync/changes (pullSyncChanges) ===\n');
  await ensureSyncChangeLogTable();

  const empty = await pullSyncChanges({ since: Number.MAX_SAFE_INTEGER });
  check('超前游标 hasMore=false', empty.hasMore === false && empty.events.length === 0);
  check('超前游标 needFullSync=false', empty.needFullSync === false);

  const [maxRows] = await db.query<RowDataPacket[]>(
    `SELECT MAX(id) AS max_id FROM sync_change_log WHERE user_id = 'default'`,
  );
  const cursorBefore = Number(maxRows[0]?.max_id ?? 0) || 0;

  const taskId = `sync_pull_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await createRecord(
    'tasks',
    {
      id: taskId,
      title: 'Pull 自测',
      status: 'todo',
      priority: 0,
      created_at: now,
      updated_at: now,
      sync_status: 'synced',
    },
    { deviceId: 'pull-selftest' },
  );

  const page = await pullSyncChanges({ since: cursorBefore, limit: 50 });
  check('写后能拉到事件', page.events.some((e) => e.pk === taskId && e.table === 'tasks'));
  check('dirtyTables 含 tasks', page.dirtyTables.includes('tasks'));
  check('cursor 前进', page.cursor > cursorBefore);
  check('needFullSync=false', page.needFullSync === false);

  let drainCursor = page.cursor;
  for (let i = 0; i < 5; i++) {
    const p = await pullSyncChanges({ since: drainCursor });
    if (p.events.length === 0) { drainCursor = p.cursor; break; }
    drainCursor = p.cursor;
    if (!p.hasMore) break;
  }
  const caughtUp = await pullSyncChanges({ since: drainCursor });
  check('追上后无事件', caughtUp.events.length === 0 && caughtUp.hasMore === false);

  // 模拟游标过旧：since 小于当前 min(id)
  const [minRows] = await db.query<RowDataPacket[]>(
    `SELECT MIN(id) AS min_id FROM sync_change_log WHERE user_id = 'default'`,
  );
  const minId = Number(minRows[0]?.min_id ?? 0);
  if (minId > 1) {
    const stale = await pullSyncChanges({ since: minId - 2 });
    check('游标过旧 needFullSync', stale.needFullSync === true);
  } else {
    check('游标过旧 needFullSync（跳过：minId<=1）', true);
  }

  await deleteRecord('tasks', taskId, { deviceId: 'pull-selftest' });
  const afterDel = await pullSyncChanges({ since: page.cursor });
  check(
    '删除事件可拉取',
    afterDel.events.some((e) => e.pk === taskId && e.op === 'delete'),
  );

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
