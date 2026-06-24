import { listAllRecords, getTableSnapshotMeta } from '../crud.js';
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
    tablesVersion: Record<string, { count: number; maxUpdatedAt: string | null }>;
  };
}

async function loadTableVersion(table: string) {
  const snap = await getTableSnapshotMeta(table);
  return { count: snap.count, maxUpdatedAt: snap.maxUpdatedAt };
}

export async function getTasksPageBootstrap(
  params: TasksBootstrapParams,
): Promise<TasksBootstrapResult> {
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
      logicalToday,
      heatmapStart,
      heatmapEnd,
      habitCheckInStart,
      habitCheckInEnd,
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
      listAllRecords('habit_check_ins', {
        startDate: habitCheckInStart,
        endDate: habitCheckInEnd,
      }).then((rows) => {
        result.habitCheckIns = rows;
      }),
    );
  }
  if (include.taskExecutionEvents) {
    loaders.push(
      listAllRecords('task_execution_events', {
        createdAtGte: heatmapStart,
        createdAtLte: heatmapEnd,
      }).then((rows) => {
        result.taskExecutionEvents = rows;
      }),
    );
  }
  if (include.frogCompletionEvents) {
    loaders.push(
      listAllRecords('frog_completion_events', {
        assignedYmdGte: heatmapStart,
        assignedYmdLte: heatmapEnd,
      }).then((rows) => {
        result.frogCompletionEvents = rows;
      }),
    );
  }

  await Promise.all(loaders);

  const versionTables = [
    ...FULL_TABLES,
    'habit_check_ins',
    'task_execution_events',
    'frog_completion_events',
  ] as const;

  const versions = await Promise.all(
    versionTables.map(async (table) => [table, await loadTableVersion(table)] as const),
  );
  result.meta.tablesVersion = Object.fromEntries(versions);

  return result;
}
