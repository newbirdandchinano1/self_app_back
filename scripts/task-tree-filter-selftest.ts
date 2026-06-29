import {
  buildNestedTaskTree,
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

// 场景 2：includeCompleted 未传 / false 时，done 任务被过滤
const rows2 = [rootDone].filter((t) =>
  taskMatchesStatusFilter(t, columns, {}),
);
assert(rows2.length === 0, '未传 includeCompleted 时 done 任务应被过滤');

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
