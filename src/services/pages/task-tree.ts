import type { RowDataPacket } from 'mysql2';
import { getTableMeta } from '../crud.js';
import { db } from '../../db/index.js';

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
  if (status === 'done' && options.includeCompleted !== true) return false;
  if (status === 'cancelled' && options.includeCancelled !== true) return false;
  if (status === 'shelved' && options.includeShelved === false) return false;
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
  if (options.includeCompleted !== true) excluded.add('done');
  if (options.includeCancelled !== true) excluded.add('cancelled');
  if (options.includeShelved === false) excluded.add('shelved');
  if (excluded.size === 0) return;
  where.push(`(status IS NULL OR status NOT IN (${[...excluded].map(() => '?').join(', ')}))`);
  values.push(...excluded);
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
  return rows.map((row) => row as TaskRow);
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
    return { ...task, children };
  }

  return roots.sort(sortTaskRows).map((root) => toNode(root));
}

export function sortProjects(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((a, b) => {
    const aStatus = String(a.status ?? '');
    const bStatus = String(b.status ?? '');
    if (aStatus !== bStatus) {
      if (aStatus === 'active') return -1;
      if (bStatus === 'active') return 1;
    }
    return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh-CN');
  });
}

export function isBlankValue(value: unknown): boolean {
  return value == null || value === '';
}

export { isPresentColumn, isBlankColumn };
