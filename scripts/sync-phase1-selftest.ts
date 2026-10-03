/**
 * Phase 1：server_rev 单调 + tombstone + mutation_id + Push OCC
 * 运行：npx tsx scripts/sync-phase1-selftest.ts
 */
import '../src/bootstrap/timezone.js';
import { randomUUID } from 'crypto';
import type { RowDataPacket } from 'mysql2';
import { db } from '../src/db/index.js';
import { ensureSyncChangeLogTable } from '../src/db/ensure-sync-change-log.js';
import { ensureSyncRevisionSchema } from '../src/db/ensure-sync-revision.js';
import { createRecord, deleteRecord, updateRecord } from '../src/services/crud.js';
import { nextServerRev, SyncOccConflictError } from '../src/services/sync-revision.js';

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

async function liveRev(pk: string): Promise<number | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT server_rev AS serverRev FROM tasks WHERE id = ? LIMIT 1`,
    [pk],
  );
  if (!rows[0]) return null;
  const n = Number(rows[0].serverRev);
  return Number.isFinite(n) ? n : 0;
}

async function tombRev(pk: string): Promise<{ serverRev: number; mutationId: string | null } | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT server_rev AS serverRev, mutation_id AS mutationId
     FROM sync_tombstones
     WHERE user_id = 'default' AND table_name = 'tasks' AND record_pk = ?
     LIMIT 1`,
    [pk],
  );
  if (!rows[0]) return null;
  const n = Number(rows[0].serverRev);
  return {
    serverRev: Number.isFinite(n) ? n : 0,
    mutationId: rows[0].mutationId == null ? null : String(rows[0].mutationId),
  };
}

async function latestLog(pk: string): Promise<RowDataPacket | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT op, server_rev, mutation_id FROM sync_change_log
     WHERE table_name = 'tasks' AND record_pk = ?
     ORDER BY id DESC LIMIT 1`,
    [pk],
  );
  return rows[0] ?? null;
}

async function cleanup(pk: string): Promise<void> {
  await db.query(`DELETE FROM tasks WHERE id = ?`, [pk]);
  await db.query(
    `DELETE FROM sync_tombstones WHERE user_id = 'default' AND table_name = 'tasks' AND record_pk = ?`,
    [pk],
  );
}

async function main() {
  console.log('=== Phase 1: server_rev / tombstone / mutation_id / OCC ===\n');

  check('nextServerRev(null,null)=1', nextServerRev(null, null) === 1);
  check('nextServerRev(1,null)=2', nextServerRev(1, null) === 2);
  check('nextServerRev(null,5)=6', nextServerRev(null, 5) === 6);
  check('nextServerRev(3,5)=6', nextServerRev(3, 5) === 6);
  check('nextServerRev(5,5)=6', nextServerRev(5, 5) === 6);

  await ensureSyncChangeLogTable();
  await ensureSyncRevisionSchema();

  const pk = `sync_p1_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const revs: number[] = [];
  const mCreate = randomUUID().slice(0, 36);
  const mUpdate = randomUUID().slice(0, 36);
  const mDelete = randomUUID().slice(0, 36);
  const mRecreate = randomUUID().slice(0, 36);
  const mReupdate = randomUUID().slice(0, 36);
  const mRedelete = randomUUID().slice(0, 36);

  try {
    console.log('\n--- 建 → 改 → 删 → 再建 → 再改 → 再删 ---\n');
    await createRecord(
      'tasks',
      {
        id: pk,
        title: 'p1-create',
        status: 'todo',
        priority: 0,
        created_at: now,
        updated_at: now,
        sync_status: 'synced',
        mutation_id: mCreate,
      },
    );
    const r1 = await liveRev(pk);
    revs.push(r1 ?? -1);
    const log1 = await latestLog(pk);
    check('INSERT 活行 rev=1', r1 === 1, `rev=${r1}`);
    check('INSERT log 带 mutation_id', log1?.mutation_id === mCreate);
    check('INSERT log server_rev=1', Number(log1?.server_rev) === 1);

    await updateRecord(
      'tasks',
      pk,
      { title: 'p1-update', updated_at: now, expected_rev: 1, mutation_id: mUpdate },
    );
    const r2 = await liveRev(pk);
    revs.push(r2 ?? -1);
    const log2 = await latestLog(pk);
    check('UPDATE rev=2', r2 === 2, `rev=${r2}`);
    check('UPDATE log mutation_id', log2?.mutation_id === mUpdate);

    console.log('\n--- 过期 expected_rev → 409 当前行 ---\n');
    let stale: unknown = null;
    try {
      await updateRecord('tasks', pk, {
        title: 'stale',
        expected_rev: 1,
        mutation_id: randomUUID().slice(0, 36),
      });
    } catch (err) {
      stale = err;
    }
    check('过期 PATCH 抛 SyncOccConflictError', stale instanceof SyncOccConflictError);
    if (stale instanceof SyncOccConflictError) {
      check('409 kind=row', stale.payload.kind === 'row');
      check('409 serverRev=2', stale.payload.serverRev === 2);
      check('409 含当前行', stale.payload.row != null && String(stale.payload.row.id) === pk);
    }
    check('冲突后活行 rev 仍为 2', (await liveRev(pk)) === 2);

    await deleteRecord('tasks', pk, { expectedRev: 2, mutationId: mDelete });
    check('DELETE 后无活行', (await liveRev(pk)) == null);
    const t1 = await tombRev(pk);
    revs.push(t1?.serverRev ?? -1);
    const log3 = await latestLog(pk);
    check('tombstone rev=3', t1?.serverRev === 3, `tomb=${t1?.serverRev}`);
    check('tombstone mutation_id', t1?.mutationId === mDelete);
    check('DELETE log mutation_id', log3?.op === 'delete' && log3?.mutation_id === mDelete);

    console.log('\n--- PATCH 已删行 → 409 tombstone ---\n');
    let gone: unknown = null;
    try {
      await updateRecord('tasks', pk, {
        title: 'ghost',
        expected_rev: 3,
        mutation_id: randomUUID().slice(0, 36),
      });
    } catch (err) {
      gone = err;
    }
    check('已删 PATCH 抛 OCC', gone instanceof SyncOccConflictError);
    if (gone instanceof SyncOccConflictError) {
      check('409 kind=tombstone', gone.payload.kind === 'tombstone');
      check('409 tombstone serverRev=3', gone.payload.serverRev === 3);
      check('409 row 为空', gone.payload.row == null);
    }

    await createRecord(
      'tasks',
      {
        id: pk,
        title: 'p1-recreate',
        status: 'todo',
        priority: 0,
        created_at: now,
        updated_at: now,
        sync_status: 'synced',
        mutation_id: mRecreate,
      },
    );
    const r4 = await liveRev(pk);
    revs.push(r4 ?? -1);
    check('再建 rev=4（> tombstone 3）', r4 === 4, `rev=${r4}`);
    check('再建后 tombstone 已清', (await tombRev(pk)) == null);

    await updateRecord('tasks', pk, {
      title: 'p1-reupdate',
      expected_rev: 4,
      mutation_id: mReupdate,
    });
    const r5 = await liveRev(pk);
    revs.push(r5 ?? -1);
    check('再改 rev=5', r5 === 5, `rev=${r5}`);

    await deleteRecord('tasks', pk, { expectedRev: 5, mutationId: mRedelete });
    const t2 = await tombRev(pk);
    revs.push(t2?.serverRev ?? -1);
    check('再删 tombstone rev=6', t2?.serverRev === 6, `tomb=${t2?.serverRev}`);

    const strictlyInc = revs.every((v, i) => i === 0 || v > revs[i - 1]);
    check(
      '建改删再建再改再删 rev 严格递增',
      strictlyInc && revs.join(',') === '1,2,3,4,5,6',
      `seq=${revs.join(',')}`,
    );

    const goneAgain = await deleteRecord('tasks', pk, { expectedRev: 6, mutationId: randomUUID() });
    check('DELETE 已无活行幂等成功', goneAgain === true);
    check('幂等删除不抬升 tombstone rev', (await tombRev(pk))?.serverRev === 6);
  } finally {
    await cleanup(pk);
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
