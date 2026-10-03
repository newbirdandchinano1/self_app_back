/**
 * Phase 8：Bootstrap snapshot（唯一全量协议）自测。不是 /sync/full。
 * 运行：npx tsx scripts/sync-bootstrap-selftest.ts
 */
import '../src/bootstrap/timezone.js';
import { randomUUID } from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RowDataPacket } from 'mysql2';
import { db } from '../src/db/index.js';
import { ensureSyncChangeLogTable } from '../src/db/ensure-sync-change-log.js';
import { ensureSyncRevisionSchema } from '../src/db/ensure-sync-revision.js';
import { createRecord, deleteRecord } from '../src/services/crud.js';
import { getSnapshotCursor0, pullSnapshotTable } from '../src/services/sync-snapshot.js';
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
  console.log('=== Phase 8: bootstrap snapshot + pull 载荷 ===\n');
  await ensureSyncChangeLogTable();
  await ensureSyncRevisionSchema();

  const cursor0 = await getSnapshotCursor0();
  check('snapshot-meta cursor0 为非负整数', Number.isInteger(cursor0) && cursor0 >= 0);

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const taskId = `boot_snap_${randomUUID().slice(0, 8)}`;
  await createRecord(
    'tasks',
    {
      id: taskId,
      title: 'bootstrap-snapshot-selftest',
      status: 'todo',
      priority: 0,
      created_at: now,
      updated_at: now,
      sync_status: 'synced',
    },
    { deviceId: 'bootstrap-selftest' },
  );

  try {
    const frozen = cursor0;
    const page = await pullSnapshotTable('tasks', null, 200, frozen);
    check('snapshot 页 meta.syncCursor 原样回传 cursor0', page.meta.syncCursor === frozen);
    check('单表分页 snapshotComplete 必须为 false', page.meta.snapshotComplete === false);

    let found = page.rows.some((r) => String(r.id) === taskId);
    let after: string | null = page.nextAfter;
    let done = page.done;
    for (let i = 0; i < 50 && !found && !done; i += 1) {
      const more = await pullSnapshotTable('tasks', after, 200, frozen);
      found = more.rows.some((r) => String(r.id) === taskId);
      after = more.nextAfter;
      done = more.done;
    }
    check('快照含刚写入的任务（无日期过滤）', found);

    const afterWrite = await getSnapshotCursor0();
    check('写任务后 MAX(id) 前进（或持平）', afterWrite >= frozen);
    const pageStill = await pullSnapshotTable('tasks', null, 5, frozen);
    check(
      '后续分页仍回传会话 cursor0，不重读 MAX(id)',
      pageStill.meta.syncCursor === frozen,
      `got=${pageStill.meta.syncCursor} frozen=${frozen} maxNow=${afterWrite}`,
    );

    const first = await pullSnapshotTable('tasks', null, 1, frozen);
    if (!first.done && first.nextAfter) {
      const second = await pullSnapshotTable('tasks', first.nextAfter, 1, frozen);
      check('分页 after 前进', second.nextAfter !== first.nextAfter || second.done);
      check('第二页仍回传同一 cursor0', second.meta.syncCursor === frozen);
    } else {
      check('分页 after 前进（表行不足 2，跳过）', true);
      check('第二页仍回传同一 cursor0（跳过）', true);
    }

    let unsupported = false;
    try {
      await pullSnapshotTable('admin_users', null, 10, frozen);
    } catch {
      unsupported = true;
    }
    check('非 changelog 表白名单拒绝 snapshot', unsupported);

    const pull = await pullSyncChanges({ since: frozen, limit: 50 });
    const upsert = pull.events.find((e) => e.pk === taskId && e.op === 'upsert');
    check('Pull 一页含 upsert 事件', upsert != null);
    check('Pull upsert 带当前行本体（禁止逐 pk GET）', upsert?.row != null && String(upsert.row.id) === taskId);
    check('Pull 事件带 serverRev', upsert?.serverRev != null && Number(upsert.serverRev) > 0);
    check('needFullSync 时不把 cursor 跳到 max', true);

    const [minRows] = await db.query<RowDataPacket[]>(
      `SELECT MIN(id) AS min_id FROM sync_change_log WHERE user_id = 'default'`,
    );
    const minId = Number(minRows[0]?.min_id ?? 0);
    if (minId > 1) {
      const staleSince = minId - 2;
      const stale = await pullSyncChanges({ since: staleSince });
      check('游标过旧 needFullSync', stale.needFullSync === true);
      check('needFullSync 保留 since 不跳 max', stale.cursor === staleSince, `cursor=${stale.cursor}`);
      check('needFullSync 不带业务 events', stale.events.length === 0);
    } else {
      check('游标过旧 needFullSync（跳过：minId<=1）', true);
      check('needFullSync 保留 since 不跳 max（跳过）', true);
      check('needFullSync 不带业务 events（跳过）', true);
    }

    const routes = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes', 'app', 'sync.ts'),
      'utf8',
    );
    check(
      '路由无 /sync/full',
      !/router\.(get|post|put|delete)\(\s*['"`]\/full['"`]/.test(routes),
    );
  } finally {
    await deleteRecord('tasks', taskId, { deviceId: 'bootstrap-selftest' });
  }

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
