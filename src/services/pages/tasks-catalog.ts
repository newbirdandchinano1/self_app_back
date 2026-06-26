import { getTableFilteredSnapshotMeta, listAllRecords, type ListOptions } from '../crud.js';
import { ensureInboxCatalogSeed, INBOX_PROJECT_CATEGORY_ID } from './catalog-inbox-seed.js';

const CATALOG_TABLES = ['projects', 'project_categories', 'task_categories'] as const;

const TABLE_ROWS_KEYS = [
  ['project_categories', 'projectCategories'],
  ['projects', 'projects'],
  ['task_categories', 'taskCategories'],
] as const;

export class CatalogIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogIntegrityError';
  }
}

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
    syncMode: 'full' | 'delta';
    catalogComplete: boolean;
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

/** tablesVersion.count 始终为全表总行数，不受 updatedSince 影响 */
async function loadTableVersions(): Promise<Record<string, TableVersionInfo>> {
  const entries = await Promise.all(
    CATALOG_TABLES.map(async (table) => {
      const snap = await getTableFilteredSnapshotMeta(table);
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

function assertCatalogIntegrity(payload: TasksCatalogResult, mode: 'full' | 'delta'): void {
  if (mode === 'full') {
    for (const [tableKey, rowsKey] of TABLE_ROWS_KEYS) {
      const expected = payload.meta.tablesVersion[tableKey]?.count;
      const actual = payload[rowsKey].length;
      if (expected != null && actual !== expected) {
        throw new CatalogIntegrityError(`${tableKey}: rows=${actual}, count=${expected}`);
      }
    }

    const categoryIds = new Set(payload.projectCategories.map((c) => String(c.id)));
    if (!categoryIds.has(INBOX_PROJECT_CATEGORY_ID)) {
      throw new CatalogIntegrityError('missing inbox category');
    }

    for (const project of payload.projects) {
      const categoryId = project.category_id;
      if (
        categoryId &&
        String(categoryId) !== INBOX_PROJECT_CATEGORY_ID &&
        !categoryIds.has(String(categoryId))
      ) {
        throw new CatalogIntegrityError(`orphan project.category_id=${categoryId}`);
      }
    }
  }
}

export async function getTasksCatalog(params: TasksCatalogParams): Promise<TasksCatalogResult> {
  await ensureInboxCatalogSeed();

  const isDelta = Boolean(params.updatedSince?.trim());
  const listOptions: ListOptions = isDelta ? { updatedSince: params.updatedSince!.trim() } : {};

  const [projects, projectCategories, taskCategories, tablesVersion] = await Promise.all([
    listAllRecords('projects', listOptions),
    listAllRecords('project_categories', listOptions),
    listAllRecords('task_categories', listOptions),
    loadTableVersions(),
  ]);

  const payload: TasksCatalogResult = {
    projects: sortProjects(projects),
    projectCategories: sortBySortOrderThenName(projectCategories),
    taskCategories: sortBySortOrderThenName(taskCategories),
    meta: {
      serverTime: new Date().toISOString(),
      syncMode: isDelta ? 'delta' : 'full',
      catalogComplete: true,
      tablesVersion,
    },
  };

  assertCatalogIntegrity(payload, isDelta ? 'delta' : 'full');

  return payload;
}
