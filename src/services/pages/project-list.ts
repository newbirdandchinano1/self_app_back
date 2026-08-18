import { listAllRecords } from '../crud.js';
import { normalizeCatalogCategoryId } from './catalog-inbox-seed.js';
import {
  buildNestedTaskTree,
  countTaskTreeNodes,
  loadProjectTaskRowsWithStructure,
  parseCsv,
  resolveProjectListStatusFilters,
  sortProjects,
  type TaskRow,
  type TaskTreeNode,
} from './task-tree.js';

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

function resolveCategoryIds(params: ProjectListParams): string[] | null {
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
