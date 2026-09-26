import type { RowDataPacket } from 'mysql2';
import { getTableMeta, listAllRecords } from '../crud.js';
import { db } from '../../db/index.js';
import {
  formatRecordDateTimesForApi,
  normalizeDbDateTimeForTableStorage,
} from '../calendar/logical-day.js';
import { normalizeCatalogCategoryId } from './tasks-catalog.js';

export type TaskRow = Record<string, unknown>;

export type TaskTreeNode = TaskRow & {
  children: TaskTreeNode[];
};

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function isBlankColumn(column: string): string {
  const q = quoteIdent(column);
  return `(${q} IS NULL OR ${q} = '')`;
}

function isPresentColumn(column: string): string {
  const q = quoteIdent(column);
  return `(${q} IS NOT NULL AND ${q} != '')`;
}

export function optionalNotPendingDelete(columns: Set<string>): string[] {
  return columns.has('sync_status') ? [`(sync_status IS NULL OR sync_status != 'pending_delete')`] : [];
}

export function optionalNotDeleted(columns: Set<string>): string[] {
  return columns.has('deleted_at') ? ['deleted_at IS NULL'] : [];
}

export function parseCsv(raw?: string): string[] {
  return raw?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
}

export type TaskStatusFilterOptions = {
  includeCompleted?: boolean;
  includeCancelled?: boolean;
  includeShelved?: boolean;
};

export function taskMatchesStatusFilter(
  task: TaskRow,
  columns: Set<string>,
  options: TaskStatusFilterOptions,
): boolean {
  if (!columns.has('status')) return true;
  if (task.status == null) return true;
  const status = String(task.status);
  if (status === 'done' && !options.includeCompleted) return false;
  if (status === 'cancelled' && !options.includeCancelled) return false;
  if (options.includeShelved === false && status === 'shelved') return false;
  return true;
}

export function addStatusFilters(
  where: string[],
  values: unknown[],
  columns: Set<string>,
  options: TaskStatusFilterOptions,
): void {
  if (!columns.has('status')) return;
  const excluded = new Set<string>();
  if (!options.includeCompleted) excluded.add('done');
  if (!options.includeCancelled) excluded.add('cancelled');
  if (options.includeShelved === false) excluded.add('shelved');
  if (excluded.size === 0) return;
  where.push(`(status IS NULL OR status NOT IN (${[...excluded].map(() => '?').join(', ')}))`);
  values.push(...excluded);
}

/** 项目列表：默认返回已完成/已取消；仅显式传 false 时排除 */
export function resolveProjectListStatusFilters(
  params: TaskStatusFilterOptions = {},
): Required<Pick<TaskStatusFilterOptions, 'includeCompleted' | 'includeCancelled' | 'includeShelved'>> {
  return {
    includeCompleted: params.includeCompleted !== false,
    includeCancelled: params.includeCancelled !== false,
    includeShelved: params.includeShelved !== false,
  };
}

async function selectTaskRows(
  selectCols: string,
  where: string[],
  values: unknown[],
  orderBy = 'sort_order ASC, priority DESC, updated_at DESC',
): Promise<TaskRow[]> {
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectCols} FROM tasks ${whereSql} ORDER BY ${orderBy}`,
    values,
  );
  return rows.map((row) => formatRecordDateTimesForApi(row as TaskRow, 'tasks'));
}

export async function loadProjectTaskRows(
  projectIds: string[],
  options: TaskStatusFilterOptions = {},
): Promise<TaskRow[]> {
  const { filtered } = await loadProjectTaskRowsWithStructure(projectIds, options);
  return filtered;
}

export async function loadProjectTaskRowsWithStructure(
  projectIds: string[],
  options: TaskStatusFilterOptions = {},
): Promise<{ structural: TaskRow[]; filtered: TaskRow[]; structuralById: Map<string, TaskRow> }> {
  if (projectIds.length === 0) {
    return { structural: [], filtered: [], structuralById: new Map() };
  }

  const meta = await getTableMeta('tasks');
  const columns = new Set(meta.columns);
  const selectCols = meta.columns.map(quoteIdent).join(', ');
  const baseWhere = [...optionalNotDeleted(columns), ...optionalNotPendingDelete(columns)];

  const rootWhere = [...baseWhere];
  const rootValues: unknown[] = [];
  rootWhere.push(`project_id IN (${projectIds.map(() => '?').join(', ')})`);
  rootValues.push(...projectIds);

  // 禁止对任务再套 LIMIT：limit 只限制项目条数，本页每个项目要拉完整树。
  const roots = await selectTaskRows(selectCols, rootWhere, rootValues);
  const treeById = new Map<string, TaskRow>();
  const queue = [...roots];

  for (const row of roots) {
    treeById.set(String(row.id), row);
  }

  while (queue.length > 0) {
    const batch = queue.splice(0, 200);
    const ids = batch.map((row) => String(row.id)).filter(Boolean);
    if (ids.length === 0) continue;

    const childWhere = [
      ...baseWhere,
      `parent_task_id IN (${ids.map(() => '?').join(', ')})`,
    ];
    const childValues = [...ids];
    const children = await selectTaskRows(selectCols, childWhere, childValues);

    for (const child of children) {
      const id = String(child.id);
      if (treeById.has(id)) continue;
      treeById.set(id, child);
      queue.push(child);
    }
  }

  const structural = [...treeById.values()];
  const structuralById = new Map(structural.map((task) => [String(task.id), task]));
  const filtered = structural.filter((task) =>
    taskMatchesStatusFilter(task, columns, options),
  );

  return { structural, filtered, structuralById };
}

export function resolveTaskProjectId(task: TaskRow, byId: Map<string, TaskRow>): string | null {
  let current: TaskRow | undefined = task;
  const seen = new Set<string>();

  while (current) {
    const projectId = String(current.project_id ?? '');
    if (projectId) return projectId;

    const parentId = String(current.parent_task_id ?? '');
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    current = byId.get(parentId);
  }

  return null;
}

function sortTaskRows(a: TaskRow, b: TaskRow): number {
  const aOrder = Number(a.sort_order ?? 1000);
  const bOrder = Number(b.sort_order ?? 1000);
  if (aOrder !== bOrder) return aOrder - bOrder;

  const aPri = Number(a.priority ?? 0);
  const bPri = Number(b.priority ?? 0);
  if (aPri !== bPri) return bPri - aPri;

  return String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''));
}

export function buildNestedTaskTree(
  tasks: TaskRow[],
  projectId: string,
  structuralById?: Map<string, TaskRow>,
): TaskTreeNode[] {
  const allById = structuralById ?? new Map(tasks.map((task) => [String(task.id), task]));
  const scoped = tasks.filter((task) => resolveTaskProjectId(task, allById) === projectId);
  if (scoped.length === 0) return [];

  const byId = new Map(scoped.map((task) => [String(task.id), task]));
  const childrenByParent = new Map<string, TaskRow[]>();

  for (const task of scoped) {
    const parentId = String(task.parent_task_id ?? '');
    if (!parentId || !byId.has(parentId)) continue;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId)!.push(task);
  }

  const roots = scoped.filter((task) => {
    const parentId = String(task.parent_task_id ?? '');
    return !parentId || !byId.has(parentId);
  });

  function toNode(task: TaskRow): TaskTreeNode {
    const id = String(task.id);
    const children = (childrenByParent.get(id) ?? [])
      .sort(sortTaskRows)
      .map((child) => toNode(child));
    return {
      ...task,
      parent_task_id: task.parent_task_id ?? null,
      children,
    };
  }

  return roots.sort(sortTaskRows).map((root) => toNode(root));
}

export function countTaskTreeNodes(nodes: TaskTreeNode[]): number {
  let count = 0;
  const walk = (list: TaskTreeNode[]) => {
    for (const node of list) {
      count += 1;
      if (node.children.length > 0) walk(node.children);
    }
  };
  walk(nodes);
  return count;
}

export function sortProjects(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((a, b) => {
    const aStatus = String(a.status ?? '');
    const bStatus = String(b.status ?? '');
    if (aStatus !== bStatus) {
      if (aStatus === 'active') return -1;
      if (bStatus === 'active') return 1;
    }
    const aPri = Number(a.priority ?? 0);
    const bPri = Number(b.priority ?? 0);
    if (aPri !== bPri) return bPri - aPri;
    return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh-CN');
  });
}

export function isBlankValue(value: unknown): boolean {
  return value == null || value === '';
}

export { isPresentColumn, isBlankColumn };

export const PROJECT_LIST_DEFAULT_LIMIT = 200;
export const PROJECT_LIST_MAX_LIMIT = 200;

export interface ProjectListParams {
  categoryId?: string;
  categoryIds?: string;
  uncategorized?: boolean;
  includeCompleted?: boolean;
  includeCancelled?: boolean;
  includeShelved?: boolean;
  page?: number;
  limit?: number;
  updatedSince?: string;
  projectId?: string;
}

export type ProjectListItem = Record<string, unknown> & {
  taskCount: number;
  tasks: TaskTreeNode[];
};

export interface ProjectListPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ProjectListResult {
  list: ProjectListItem[];
  pagination: ProjectListPagination;
  meta: {
    serverTime: string;
    categoryId?: string;
    categoryIds?: string[];
    uncategorized?: boolean;
    includeCompleted?: boolean;
    includeCancelled?: boolean;
    includeShelved?: boolean;
    tasksComplete: true;
    projectId?: string;
  };
}

export function resolveRequestedProjectId(params: ProjectListParams): string | undefined {
  const id = params.projectId?.trim();
  return id ? id : undefined;
}

function resolveCategoryIds(params: {
  categoryId?: string;
  categoryIds?: string;
}): string[] | null {
  const ids = parseCsv(params.categoryIds).map(normalizeCatalogCategoryId);
  if (ids.length > 0) return ids;
  if (params.categoryId?.trim()) return [normalizeCatalogCategoryId(params.categoryId)];
  return null;
}

/** 分类过滤；带 projectId 时只取该项目（展开单棵树，不受分类 Tab 限制） */
export function filterProjectsForList(
  projects: Record<string, unknown>[],
  params: ProjectListParams,
): Record<string, unknown>[] {
  const requestedId = resolveRequestedProjectId(params);
  if (requestedId) {
    return projects.filter((row) => String(row.id) === requestedId);
  }

  const categoryIds = resolveCategoryIds(params);
  if (params.uncategorized) {
    return projects.filter((row) => row.category_id == null || row.category_id === '');
  }
  if (categoryIds && categoryIds.length > 0) {
    const idSet = new Set(categoryIds);
    return projects.filter((row) => idSet.has(String(row.category_id ?? '')));
  }
  return projects;
}

export function paginateProjects(
  allProjects: Record<string, unknown>[],
  page = 1,
  limit = PROJECT_LIST_DEFAULT_LIMIT,
): { pageProjects: Record<string, unknown>[]; pagination: ProjectListPagination } {
  const safePage = Math.max(1, page);
  const safeLimit = Math.min(PROJECT_LIST_MAX_LIMIT, Math.max(1, limit));
  const offset = (safePage - 1) * safeLimit;
  const pageProjects = allProjects.slice(offset, offset + safeLimit);
  return {
    pageProjects,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total: allProjects.length,
      totalPages: Math.ceil(allProjects.length / safeLimit),
    },
  };
}

export function attachProjectTaskTrees(
  pageProjects: Record<string, unknown>[],
  taskLoad: { filtered: TaskRow[]; structuralById: Map<string, TaskRow> },
): ProjectListItem[] {
  return pageProjects.map((project) => {
    const projectId = String(project.id);
    const tasks = buildNestedTaskTree(taskLoad.filtered, projectId, taskLoad.structuralById);
    return {
      ...project,
      taskCount: countTaskTreeNodes(tasks),
      tasks,
    };
  });
}

async function loadFilteredProjects(params: ProjectListParams): Promise<Record<string, unknown>[]> {
  const listOptions = params.updatedSince ? { updatedSince: params.updatedSince } : {};
  const projects = sortProjects(await listAllRecords('projects', listOptions));
  return filterProjectsForList(projects, params);
}

export async function getProjectList(params: ProjectListParams): Promise<ProjectListResult> {
  const allProjects = await loadFilteredProjects(params);
  const { pageProjects, pagination } = paginateProjects(allProjects, params.page, params.limit);
  const projectIds = pageProjects.map((row) => String(row.id)).filter(Boolean);

  const statusFilters = resolveProjectListStatusFilters(params);
  const taskLoad = await loadProjectTaskRowsWithStructure(projectIds, statusFilters);
  const list = attachProjectTaskTrees(pageProjects, taskLoad);

  const categoryIds = resolveCategoryIds(params);
  const requestedProjectId = resolveRequestedProjectId(params);

  return {
    list,
    pagination,
    meta: {
      serverTime: new Date().toISOString(),
      includeCompleted: statusFilters.includeCompleted,
      includeCancelled: statusFilters.includeCancelled,
      includeShelved: statusFilters.includeShelved,
      tasksComplete: true,
      ...(params.categoryId?.trim() ? { categoryId: params.categoryId.trim() } : {}),
      ...(categoryIds ? { categoryIds } : {}),
      ...(params.uncategorized ? { uncategorized: true } : {}),
      ...(requestedProjectId ? { projectId: requestedProjectId } : {}),
    },
  };
}

export interface TaskListParams {
  categoryId?: string;
  categoryIds?: string;
  uncategorized?: boolean;
  includeCompleted?: boolean;
  includeCancelled?: boolean;
  includeShelved?: boolean;
  page?: number;
  limit?: number;
  updatedSince?: string;
}

export interface TaskListResult {
  list: Record<string, unknown>[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  meta: {
    serverTime: string;
    categoryId?: string;
    categoryIds?: string[];
    uncategorized?: boolean;
    includeCompleted?: boolean;
    includeCancelled?: boolean;
    includeShelved?: boolean;
  };
}

export async function getTaskList(params: TaskListParams): Promise<TaskListResult> {
  const meta = await getTableMeta('tasks');
  const columns = new Set(meta.columns);
  const selectCols = meta.columns.map(quoteIdent).join(', ');

  const where = [...optionalNotDeleted(columns), ...optionalNotPendingDelete(columns)];
  const values: unknown[] = [];

  addStatusFilters(where, values, columns, {
    includeCompleted: params.includeCompleted === true,
    includeCancelled: params.includeCancelled === true,
    includeShelved: params.includeShelved,
  });

  if (params.updatedSince?.trim()) {
    where.push('updated_at > ?');
    values.push(
      normalizeDbDateTimeForTableStorage('tasks', params.updatedSince.trim()) ??
        params.updatedSince.trim(),
    );
  }

  const categoryIds = resolveCategoryIds(params);
  if (params.uncategorized) {
    where.push(isBlankColumn('category_id'));
  } else if (categoryIds && categoryIds.length > 0) {
    where.push(`category_id IN (${categoryIds.map(() => '?').join(', ')})`);
    values.push(...categoryIds);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const [countRows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM tasks ${whereSql}`,
    values,
  );
  const total = Number(countRows[0]?.total ?? 0);

  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(500, Math.max(1, params.limit ?? 50));
  const offset = (page - 1) * limit;

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectCols} FROM tasks ${whereSql}
     ORDER BY sort_order ASC, priority DESC, updated_at DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset],
  );

  const list = rows.map((row) => formatRecordDateTimesForApi(row as Record<string, unknown>, 'tasks'));

  return {
    list,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
    meta: {
      serverTime: new Date().toISOString(),
      ...(params.categoryId?.trim() ? { categoryId: params.categoryId.trim() } : {}),
      ...(categoryIds ? { categoryIds } : {}),
      ...(params.uncategorized ? { uncategorized: true } : {}),
      includeCompleted: params.includeCompleted === true,
      includeCancelled: params.includeCancelled === true,
      includeShelved: params.includeShelved === true,
    },
  };
}
