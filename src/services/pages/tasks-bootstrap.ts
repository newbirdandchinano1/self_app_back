import {
  getTableFilteredSnapshotMeta,
  listAllRecords,
  type ListOptions,
} from '../crud.js';
import { normalizeTasksDayBoundary } from '../calendar/logical-day.js';
import type { TasksDayBoundary } from '../calendar/types.js';
import {
  COMPLETION_HEATMAP_WEEKS,
  resolveHeatmapRange,
  resolveHabitCheckInStartYmd,
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

  return {
    dayBoundary,
    logicalToday,
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
    return {
      createdAtGte: context.heatmapStart,
      createdAtLte: context.heatmapEnd,
    };
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
  tasks: Record<string, unknown>[];
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
      listAllRecords('tasks').then((rows) => {
        result.tasks = rows;
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
