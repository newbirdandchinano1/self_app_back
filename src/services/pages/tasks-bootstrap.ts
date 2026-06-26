import type { RowDataPacket } from 'mysql2';
import {
  getTableFilteredSnapshotMeta,
  getTableMeta,
  listAllRecords,
  type ListOptions,
} from '../crud.js';
import { db } from '../../db/index.js';
import {
  isStandaloneTodoVisibleOnDay,
  sortStandaloneTodos,
} from '../calendar/aggregation.js';
import { normalizeTasksDayBoundary } from '../calendar/logical-day.js';
import type { CalendarTaskRow, TasksDayBoundary } from '../calendar/types.js';
import {
  COMPLETION_HEATMAP_WEEKS,
  resolveHeatmapRange,
  resolveHabitCheckInStartYmd,
  resolveHeatmapEventCreatedAtBounds,
} from './heatmap-range.js';
import { isValidYmd } from '../../utils/ymd.js';

const FULL_TABLES = [
  'projects',
  'project_categories',
  'tasks',
  'task_categories',
  'task_items',
  'habits',
  'habit_contexts',
] as const;

export const TASKS_BOOTSTRAP_TABLES = [
  ...FULL_TABLES,
  'habit_check_ins',
  'task_execution_events',
  'frog_completion_events',
] as const;

export type TasksBootstrapTable = (typeof TASKS_BOOTSTRAP_TABLES)[number];

const INCLUDE_ALIASES: Record<string, keyof TasksBootstrapInclude | 'heatmap'> = {
  projects: 'projects',
  projectcategories: 'projects',
  project_categories: 'projects',
  projectCategories: 'projects',
  tasks: 'tasks',
  taskcategories: 'taskCategories',
  task_categories: 'taskCategories',
  taskCategories: 'taskCategories',
  taskitems: 'taskItems',
  task_items: 'taskItems',
  taskItems: 'taskItems',
  habits: 'habits',
  habitcontexts: 'habitContexts',
  habit_contexts: 'habitContexts',
  habitContexts: 'habitContexts',
  habitcheckins: 'habitCheckIns',
  habit_check_ins: 'habitCheckIns',
  habitCheckIns: 'habitCheckIns',
  taskexecutionevents: 'taskExecutionEvents',
  task_execution_events: 'taskExecutionEvents',
  taskExecutionEvents: 'taskExecutionEvents',
  frogcompletionevents: 'frogCompletionEvents',
  frog_completion_events: 'frogCompletionEvents',
  frogCompletionEvents: 'frogCompletionEvents',
  heatmap: 'heatmap',
};

export type TasksBootstrapInclude = {
  projects: boolean;
  projectCategories: boolean;
  tasks: boolean;
  taskCategories: boolean;
  taskItems: boolean;
  habits: boolean;
  habitContexts: boolean;
  habitCheckIns: boolean;
  taskExecutionEvents: boolean;
  frogCompletionEvents: boolean;
};

export interface TasksBootstrapParams {
  dayBoundaryHour?: number;
  dayBoundaryMinute?: number;
  heatmapStart?: string;
  heatmapEnd?: string;
  habitCheckInStart?: string;
  habitCheckInEnd?: string;
  habitCheckInMonths?: number;
  include?: string;
  taskView?: string;
  taskViews?: string;
  logicalToday?: string;
  weekStart?: string;
  weekEnd?: string;
  projectIds?: string;
  includeCompleted?: boolean;
  includeCancelled?: boolean;
  includeShelved?: boolean;
  page?: number;
  limit?: number;
}

export interface TasksBootstrapContext {
  dayBoundary: TasksDayBoundary;
  logicalToday: string;
  heatmapStart: string;
  heatmapEnd: string;
  habitCheckInStart: string;
  habitCheckInEnd: string;
  habitCheckInMonths: number;
}

export interface TableVersionInfo {
  count: number;
  version: string | null;
  maxUpdatedAt: string | null;
}

type TaskPageView = 'standaloneTodos' | 'matrixWeek' | 'projectTrees';

const TASK_PAGE_VIEWS = new Set<TaskPageView>([
  'standaloneTodos',
  'matrixWeek',
  'projectTrees',
]);

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

function optionalNotPendingDelete(columns: Set<string>): string[] {
  return columns.has('sync_status') ? [`(sync_status IS NULL OR sync_status != 'pending_delete')`] : [];
}

function optionalNotDeleted(columns: Set<string>): string[] {
  return columns.has('deleted_at') ? ['deleted_at IS NULL'] : [];
}

function parseCsv(raw?: string): string[] {
  return raw?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
}

function parseTaskPageViews(params: TasksBootstrapParams): TaskPageView[] {
  const tokens = parseCsv(params.taskViews ?? params.taskView);
  if (tokens.length === 0) return [];
  if (tokens.includes('tasksPage')) return ['standaloneTodos', 'matrixWeek', 'projectTrees'];
  return tokens.filter((token): token is TaskPageView => TASK_PAGE_VIEWS.has(token as TaskPageView));
}

function addStatusFilters(
  where: string[],
  values: unknown[],
  columns: Set<string>,
  params: TasksBootstrapParams,
): void {
  if (!columns.has('status')) return;
  const excluded = new Set<string>();
  if (!params.includeCompleted) excluded.add('done');
  if (!params.includeCancelled) excluded.add('cancelled');
  if (params.includeShelved === false) excluded.add('shelved');
  if (excluded.size === 0) return;
  where.push(`(status IS NULL OR status NOT IN (${[...excluded].map(() => '?').join(', ')}))`);
  values.push(...excluded);
}

function buildDueDateWindowFilter(
  columns: Set<string>,
  startYmd: string,
  endYmd: string,
  includeNoDueDate: boolean,
): { sql: string; values: unknown[] } | null {
  if (!columns.has('due_date')) return null;
  const q = quoteIdent('due_date');
  const emptyDue = `(${q} IS NULL OR ${q} = '')`;
  const inWindow = `(LEFT(${q}, 10) BETWEEN ? AND ?)`;
  return {
    sql: includeNoDueDate ? `(${emptyDue} OR ${inWindow})` : inWindow,
    values: [startYmd, endYmd],
  };
}

function toCalendarTaskRow(row: Record<string, unknown>): CalendarTaskRow {
  return {
    id: String(row.id ?? ''),
    project_id: (row.project_id as string | null) ?? null,
    parent_task_id: (row.parent_task_id as string | null) ?? null,
    title: String(row.title ?? ''),
    status: String(row.status ?? ''),
    priority: Number(row.priority ?? 0),
    due_date: (row.due_date as string | null) ?? null,
    completed_at: (row.completed_at as string | null) ?? null,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
    extra_data: (row.extra_data as string | null) ?? null,
    frog_assigned_on: (row.frog_assigned_on as string | null) ?? null,
  };
}

function filterStandaloneTodosRows(
  rows: Record<string, unknown>[],
  context: TasksBootstrapContext,
  params: TasksBootstrapParams,
): Record<string, unknown>[] {
  let filtered = rows.filter((row) =>
    isStandaloneTodoVisibleOnDay(toCalendarTaskRow(row), context.logicalToday, context.dayBoundary),
  );
  if (params.includeShelved === false) {
    filtered = filtered.filter((row) => row.status !== 'shelved');
  }
  return sortStandaloneTodos(filtered);
}

async function loadFilteredTasks(params: TasksBootstrapParams, context: TasksBootstrapContext) {
  const views = parseTaskPageViews(params);
  if (views.length === 0) return null;

  const meta = await getTableMeta('tasks');
  const columns = new Set(meta.columns);
  const selectCols = meta.columns.map(quoteIdent).join(', ');
  const baseWhere = [...optionalNotDeleted(columns), ...optionalNotPendingDelete(columns)];
  const projectIds = parseCsv(params.projectIds);
  const byId = new Map<string, Record<string, unknown>>();
  const grouped: Record<TaskPageView, Record<string, unknown>[]> = {
    standaloneTodos: [],
    matrixWeek: [],
    projectTrees: [],
  };

  async function selectRows(where: string[], values: unknown[], orderBy = 'updated_at DESC') {
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT ${selectCols} FROM tasks ${whereSql} ORDER BY ${orderBy}`,
      values,
    );
    return rows.map((row) => row as Record<string, unknown>);
  }

  for (const view of views) {
    if (view === 'standaloneTodos') {
      const where = [...baseWhere, isBlankColumn('project_id'), isBlankColumn('parent_task_id')];
      const values: unknown[] = [];
      const rawRows = await selectRows(where, values);
      grouped.standaloneTodos = filterStandaloneTodosRows(rawRows, context, params);
    }

    if (view === 'matrixWeek') {
      const where = [...baseWhere, `(${isPresentColumn('project_id')} OR ${isPresentColumn('parent_task_id')})`];
      const values: unknown[] = [];
      addStatusFilters(where, values, columns, { ...params, includeCompleted: false, includeCancelled: false });
      const start = params.weekStart?.trim() && isValidYmd(params.weekStart) ? params.weekStart.trim() : context.logicalToday;
      const end = params.weekEnd?.trim() && isValidYmd(params.weekEnd) ? params.weekEnd.trim() : start;
      const due = buildDueDateWindowFilter(columns, start, end, false);
      if (due) {
        where.push(due.sql);
        values.push(...due.values);
      }
      grouped.matrixWeek = await selectRows(where, values);
    }

    if (view === 'projectTrees') {
      const where = [...baseWhere];
      const values: unknown[] = [];
      if (projectIds.length > 0) {
        where.push(`project_id IN (${projectIds.map(() => '?').join(', ')})`);
        values.push(...projectIds);
      } else {
        where.push(isPresentColumn('project_id'));
      }
      const roots = await selectRows(where, values);
      const treeById = new Map<string, Record<string, unknown>>();
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
        const children = await selectRows(childWhere, ids);
        for (const child of children) {
          const id = String(child.id);
          if (treeById.has(id)) continue;
          treeById.set(id, child);
          queue.push(child);
        }
      }
      grouped.projectTrees = [...treeById.values()];
    }
  }

  for (const rows of Object.values(grouped)) {
    for (const row of rows) {
      byId.set(String(row.id), row);
    }
  }

  const singleView = views.length === 1 ? views[0] : null;
  const allRows =
    singleView === 'standaloneTodos'
      ? grouped.standaloneTodos
      : [...byId.values()];
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(500, Math.max(1, params.limit ?? (allRows.length || 1)));
  const offset = (page - 1) * limit;

  return {
    unionRows: allRows.slice(offset, offset + limit),
    grouped,
    meta: {
      tasksScope: singleView ?? 'tasksPageFiltered',
      serverFiltered: true,
      filtersVersion: 'tasks-page-v1',
      taskViews: views,
      logicalToday: context.logicalToday,
      weekStart: params.weekStart,
      weekEnd: params.weekEnd,
      page,
      limit,
      total: allRows.length,
      totalPages: Math.ceil(allRows.length / limit),
    },
  };
}

function defaultInclude(): TasksBootstrapInclude {
  return {
    projects: true,
    projectCategories: true,
    tasks: true,
    taskCategories: true,
    taskItems: true,
    habits: true,
    habitContexts: true,
    habitCheckIns: true,
    taskExecutionEvents: true,
    frogCompletionEvents: true,
  };
}

export function parseTasksBootstrapInclude(raw?: string): TasksBootstrapInclude {
  const flags = defaultInclude();
  if (!raw?.trim()) return flags;

  const next = { ...flags };
  for (const key of Object.keys(next) as (keyof TasksBootstrapInclude)[]) {
    next[key] = false;
  }

  const tokens = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const token of tokens) {
    const normalized = INCLUDE_ALIASES[token] ?? INCLUDE_ALIASES[token.toLowerCase()];
    if (normalized === 'heatmap') {
      next.taskExecutionEvents = true;
      next.frogCompletionEvents = true;
      continue;
    }
    if (normalized) {
      next[normalized] = true;
    }
  }

  return next;
}

export function resolveTasksBootstrapContext(params: TasksBootstrapParams): TasksBootstrapContext {
  const dayBoundary: TasksDayBoundary = normalizeTasksDayBoundary({
    hour: params.dayBoundaryHour ?? 0,
    minute: params.dayBoundaryMinute ?? 0,
  });

  const { startYmd: heatmapStart, endYmd: heatmapEnd, logicalToday } = resolveHeatmapRange({
    heatmapStart: params.heatmapStart,
    heatmapEnd: params.heatmapEnd,
    dayBoundary,
  });

  const habitCheckInMonths = Number.isFinite(params.habitCheckInMonths)
    ? Math.max(1, Math.min(120, params.habitCheckInMonths!))
    : 24;

  const habitCheckInStart =
    params.habitCheckInStart?.trim() && isValidYmd(params.habitCheckInStart)
      ? params.habitCheckInStart.trim()
      : resolveHabitCheckInStartYmd(logicalToday, habitCheckInMonths);

  const habitCheckInEnd =
    params.habitCheckInEnd?.trim() && isValidYmd(params.habitCheckInEnd)
      ? params.habitCheckInEnd.trim()
      : logicalToday;

  const resolvedLogicalToday =
    params.logicalToday?.trim() && isValidYmd(params.logicalToday)
      ? params.logicalToday.trim()
      : logicalToday;

  return {
    dayBoundary,
    logicalToday: resolvedLogicalToday,
    heatmapStart,
    heatmapEnd,
    habitCheckInStart,
    habitCheckInEnd,
    habitCheckInMonths,
  };
}

export function getBootstrapListOptions(
  table: TasksBootstrapTable,
  context: TasksBootstrapContext,
): ListOptions {
  if (table === 'habit_check_ins') {
    return {
      startDate: context.habitCheckInStart,
      endDate: context.habitCheckInEnd,
    };
  }
  if (table === 'task_execution_events') {
    return resolveHeatmapEventCreatedAtBounds(
      context.heatmapStart,
      context.heatmapEnd,
      context.dayBoundary,
    );
  }
  if (table === 'frog_completion_events') {
    return {
      assignedYmdGte: context.heatmapStart,
      assignedYmdLte: context.heatmapEnd,
    };
  }
  return {};
}

async function loadTableVersions(
  tables: readonly TasksBootstrapTable[],
  context: TasksBootstrapContext,
): Promise<Record<string, TableVersionInfo>> {
  const entries = await Promise.all(
    tables.map(async (table) => {
      const snap = await getTableFilteredSnapshotMeta(table, getBootstrapListOptions(table, context));
      return [
        table,
        {
          count: snap.count,
          version: snap.version,
          maxUpdatedAt: snap.maxUpdatedAt,
        },
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export interface TasksBootstrapResult {
  projects: Record<string, unknown>[];
  projectCategories: Record<string, unknown>[];
  tasks: Record<string, unknown>[] | {
    standaloneTodos: Record<string, unknown>[];
    matrixWeek: Record<string, unknown>[];
    projectTreeTasks: Record<string, unknown>[];
  };
  taskCategories: Record<string, unknown>[];
  taskItems: Record<string, unknown>[];
  habits: Record<string, unknown>[];
  habitContexts: Record<string, unknown>[];
  habitCheckIns: Record<string, unknown>[];
  taskExecutionEvents: Record<string, unknown>[];
  frogCompletionEvents: Record<string, unknown>[];
  meta: {
    serverTime: string;
    logicalToday: string;
    heatmapStart: string;
    heatmapEnd: string;
    habitCheckInStart: string;
    habitCheckInEnd: string;
    completionHeatmapWeeks: number;
    tablesVersion: Record<string, TableVersionInfo>;
    tasksScope?: string;
    serverFiltered?: boolean;
    filtersVersion?: string;
    taskViews?: TaskPageView[];
    weekStart?: string;
    weekEnd?: string;
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
    snapshotAt?: string;
  };
}

export interface TasksSummaryResult {
  tables: Record<string, { count: number; version: string | null }>;
  meta: {
    serverTime: string;
    logicalToday: string;
    heatmapStart: string;
    heatmapEnd: string;
    habitCheckInStart: string;
    habitCheckInEnd: string;
    completionHeatmapWeeks: number;
  };
}

export async function getTasksPageSummary(params: TasksBootstrapParams): Promise<TasksSummaryResult> {
  const context = resolveTasksBootstrapContext(params);
  const versions = await loadTableVersions(TASKS_BOOTSTRAP_TABLES, context);

  const tables: Record<string, { count: number; version: string | null }> = {};
  for (const [table, info] of Object.entries(versions)) {
    tables[table] = { count: info.count, version: info.version };
  }

  return {
    tables,
    meta: {
      serverTime: new Date().toISOString(),
      logicalToday: context.logicalToday,
      heatmapStart: context.heatmapStart,
      heatmapEnd: context.heatmapEnd,
      habitCheckInStart: context.habitCheckInStart,
      habitCheckInEnd: context.habitCheckInEnd,
      completionHeatmapWeeks: COMPLETION_HEATMAP_WEEKS,
    },
  };
}

export async function getTasksPageBootstrap(
  params: TasksBootstrapParams,
): Promise<TasksBootstrapResult> {
  const context = resolveTasksBootstrapContext(params);
  const include = parseTasksBootstrapInclude(params.include);

  const loaders: Promise<void>[] = [];
  const result: TasksBootstrapResult = {
    projects: [],
    projectCategories: [],
    tasks: [],
    taskCategories: [],
    taskItems: [],
    habits: [],
    habitContexts: [],
    habitCheckIns: [],
    taskExecutionEvents: [],
    frogCompletionEvents: [],
    meta: {
      serverTime: new Date().toISOString(),
      logicalToday: context.logicalToday,
      heatmapStart: context.heatmapStart,
      heatmapEnd: context.heatmapEnd,
      habitCheckInStart: context.habitCheckInStart,
      habitCheckInEnd: context.habitCheckInEnd,
      completionHeatmapWeeks: COMPLETION_HEATMAP_WEEKS,
      tablesVersion: {},
    },
  };

  if (include.projects) {
    loaders.push(
      listAllRecords('projects').then((rows) => {
        result.projects = rows;
      }),
    );
  }
  if (include.projectCategories) {
    loaders.push(
      listAllRecords('project_categories').then((rows) => {
        result.projectCategories = rows;
      }),
    );
  }
  if (include.tasks) {
    loaders.push(
      loadFilteredTasks(params, context).then((filtered) => {
        if (!filtered) {
          return listAllRecords('tasks').then((rows) => {
            result.tasks = rows;
          });
        }
        result.tasks = filtered.unionRows;
        Object.assign(result.meta, filtered.meta, { snapshotAt: result.meta.serverTime });
      }),
    );
  }
  if (include.taskCategories) {
    loaders.push(
      listAllRecords('task_categories').then((rows) => {
        result.taskCategories = rows;
      }),
    );
  }
  if (include.taskItems) {
    loaders.push(
      listAllRecords('task_items').then((rows) => {
        result.taskItems = rows;
      }),
    );
  }
  if (include.habits) {
    loaders.push(
      listAllRecords('habits').then((rows) => {
        result.habits = rows;
      }),
    );
  }
  if (include.habitContexts) {
    loaders.push(
      listAllRecords('habit_contexts').then((rows) => {
        result.habitContexts = rows;
      }),
    );
  }
  if (include.habitCheckIns) {
    loaders.push(
      listAllRecords('habit_check_ins', getBootstrapListOptions('habit_check_ins', context)).then(
        (rows) => {
          result.habitCheckIns = rows;
        },
      ),
    );
  }
  if (include.taskExecutionEvents) {
    loaders.push(
      listAllRecords(
        'task_execution_events',
        getBootstrapListOptions('task_execution_events', context),
      ).then((rows) => {
        result.taskExecutionEvents = rows;
      }),
    );
  }
  if (include.frogCompletionEvents) {
    loaders.push(
      listAllRecords(
        'frog_completion_events',
        getBootstrapListOptions('frog_completion_events', context),
      ).then((rows) => {
        result.frogCompletionEvents = rows;
      }),
    );
  }

  await Promise.all(loaders);

  const versionTables: TasksBootstrapTable[] = [];
  if (include.projects) versionTables.push('projects');
  if (include.projectCategories) versionTables.push('project_categories');
  if (include.tasks) versionTables.push('tasks');
  if (include.taskCategories) versionTables.push('task_categories');
  if (include.taskItems) versionTables.push('task_items');
  if (include.habits) versionTables.push('habits');
  if (include.habitContexts) versionTables.push('habit_contexts');
  if (include.habitCheckIns) versionTables.push('habit_check_ins');
  if (include.taskExecutionEvents) versionTables.push('task_execution_events');
  if (include.frogCompletionEvents) versionTables.push('frog_completion_events');

  result.meta.tablesVersion = await loadTableVersions(versionTables, context);

  return result;
}
