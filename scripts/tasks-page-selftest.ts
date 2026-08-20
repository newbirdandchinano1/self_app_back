/**
 * 任务 Tab 专用接口口径自测
 * 运行：npx tsx scripts/tasks-page-selftest.ts
 */
import '../src/bootstrap/timezone.js';
import {
  areSubHabitsCompleteForDay,
  buildHabitsGridItemsForDay,
  isFrogAssignedOn,
  isStandaloneTodoInTasksPageList,
  type HabitsGridItem,
} from '../src/services/calendar/aggregation.js';
import type { CalendarTaskRow } from '../src/services/calendar/types.js';
import {
  INBOX_PROJECT_CATEGORY_ID,
  normalizeCatalogCategoryId,
} from '../src/services/pages/catalog-inbox-seed.js';
import {
  excludeTodosAlreadyCountedAsFrogs,
  filterNetCompletedEvents,
} from '../src/services/pages/task-net-completion.js';
import { aggregateFrogEvents } from '../src/services/pages/completion-heatmap.js';
import { resolveTaskViewPagination, matchesMatrixWeekScheduleWindow } from '../src/services/pages/tasks-bootstrap.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const boundary0 = { hour: 0, minute: 0 };
const boundary4 = { hour: 4, minute: 0 };

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

console.log('=== P0 待办净完成 ===\n');

const netRecomplete = filterNetCompletedEvents(
  [
    { task_id: 't1', action: 'completed', created_at: '2026-08-16 21:00:00', logicalYmd: '2026-08-16' },
    { task_id: 't1', action: 'reopened', created_at: '2026-08-17 09:00:00', logicalYmd: '2026-08-17' },
    { task_id: 't1', action: 'completed', created_at: '2026-08-18 22:00:00', logicalYmd: '2026-08-18' },
  ],
  new Set(),
);
check(
  '非重复：完成→撤销→再完成只计再完成当天',
  netRecomplete.length === 1 && netRecomplete[0]?.logicalYmd === '2026-08-18',
  JSON.stringify(netRecomplete),
);

const netReopened = filterNetCompletedEvents(
  [
    { task_id: 't1', action: 'completed', created_at: '2026-08-17 21:00:00', logicalYmd: '2026-08-17' },
    { task_id: 't1', action: 'reopened', created_at: '2026-08-18 09:00:00', logicalYmd: '2026-08-18' },
  ],
  new Set(),
);
check('非重复：最新为 reopened 则任何一天都不计', netReopened.length === 0);

const netRepeating = filterNetCompletedEvents(
  [
    { task_id: 'r1', action: 'completed', created_at: '2026-08-17 10:00:00', logicalYmd: '2026-08-17' },
    { task_id: 'r1', action: 'completed', created_at: '2026-08-18 10:00:00', logicalYmd: '2026-08-18' },
  ],
  new Set(['r1']),
);
check(
  '重复待办：各执行日可分别计一次',
  netRepeating.length === 2,
  JSON.stringify(netRepeating.map((e) => e.logicalYmd)),
);

const mutex = excludeTodosAlreadyCountedAsFrogs(
  [{ task_id: 't_frog' }, { task_id: 't_todo' }],
  new Set(['t_frog']),
);
check(
  '青蛙互斥：同日同 task_id 待办扣掉',
  mutex.length === 1 && mutex[0]?.task_id === 't_todo',
);

console.log('\n=== P0b 青蛙净完成（completion-heatmap） ===\n');

const frogNet = aggregateFrogEvents(
  [
    {
      id: 'fevt_1',
      task_id: 't_frog',
      assigned_ymd: '2026-08-18',
      action: 'completed',
      created_at: '2026-08-18 09:00:00',
      task_title: '写周报',
    },
    {
      id: 'fevt_2',
      task_id: 't_frog',
      assigned_ymd: '2026-08-18',
      action: 'reopened',
      created_at: '2026-08-18 10:00:00',
      task_title: '写周报',
    },
    {
      id: 'fevt_3',
      task_id: 't_frog',
      assigned_ymd: '2026-08-18',
      action: 'completed',
      created_at: '2026-08-18 11:00:00',
      task_title: '写周报',
    },
  ],
  '2026-08-01',
  '2026-08-21',
);
check(
  '青蛙：完成→撤销→再完成只计 1',
  frogNet.countsByDay['2026-08-18'] === 1,
  JSON.stringify(frogNet.countsByDay),
);

const frogReopened = aggregateFrogEvents(
  [
    {
      id: 'fevt_a',
      task_id: 't1',
      assigned_ymd: '2026-08-18',
      action: 'completed',
      created_at: '2026-08-18 09:00:00',
    },
    {
      id: 'fevt_b',
      task_id: 't1',
      assigned_ymd: '2026-08-18',
      action: 'reopened',
      created_at: '2026-08-18 12:00:00',
    },
  ],
  '2026-08-01',
  '2026-08-21',
);
check('青蛙：最新为 reopened 不计', (frogReopened.countsByDay['2026-08-18'] ?? 0) === 0);

const frogIsoYmd = aggregateFrogEvents(
  [
    {
      id: 'fevt_iso',
      task_id: 't_iso',
      assigned_ymd: '2026-08-18T00:00:00.000Z',
      action: 'completed',
      created_at: '2026-08-18 09:00:00',
      task_title: 'ISO 指派日',
    },
  ],
  '2026-08-01',
  '2026-08-21',
);
check(
  '青蛙：assigned_ymd 带 ISO 前缀仍按日计入',
  frogIsoYmd.countsByDay['2026-08-18'] === 1,
  JSON.stringify(frogIsoYmd.countsByDay),
);

const frogNoTaskId = aggregateFrogEvents(
  [
    {
      id: 'fevt_orphan',
      task_id: null,
      assigned_ymd: '2026-08-18',
      action: 'completed',
      created_at: '2026-08-18 09:00:00',
      task_title: '无 task_id',
    },
  ],
  '2026-08-01',
  '2026-08-21',
);
check(
  '青蛙：task_id 为空时用事件 id 仍计入',
  frogNoTaskId.countsByDay['2026-08-18'] === 1 &&
    frogNoTaskId.taskIdsByDay.get('2026-08-18')?.has('fevt_orphan') === true,
);

const frogProject = aggregateFrogEvents(
  [
    {
      id: 'fevt_proj',
      task_id: 'p_proj_xxx',
      assigned_ymd: '2026-08-21',
      action: 'completed',
      created_at: '2026-08-21 01:20:00',
      task_title: '无子任务项目名',
    },
    {
      id: 'fevt_task',
      task_id: 't_task_xxx',
      assigned_ymd: '2026-08-21',
      action: 'completed',
      created_at: '2026-08-21 01:21:00',
      task_title: '写周报',
    },
  ],
  '2026-08-01',
  '2026-08-21',
);
check(
  '青蛙：项目 id 与任务 id 可同日各计 1（共 2）',
  frogProject.countsByDay['2026-08-21'] === 2 &&
    frogProject.taskIdsByDay.get('2026-08-21')?.has('p_proj_xxx') === true &&
    frogProject.taskIdsByDay.get('2026-08-21')?.has('t_task_xxx') === true,
  JSON.stringify(frogProject.countsByDay),
);

const frogProjectReopened = aggregateFrogEvents(
  [
    {
      id: 'fevt_p1',
      task_id: 'p_proj_xxx',
      assigned_ymd: '2026-08-21',
      action: 'completed',
      created_at: '2026-08-21 01:20:00',
    },
    {
      id: 'fevt_p2',
      task_id: 'p_proj_xxx',
      assigned_ymd: '2026-08-21',
      action: 'reopened',
      created_at: '2026-08-21 02:00:00',
    },
  ],
  '2026-08-01',
  '2026-08-21',
);
check(
  '青蛙：项目青蛙最新为 reopened 则净完成不计',
  (frogProjectReopened.countsByDay['2026-08-21'] ?? 0) === 0,
);

console.log('\n=== P1 今日青蛙指派日 ===\n');

check(
  'extra_data.frogAssignedOn = 今日',
  isFrogAssignedOn(JSON.stringify({ frogAssignedOn: '2026-08-18' }), '2026-08-18'),
);
check(
  'frogAssignedDates 含今日',
  isFrogAssignedOn(JSON.stringify({ frogAssignedDates: ['2026-08-17', '2026-08-18'] }), '2026-08-18'),
);
check(
  '日界非 0：指派日按 extra_data 字符串比较，不随小时漂移',
  isFrogAssignedOn(JSON.stringify({ frogAssignedOn: '2026-08-17' }), '2026-08-17') &&
    !isFrogAssignedOn(JSON.stringify({ frogAssignedOn: '2026-08-17' }), '2026-08-18'),
);
check(
  '列 frog_assigned_on 亦可命中',
  isFrogAssignedOn(null, '2026-08-18', '2026-08-18'),
);

console.log('\n=== P2 习惯格 ===\n');

const taskHabitExtra = JSON.stringify({
  habitKind: 'task',
  quantify: { expectedGoal: { type: 'times', value: 3 }, dailyGoal: 1 },
  schedule: { activeTab: '每周' },
});
const taskItems = buildHabitsGridItemsForDay({
  logicalYmd: '2026-08-18',
  habits: [{ id: 'h_task', name: '周报', icon: '', extra_data: taskHabitExtra }],
  habitCheckInsByHabit: new Map([['h_task', { '2026-08-18': 1 }]]),
  todayCheckIns: new Map([['h_task', 1]]),
  dayBoundary: boundary0,
});
const taskItem = taskItems[0] as HabitsGridItem | undefined;
check('任务型：今日打过卡但周期未达标不打勾', taskItem?.displayCompleted === false);
check(
  '任务型：periodProgress / periodGoal 有值',
  taskItem?.periodProgress === 1 && taskItem?.periodGoal === 3,
  JSON.stringify({ progress: taskItem?.periodProgress, goal: taskItem?.periodGoal }),
);
check(
  '习惯格 item 含 extra_data（子习惯/积分写回）',
  taskItem?.extra_data === taskHabitExtra,
);

const subExtra = JSON.stringify({
  habitKind: 'build',
  subHabitsEnabled: true,
  subHabits: [{ id: 's1' }, { id: 's2' }],
  subHabitCheckIns: { '2026-08-18': { s1: true } },
});
check('子习惯未全完成 → false', areSubHabitsCompleteForDay(subExtra, '2026-08-18') === false);

const subAllExtra = JSON.stringify({
  habitKind: 'build',
  subHabitsEnabled: true,
  subHabits: [{ id: 's1' }, { id: 's2' }],
  subHabitCheckIns: { '2026-08-18': ['s1', 's2'] },
});
check('子习惯全完成 → true', areSubHabitsCompleteForDay(subAllExtra, '2026-08-18') === true);

const parentWithSubs = buildHabitsGridItemsForDay({
  logicalYmd: '2026-08-18',
  habits: [
    {
      id: 'h_sub',
      name: '晨间',
      icon: '',
      extra_data: JSON.stringify({
        habitKind: 'build',
        quantify: { dailyGoal: 1 },
        subHabitsEnabled: true,
        subHabits: [{ id: 's1' }, { id: 's2' }],
        subHabitCheckIns: { '2026-08-18': { s1: true } },
      }),
    },
  ],
  habitCheckInsByHabit: new Map([['h_sub', { '2026-08-18': 1 }]]),
  todayCheckIns: new Map([['h_sub', 1]]),
  dayBoundary: boundary0,
});
check('子习惯未全完成：父习惯不显示完成', parentWithSubs[0]?.displayCompleted === false);
check(
  '子习惯 extra_data 原样带回',
  typeof parentWithSubs[0]?.extra_data === 'string' &&
    parentWithSubs[0].extra_data.includes('subHabitsEnabled'),
);

const futureHabit = buildHabitsGridItemsForDay({
  logicalYmd: '2026-08-18',
  habits: [
    {
      id: 'h_future',
      name: '未来才创建',
      icon: '',
      extra_data: JSON.stringify({ habitKind: 'build' }),
      created_at: '2026-08-19 08:00:00',
    },
  ],
  habitCheckInsByHabit: new Map(),
  todayCheckIns: new Map(),
  dayBoundary: boundary0,
});
check(
  '创建日之后才显示：仍返回行且 hiddenOnViewDay=true',
  futureHabit.length === 1 &&
    futureHabit[0]?.hiddenOnViewDay === true &&
    futureHabit[0]?.displayCompleted === false &&
    typeof futureHabit[0]?.extra_data === 'string',
);

console.log('\n=== P3 独立待办日界 ===\n');

function todo(partial: Partial<CalendarTaskRow> & Pick<CalendarTaskRow, 'id'>): CalendarTaskRow {
  return {
    project_id: null,
    parent_task_id: null,
    title: 'x',
    status: 'todo',
    priority: 0,
    due_date: null,
    completed_at: null,
    created_at: '2026-08-01 10:00:00',
    updated_at: '2026-08-01 10:00:00',
    extra_data: null,
    ...partial,
  };
}

check(
  '未到执行日的重复待办仍出现在列表',
  isStandaloneTodoInTasksPageList(
    todo({
      id: 'rep',
      extra_data: JSON.stringify({ schedule: { repeatOption: '每周', weeklyDays: [5] } }),
    }),
    '2026-08-18',
    boundary0,
  ),
);

check(
  '今日日界内已完成的独立待办仍出现',
  isStandaloneTodoInTasksPageList(
    todo({ id: 'done_today', status: 'done', completed_at: '2026-08-18 21:00:00' }),
    '2026-08-18',
    boundary0,
  ),
);

check(
  '已完成且超出日界的独立待办不再出现',
  isStandaloneTodoInTasksPageList(
    todo({ id: 'done_old', status: 'done', completed_at: '2026-08-17 21:00:00' }),
    '2026-08-18',
    boundary0,
  ) === false,
);

check(
  '日界 4:00：凌晨 2:00 完成算前一逻辑日，今日列表不出现',
  isStandaloneTodoInTasksPageList(
    todo({ id: 'done_early', status: 'done', completed_at: '2026-08-18 02:00:00' }),
    '2026-08-18',
    boundary4,
  ) === false,
);

console.log('\n=== P4 收集箱 categoryId 别名 ===\n');

check(
  'categoryId=inbox → project_category_inbox',
  normalizeCatalogCategoryId('inbox') === INBOX_PROJECT_CATEGORY_ID,
);
check(
  'categoryId=收集箱 → project_category_inbox',
  normalizeCatalogCategoryId('收集箱') === INBOX_PROJECT_CATEGORY_ID,
);
check(
  '其它分类 id 保持原样',
  normalizeCatalogCategoryId('cat_work') === 'cat_work',
);

console.log('\n=== P6 matrixWeek 计划窗筛选 ===\n');

const weekStart = '2026-08-17';
const weekEnd = '2026-08-23';

check(
  '跨整月时间段与本周有交集 → 命中',
  matchesMatrixWeekScheduleWindow(
    JSON.stringify({
      schedule: {
        mode: 'time',
        range: { start: '2026-08-01T00:00:00', end: '2026-08-31T23:59:59' },
      },
    }),
    '2026-08-31',
    weekStart,
    weekEnd,
  ),
);

check(
  'schedule.date 在本周 → 命中',
  matchesMatrixWeekScheduleWindow(
    JSON.stringify({ schedule: { date: '2026-08-20' } }),
    null,
    weekStart,
    weekEnd,
  ),
);

check(
  '无 schedule 时 due_date 在本周 → 命中',
  matchesMatrixWeekScheduleWindow(null, '2026-08-18', weekStart, weekEnd),
);

check(
  '时间范围完全在下周 → 不命中',
  matchesMatrixWeekScheduleWindow(
    JSON.stringify({
      schedule: {
        mode: 'time',
        range: { start: '2026-08-24T00:00:00', end: '2026-08-30T23:59:59' },
      },
    }),
    '2026-08-30',
    weekStart,
    weekEnd,
  ) === false,
);

check(
  '过期但时间范围不在本周 → 不命中（不再按 due_date 过期兜底）',
  matchesMatrixWeekScheduleWindow(
    JSON.stringify({
      schedule: {
        mode: 'time',
        range: { start: '2026-07-01T00:00:00', end: '2026-07-31T23:59:59' },
      },
    }),
    '2026-07-31',
    weekStart,
    weekEnd,
  ) === false,
);

check(
  '有 time range 时优先于 schedule.date',
  matchesMatrixWeekScheduleWindow(
    JSON.stringify({
      schedule: {
        mode: 'time',
        range: { start: '2026-08-01T00:00:00', end: '2026-08-31T23:59:59' },
        date: '2026-09-01',
      },
    }),
    '2026-09-01',
    weekStart,
    weekEnd,
  ),
);

console.log('\n=== P5 taskView 分页 ===\n');

const page1 = resolveTaskViewPagination({ page: 1, limit: 200 }, 201);
check(
  '201 条 limit=200 → totalPages=2，第 1 页 offset=0',
  page1.totalPages === 2 && page1.total === 201 && page1.offset === 0 && page1.limit === 200,
);
const page2 = resolveTaskViewPagination({ page: 2, limit: 200 }, 201);
check('第 2 页 offset=200', page2.offset === 200 && page2.page === 2);
const defaultLimit = resolveTaskViewPagination({}, 50);
check('缺省 limit=200', defaultLimit.limit === 200 && defaultLimit.page === 1);
const emptyPage = resolveTaskViewPagination({ page: 1, limit: 200 }, 0);
check('空列表 total=0 且仍返回 totalPages 数值', emptyPage.total === 0 && typeof emptyPage.totalPages === 'number');

try {
  assert(failed === 0, 'has failures');
} catch {
  /* counted below */
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
