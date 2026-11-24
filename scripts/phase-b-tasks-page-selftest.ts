/**
 * 阶段 B 自测（不连库）：危险 bootstrap、habits 窗口、heatmap 口径门禁。
 *
 *   npx tsx scripts/phase-b-tasks-page-selftest.ts
 */
import assert from 'node:assert/strict';
import { tasksPageConfig } from '../src/config/index.js';
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

function section(name: string) {
  console.log(`\n== ${name} ==`);
}

section('B1 dangerous bootstrap detect');
{
  const all = parseTasksBootstrapInclude(undefined);
  assert.equal(isDangerousTasksBootstrapInclude(all), true, '默认全开 include 应判危险');

  const heatmap = parseTasksBootstrapInclude('heatmap');
  assert.equal(isDangerousTasksBootstrapInclude(heatmap), true, 'heatmap include 应判危险');

  const checkIns = parseTasksBootstrapInclude('habitCheckIns');
  assert.equal(isDangerousTasksBootstrapInclude(checkIns), true);

  const tasksOnly = parseTasksBootstrapInclude('tasks');
  assert.equal(isDangerousTasksBootstrapInclude(tasksOnly), false, '仅 tasks 不算危险大包');

  const light = parseTasksBootstrapInclude('pointsWallet');
  assert.equal(isDangerousTasksBootstrapInclude(light), false);

  assert.equal(
    tasksPageConfig.dangerousBootstrapReject,
    true,
    '默认 TASKS_DANGEROUS_BOOTSTRAP_REJECT 应为 true',
  );
  console.log('ok dangerous detect + reject default');
}

section('B2 taskView pagination');
{
  const p = resolveTaskViewPagination({ page: 2, limit: 50 }, 120);
  assert.equal(p.page, 2);
  assert.equal(p.limit, 50);
  assert.equal(p.total, 120);
  assert.equal(p.totalPages, 3);
  assert.equal(p.offset, 50);
  const capped = resolveTaskViewPagination({ page: 1, limit: 9999 }, 10);
  assert.ok(capped.limit <= 500, 'limit 有上限');
  console.log('ok pagination');
}

section('B4 habits-grid check-in window');
{
  const today = '2026-08-18';
  const onlyBuild = resolveHabitsGridCheckInStartYmd(today, [
    { extra_data: JSON.stringify({ habitKind: 'build' }) },
  ]);
  assert.equal(onlyBuild, today, '养成只查今日');

  const monthlyTask = resolveHabitsGridCheckInStartYmd(today, [
    { extra_data: JSON.stringify({ habitKind: 'task', schedule: { activeTab: '每月' } }) },
  ]);
  assert.equal(monthlyTask, '2026-08-01', '月周期从月初');

  const yearlyTask = resolveHabitsGridCheckInStartYmd(today, [
    { extra_data: JSON.stringify({ habitKind: 'task', schedule: { activeTab: '每年' } }) },
  ]);
  assert.equal(yearlyTask, '2026-01-01', '年周期从年初');

  const weeklyTask = resolveHabitsGridCheckInStartYmd(today, [
    { extra_data: JSON.stringify({ habitKind: 'task', schedule: { activeTab: '每周' } }) },
  ]);
  assert.ok(weeklyTask <= today && weeklyTask >= '2026-08-10', `周起点 ${weeklyTask}`);

  const mixed = resolveHabitsGridCheckInStartYmd(today, [
    { extra_data: JSON.stringify({ habitKind: 'build' }) },
    { extra_data: JSON.stringify({ habitKind: 'task', schedule: { activeTab: '每年' } }) },
  ]);
  assert.equal(mixed, '2026-01-01', '混合取最早周期起点');
  console.log('ok habits window');
}

section('B5 heatmap created_at lower bound');
{
  const bounds = resolveHeatmapEventCreatedAtBounds(
    '2026-08-01',
    '2026-08-18',
    { hour: 4, minute: 0 },
  );
  assert.equal(bounds.createdAtGte, '2026-08-01 04:00:00');
  assert.ok(bounds.createdAtLte.startsWith('2026-08-19'), bounds.createdAtLte);
  console.log('ok created_at bounds', bounds);
}

section('B5 口径门禁：净完成 / 撤销重做 / 重复 / 青蛙互斥');
{
  const netRecomplete = filterNetCompletedEvents(
    [
      { task_id: 't1', action: 'completed', created_at: '2026-08-16 21:00:00', logicalYmd: '2026-08-16' },
      { task_id: 't1', action: 'reopened', created_at: '2026-08-17 09:00:00', logicalYmd: '2026-08-17' },
      { task_id: 't1', action: 'completed', created_at: '2026-08-18 22:00:00', logicalYmd: '2026-08-18' },
    ],
    new Set(),
  );
  assert.equal(netRecomplete.length, 1);
  assert.equal(netRecomplete[0]?.logicalYmd, '2026-08-18');

  const netReopened = filterNetCompletedEvents(
    [
      { task_id: 't1', action: 'completed', created_at: '2026-08-17 21:00:00', logicalYmd: '2026-08-17' },
      { task_id: 't1', action: 'reopened', created_at: '2026-08-18 09:00:00', logicalYmd: '2026-08-18' },
    ],
    new Set(),
  );
  assert.equal(netReopened.length, 0);

  const netRepeating = filterNetCompletedEvents(
    [
      { task_id: 'r1', action: 'completed', created_at: '2026-08-17 10:00:00', logicalYmd: '2026-08-17' },
      { task_id: 'r1', action: 'completed', created_at: '2026-08-18 10:00:00', logicalYmd: '2026-08-18' },
    ],
    new Set(['r1']),
  );
  assert.equal(netRepeating.length, 2);

  const mutex = excludeTodosAlreadyCountedAsFrogs(
    [{ task_id: 't_frog' }, { task_id: 't_todo' }],
    new Set(['t_frog']),
  );
  assert.equal(mutex.length, 1);
  assert.equal(mutex[0]?.task_id, 't_todo');

  const frogNet = aggregateFrogEvents(
    [
      {
        id: 'fevt_1',
        task_id: 'p_project',
        assigned_ymd: '2026-08-18',
        action: 'completed',
        created_at: '2026-08-18 09:00:00',
        task_title: '项目青蛙',
      },
      {
        id: 'fevt_2',
        task_id: 'p_project',
        assigned_ymd: '2026-08-18',
        action: 'reopened',
        created_at: '2026-08-18 10:00:00',
        task_title: '项目青蛙',
      },
    ],
    '2026-08-01',
    '2026-08-31',
  );
  assert.equal(frogNet.countsByDay['2026-08-18'] ?? 0, 0, '项目青蛙最新 reopen 不计');
  console.log('ok 口径门禁');
}

console.log('\nphase-b-tasks-page-selftest: all passed');
