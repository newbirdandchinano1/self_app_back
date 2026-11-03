/**
 * 道路表 CRUD + 年季月节点槽位唯一自测（连库）
 * 运行：npx tsx scripts/life-road-selftest.ts
 */
import '../src/bootstrap/timezone.js';
import { randomUUID } from 'crypto';
import { db } from '../src/db/index.js';
import { runPendingMigrations } from '../src/db/migrations/index.js';
import { isAllowedTable } from '../src/config/tables.js';
import {
  createRecord,
  CrudError,
  deleteRecord,
  getRecord,
  listRecords,
  updateRecord,
} from '../src/services/crud.js';
import { isChangeLogTable } from '../src/services/sync-change-log.js';
import { pullSnapshotTable, getSnapshotCursor0 } from '../src/services/sync-snapshot.js';

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

function makeId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

async function cleanupIds(table: string, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await deleteRecord(table, id);
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  console.log('=== 迁移 + 白名单 ===\n');
  await runPendingMigrations();
  check('life_directions 在白名单', isAllowedTable('life_directions'));
  check('life_bets 在白名单', isAllowedTable('life_bets'));
  check('life_road_nodes 在白名单', isAllowedTable('life_road_nodes'));
  check('life_directions 进 change log', isChangeLogTable('life_directions'));
  check('life_bets 进 change log', isChangeLogTable('life_bets'));
  check('life_road_nodes 进 change log', isChangeLogTable('life_road_nodes'));

  const year = new Date().getFullYear();
  const dirId = makeId('ld_st_');
  const betIds: string[] = [];
  const nodeIds: string[] = [];

  console.log('\n=== life_directions CRUD ===\n');
  try {
    const created = await createRecord('life_directions', {
      id: dirId,
      body: '自测总方向：把底座搭稳',
      year_theme: `${year}：底座年`,
    });
    check('创建方向', created?.id === dirId && String(created.body).includes('底座'));

    const patched = await updateRecord('life_directions', dirId, {
      body: '自测总方向：已改写',
      year_theme: null,
    });
    check('更新方向', patched?.body === '自测总方向：已改写' && patched?.year_theme == null);

    const got = await getRecord('life_directions', dirId);
    check('读取方向', got?.id === dirId);

    const listed = await listRecords('life_directions', { limit: 50 });
    check(
      '列表含方向',
      listed.list.some((r) => String((r as { id?: string }).id) === dirId),
    );
  } catch (err) {
    check('方向 CRUD', false, err instanceof Error ? err.message : String(err));
  }

  console.log('\n=== life_bets CRUD ===\n');
  const betId = makeId('lb_st_');
  betIds.push(betId);
  try {
    const created = await createRecord('life_bets', {
      id: betId,
      title: '自测赌注A',
      horizon: 'year',
      year,
      status: 'on_track',
      note: '做成了能每天打开道路页',
    });
    check('创建赌注', created?.id === betId && created?.title === '自测赌注A');

    const patched = await updateRecord('life_bets', betId, { status: 'paused' });
    check('更新状态为暂搁', patched?.status === 'paused');

    const got = await getRecord('life_bets', betId);
    check('读取赌注', got?.status === 'paused');
  } catch (err) {
    check('赌注 CRUD', false, err instanceof Error ? err.message : String(err));
  }

  console.log('\n=== 快照可灌空/有数据表 ===\n');
  try {
    const cursor0 = await getSnapshotCursor0();
    const page = await pullSnapshotTable('life_bets', null, 50, cursor0);
    check('snapshot life_bets', page.table === 'life_bets' && Array.isArray(page.rows));
    const pageDir = await pullSnapshotTable('life_directions', null, 50, cursor0);
    check(
      'snapshot life_directions',
      pageDir.table === 'life_directions' && Array.isArray(pageDir.rows),
    );
  } catch (err) {
    check('snapshot', false, err instanceof Error ? err.message : String(err));
  }

  console.log('\n=== life_road_nodes 槽位唯一 ===\n');
  try {
    const monthId = makeId('lrn_m_');
    nodeIds.push(monthId);
    const created = await createRecord('life_road_nodes', {
      id: monthId,
      kind: 'month',
      title: '本月焦点自测',
      calendar_year: year,
      month: 11,
      status: 'on_track',
    });
    check('创建月节点', created?.id === monthId);
    check('月节点自动补季度', Number(created?.quarter) === 4);

    const dupId = makeId('lrn_dup_');
    nodeIds.push(dupId);
    let blocked = false;
    try {
      await createRecord('life_road_nodes', {
        id: dupId,
        kind: 'month',
        title: '同月应被拒',
        calendar_year: year,
        month: 11,
        status: 'on_track',
      });
    } catch (err) {
      blocked = err instanceof CrudError && err.status >= 400 && err.status < 500;
    }
    check('同月第二条被拒 4xx', blocked);

    const multiId = makeId('lrn_multi_');
    nodeIds.push(multiId);
    const multi = await createRecord('life_road_nodes', {
      id: multiId,
      kind: 'multi',
      title: '多年方向自测',
      status: 'on_track',
    });
    check('创建多年节点', multi?.id === multiId);
  } catch (err) {
    check('life_road_nodes 用例', false, err instanceof Error ? err.message : String(err));
  }

  console.log('\n=== 清理 ===\n');
  await cleanupIds('life_road_nodes', nodeIds);
  await cleanupIds('life_bets', betIds);
  await cleanupIds('life_directions', [dirId]);
  check('清理完成', true);

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
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
