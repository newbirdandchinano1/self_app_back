/**
 * 阶段 C：轻量 tasks bootstrap-v2。
 * 只返回 standaloneTodos、当前页项目+任务树、分类与版本；
 * 不返回热力图事件、全量 habits/check-ins、execution/frog events。
 * 可先于前端消费上线；不得假设旧大 bootstrap 已消失。
 */
import { createHash } from 'node:crypto';
import { tasksPageConfig } from '../../config/index.js';
import {
  bootstrapV2CacheKey,
  bootstrapV2CacheOpts,
  cachedGetOrSet,
  type CacheHitKind,
} from '../../cache/index.js';
import { getTasksCatalog } from './tasks-catalog.js';
import {
  getProjectList,
  type ProjectListItem,
  type ProjectListPagination,
  type ProjectListParams,
} from './tasks-list.js';
import {
  getTasksPageBootstrap,
  resolveTasksBootstrapContext,
  TasksBootstrapError,
  type TasksBootstrapParams,
  type TableVersionInfo,
} from './tasks-bootstrap.js';

export const TASKS_BOOTSTRAP_V2_VERSION = 'tasks-bootstrap-v2';

export type TasksBootstrapV2Params = TasksBootstrapParams & ProjectListParams;

export type TasksBootstrapV2Result = {
  standaloneTodos: Record<string, unknown>[];
  projects: ProjectListItem[];
  projectCategories: Record<string, unknown>[];
  taskCategories: Record<string, unknown>[];
  meta: {
    apiVersion: typeof TASKS_BOOTSTRAP_V2_VERSION;
    serverTime: string;
    snapshotAt: string;
    logicalToday: string;
    dayBoundary: { hour: number; minute: number };
    tablesVersion: Record<string, TableVersionInfo>;
    projectsPagination: ProjectListPagination;
    standaloneTodos: {
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };
    cache: CacheHitKind;
    /** 明确声明未包含的大包字段，避免客户端误用 */
    excluded: readonly [
      'habits',
      'habitCheckIns',
      'habitContexts',
      'taskExecutionEvents',
      'frogCompletionEvents',
      'heatmap',
      'pointsWallet',
    ];
  };
};

const EXCLUDED = [
  'habits',
  'habitCheckIns',
  'habitContexts',
  'taskExecutionEvents',
  'frogCompletionEvents',
  'heatmap',
  'pointsWallet',
] as const;

export function assertBootstrapV2Enabled(): void {
  if (!tasksPageConfig.bootstrapV2Enabled) {
    throw new TasksBootstrapError(
      'bootstrap-v2 未启用：设置 TASKS_BOOTSTRAP_V2_ENABLED=true 后可用。旧 /pages/tasks 大包仍受 B1 闸门约束，二者独立。',
      404,
    );
  }
}

/** 稳定 query 指纹：同身份同 query → single-flight / 短窗缓存 */
export function fingerprintBootstrapV2Query(params: TasksBootstrapV2Params): string {
  const payload = {
    dayBoundaryHour: params.dayBoundaryHour ?? 0,
    dayBoundaryMinute: params.dayBoundaryMinute ?? 0,
    logicalToday: params.logicalToday?.trim() || '',
    categoryId: params.categoryId?.trim() || '',
    categoryIds: params.categoryIds?.trim() || '',
    uncategorized: params.uncategorized === true,
    projectId: params.projectId?.trim() || '',
    includeCompleted: params.includeCompleted !== false,
    includeCancelled: params.includeCancelled !== false,
    includeShelved: params.includeShelved !== false,
    page: params.page ?? 1,
    limit: params.limit ?? 200,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
}

async function loadBootstrapV2Uncached(
  params: TasksBootstrapV2Params,
): Promise<Omit<TasksBootstrapV2Result, 'meta'> & { meta: Omit<TasksBootstrapV2Result['meta'], 'cache'> }> {
  const context = resolveTasksBootstrapContext(params);
  const snapshotAt = new Date().toISOString();

  const projectParams: ProjectListParams = {
    categoryId: params.categoryId,
    categoryIds: params.categoryIds,
    uncategorized: params.uncategorized,
    projectId: params.projectId,
    includeCompleted: params.includeCompleted,
    includeCancelled: params.includeCancelled,
    includeShelved: params.includeShelved,
    page: params.page,
    limit: params.limit,
  };

  const standaloneParams: TasksBootstrapParams = {
    ...params,
    taskView: 'standaloneTodos',
    taskViews: undefined,
    include: undefined,
  };

  // 并行有限查询：catalog（分类+版本）+ 独立待办 + 当前页项目树
  const [catalog, standalone, projectList] = await Promise.all([
    getTasksCatalog({}),
    getTasksPageBootstrap(standaloneParams),
    getProjectList(projectParams),
  ]);

  const standaloneRows = Array.isArray(standalone.tasks) ? standalone.tasks : [];
  const tablesVersion: Record<string, TableVersionInfo> = {
    ...catalog.meta.tablesVersion,
  };
  if (standalone.meta.tablesVersion?.tasks) {
    tablesVersion.tasks = standalone.meta.tablesVersion.tasks;
  }

  return {
    standaloneTodos: standaloneRows,
    projects: projectList.list,
    projectCategories: catalog.projectCategories,
    taskCategories: catalog.taskCategories,
    meta: {
      apiVersion: TASKS_BOOTSTRAP_V2_VERSION,
      serverTime: snapshotAt,
      snapshotAt,
      logicalToday: context.logicalToday,
      dayBoundary: { ...context.dayBoundary },
      tablesVersion,
      projectsPagination: projectList.pagination,
      standaloneTodos: {
        total: standalone.meta.total ?? standaloneRows.length,
        page: standalone.meta.page ?? 1,
        limit: standalone.meta.limit ?? standaloneRows.length,
        totalPages: standalone.meta.totalPages ?? 1,
      },
      excluded: EXCLUDED,
    },
  };
}

export async function getTasksBootstrapV2(
  params: TasksBootstrapV2Params,
): Promise<TasksBootstrapV2Result> {
  assertBootstrapV2Enabled();

  const fingerprint = fingerprintBootstrapV2Query(params);
  const key = bootstrapV2CacheKey(fingerprint);
  const { value, kind } = await cachedGetOrSet(
    key,
    () => loadBootstrapV2Uncached(params),
    bootstrapV2CacheOpts(),
  );

  return {
    ...value,
    meta: {
      ...value.meta,
      cache: kind,
    },
  };
}
