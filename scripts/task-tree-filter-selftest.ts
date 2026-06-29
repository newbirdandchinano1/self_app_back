import {
  buildNestedTaskTree,
  resolveProjectListStatusFilters,
  taskMatchesStatusFilter,
  type TaskRow,
} from '../src/services/pages/task-tree.js';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const columns = new Set(['status', 'sync_status']);

// 场景 1：根任务完成后，includeCompleted=true 应返回
const rootDone: TaskRow = {
  id: 't1',
  project_id: 'p1',
  parent_task_id: null,
  status: 'done',
  title: '已完成根任务',
};
const rows1 = [rootDone].filter((t) =>
  taskMatchesStatusFilter(t, columns, { includeCompleted: true }),
);
const tree1 = buildNestedTaskTree(rows1, 'p1');
assert(tree1.length === 1 && tree1[0].id === 't1', '根任务 done + includeCompleted=true 应出现在树中');

// 场景 2：项目列表默认包含 done（未传 includeCompleted）
const projectDefaults = resolveProjectListStatusFilters({});
const rows2 = [rootDone].filter((t) =>
  taskMatchesStatusFilter(t, columns, projectDefaults),
);
assert(rows2.length === 1, '项目列表默认应返回 done 任务');

// 场景 2b：显式 includeCompleted=false 时排除 done
const rows2b = [rootDone].filter((t) =>
  taskMatchesStatusFilter(t, columns, resolveProjectListStatusFilters({ includeCompleted: false })),
);
assert(rows2b.length === 0, 'includeCompleted=false 时应排除 done 任务');

// 场景 2c：任务 flat 列表仍默认排除 done（需 opt-in）
const rows2c = [rootDone].filter((t) =>
  taskMatchesStatusFilter(t, columns, { includeCompleted: false }),
);
assert(rows2c.length === 0, '任务 flat 列表未传 includeCompleted 时排除 done');

// 场景 2d：两个同级根任务（todo + done），项目列表默认应返回 2 个
const rootTodo: TaskRow = {
  id: 't2',
  project_id: 'p1',
  parent_task_id: null,
  status: 'todo',
  title: '进行中',
};
const rows2d = [rootTodo, rootDone].filter((t) =>
  taskMatchesStatusFilter(t, columns, projectDefaults),
);
const tree2d = buildNestedTaskTree(rows2d, 'p1');
assert(tree2d.length === 2, '项目列表默认应同时返回 todo 与 done 两个根任务');

// 场景 3：子任务完成，父任务未完成，includeCompleted=true
const parent: TaskRow = {
  id: 'p',
  project_id: 'p1',
  parent_task_id: null,
  status: 'todo',
};
const childDone: TaskRow = {
  id: 'c',
  project_id: null,
  parent_task_id: 'p',
  status: 'done',
};
const rows3 = [parent, childDone].filter((t) =>
  taskMatchesStatusFilter(t, columns, { includeCompleted: true }),
);
const tree3 = buildNestedTaskTree(rows3, 'p1');
assert(
  tree3.length === 1 && tree3[0].children.length === 1 && tree3[0].children[0].id === 'c',
  '子任务 done + includeCompleted=true 应挂在父节点下',
);

// 场景 4：子任务完成但父任务不在 filtered 集合（父 done 被过滤），resolve 失败导致子任务从树消失
const parentDone: TaskRow = { ...parent, status: 'done' };
const allStructural = [parentDone, childDone];
const filteredOnlyChild = [childDone].filter((t) =>
  taskMatchesStatusFilter(t, columns, { includeCompleted: true }),
);
const tree4broken = buildNestedTaskTree(filteredOnlyChild, 'p1');
assert(
  tree4broken.length === 0,
  '无结构索引时，父任务不在返回集会导致子任务从树中消失',
);

const structuralById = new Map(allStructural.map((t) => [String(t.id), t]));
const tree4fixed = buildNestedTaskTree(filteredOnlyChild, 'p1', structuralById);
assert(
  tree4fixed.length === 1 && tree4fixed[0].id === 'c',
  '传入 structuralById 后，子任务应能正确归入项目树',
);

console.log('task-tree-filter-selftest: all passed');
