/**
 * GET /api/pages/projects 口径自测（不连库）
 * 运行：npx tsx scripts/project-list-selftest.ts
 */
import {
  attachProjectTaskTrees,
  filterProjectsForList,
  paginateProjects,
} from '../src/services/pages/project-list.js';
import {
  buildNestedTaskTree,
  countTaskTreeNodes,
  resolveProjectListStatusFilters,
  taskMatchesStatusFilter,
  type TaskRow,
} from '../src/services/pages/task-tree.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const columns = new Set(['status']);

function makeProject(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: id, status: 'active', priority: 0, ...extra };
}

function makeTasks(projectId: string, count: number, nestingEvery = 10): TaskRow[] {
  const rows: TaskRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `${projectId}_t${i}`;
    const parent_task_id =
      i > 0 && i % nestingEvery === 0 ? `${projectId}_t${i - 1}` : null;
    rows.push({
      id,
      project_id: projectId,
      parent_task_id,
      status: i === 3 ? 'done' : 'todo',
      title: `task ${i}`,
      sort_order: i,
    });
  }
  return rows;
}

const big = makeProject('p_big', { name: '大项目' });
const smallA = makeProject('p_small_a', { name: '小A', category_id: 'cat1' });
const smallB = makeProject('p_small_b', { name: '小B', category_id: null });
const projects = [big, smallA, smallB];

const bigTasks = makeTasks('p_big', 80, 10);
const smallATasks: TaskRow[] = [
  { id: 'sa1', project_id: 'p_small_a', parent_task_id: null, status: 'todo', title: 'A1', sort_order: 0 },
  { id: 'sa2', project_id: 'p_small_a', parent_task_id: 'sa1', status: 'todo', title: 'A2', sort_order: 1 },
];
const smallBTasks: TaskRow[] = [
  { id: 'sb1', project_id: 'p_small_b', parent_task_id: null, status: 'todo', title: 'B1', sort_order: 0 },
];
const allTasks = [...bigTasks, ...smallATasks, ...smallBTasks];
const structuralById = new Map(allTasks.map((t) => [String(t.id), t]));

const pageAll = paginateProjects(projects, 1, 200);
assert(pageAll.pagination.total === 3, 'pagination.total 应按项目个数计，不是任务条数');
assert(pageAll.pagination.totalPages === 1, '3 个项目 limit=200 应为 1 页');
assert(pageAll.pageProjects.length === 3, '本页应含全部 3 个项目');

const listAll = attachProjectTaskTrees(pageAll.pageProjects, {
  filtered: allTasks,
  structuralById,
});
assert(listAll[0].id === 'p_big', '大项目应在列表中');
assert(listAll[0].taskCount === 80, `大项目 taskCount 应为 80，实际 ${listAll[0].taskCount}`);
assert(
  listAll[0].taskCount === countTaskTreeNodes(listAll[0].tasks),
  'taskCount 必须等于树上递归节点数',
);
assert(listAll[1].tasks.length > 0, '同页小项目的 tasks 不应为空');
assert(listAll[2].taskCount === 1, '小项目 B taskCount=1');

const pageLimit1 = paginateProjects(projects, 1, 1);
assert(pageLimit1.pageProjects.length === 1, 'limit=1 只限制项目条数');
const listLimit1 = attachProjectTaskTrees(pageLimit1.pageProjects, {
  filtered: allTasks.filter((t) => t.project_id === 'p_big'),
  structuralById,
});
assert(listLimit1.length === 1, 'limit=1 应只返回 1 个项目');
assert(listLimit1[0].taskCount === 80, 'limit=1 绝不能变成只返回 1 条任务');
assert(pageLimit1.pagination.total === 3, 'limit=1 时 total 仍是项目总数 3');

const byProjectId = filterProjectsForList(projects, { projectId: 'p_big', categoryId: 'cat1' });
assert(byProjectId.length === 1 && byProjectId[0].id === 'p_big', 'projectId 应忽略分类过滤，只返回该项目');
const pageOne = paginateProjects(byProjectId, 1, 1);
const listOne = attachProjectTaskTrees(pageOne.pageProjects, {
  filtered: bigTasks,
  structuralById,
});
assert(listOne.length === 1 && listOne[0].id === 'p_big', 'projectId+limit=1 只返回这 1 个项目');
assert(listOne[0].taskCount === 80, '展开单项目时树必须完整');

const hideDone = resolveProjectListStatusFilters({ includeCompleted: false });
const filteredHideDone = allTasks.filter((t) => taskMatchesStatusFilter(t, columns, hideDone));
const treeHideDone = buildNestedTaskTree(filteredHideDone, 'p_big', structuralById);
assert(
  countTaskTreeNodes(treeHideDone) === filteredHideDone.filter((t) => t.project_id === 'p_big').length,
  'includeCompleted=false 后树上节点数 = 过滤后任务数',
);
assert(
  treeHideDone.every((n) => n.status !== 'done'),
  '隐藏已完成后根节点不应为 done',
);

const json = JSON.stringify(listAll);
assert(json.includes('"taskCount":80'), '序列化后应含 taskCount，不能被截断成残缺 JSON');
JSON.parse(json);

console.log('project-list-selftest: all passed');
