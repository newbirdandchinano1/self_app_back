import { getTableFilteredSnapshotMeta, listAllRecords, type ListOptions } from '../crud.js';

const CATALOG_TABLES = ['projects', 'project_categories', 'task_categories'] as const;

export interface TasksCatalogParams {
  updatedSince?: string;
}

export interface TableVersionInfo {
  count: number;
  version: string | null;
  maxUpdatedAt: string | null;
}

export interface TasksCatalogResult {
  projects: Record<string, unknown>[];
  projectCategories: Record<string, unknown>[];
  taskCategories: Record<string, unknown>[];
  meta: {
    serverTime: string;
    tablesVersion: Record<string, TableVersionInfo>;
  };
}

function sortBySortOrderThenName(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((a, b) => {
    const aOrder = Number(a.sort_order ?? 1000);
    const bOrder = Number(b.sort_order ?? 1000);
    if (aOrder !== bOrder) return aOrder - bOrder;
    return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh-CN');
  });
}

function sortProjects(rows: Record<string, unknown>[]): Record<string, unknown>[] {
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

async function loadTableVersions(
  listOptions: ListOptions,
): Promise<Record<string, TableVersionInfo>> {
  const entries = await Promise.all(
    CATALOG_TABLES.map(async (table) => {
      const snap = await getTableFilteredSnapshotMeta(table, listOptions);
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

export async function getTasksCatalog(params: TasksCatalogParams): Promise<TasksCatalogResult> {
  const listOptions: ListOptions = params.updatedSince
    ? { updatedSince: params.updatedSince }
    : {};

  const [projects, projectCategories, taskCategories, tablesVersion] = await Promise.all([
    listAllRecords('projects', listOptions),
    listAllRecords('project_categories', listOptions),
    listAllRecords('task_categories', listOptions),
    loadTableVersions(listOptions),
  ]);

  return {
    projects: sortProjects(projects),
    projectCategories: sortBySortOrderThenName(projectCategories),
    taskCategories: sortBySortOrderThenName(taskCategories),
    meta: {
      serverTime: new Date().toISOString(),
      tablesVersion,
    },
  };
}
