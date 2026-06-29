import { listAllRecords } from '../crud.js';
import {
  buildNestedTaskTree,
  loadProjectTaskRowsWithStructure,
  parseCsv,
  resolveProjectListStatusFilters,
  sortProjects,
  type TaskTreeNode,
} from './task-tree.js';

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
}

export type ProjectListItem = Record<string, unknown> & {
  tasks: TaskTreeNode[];
};

export interface ProjectListResult {
  list: ProjectListItem[];
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

function resolveCategoryIds(params: ProjectListParams): string[] | null {
  const ids = parseCsv(params.categoryIds);
  if (ids.length > 0) return ids;
  if (params.categoryId?.trim()) return [params.categoryId.trim()];
  return null;
}

async function loadFilteredProjects(params: ProjectListParams): Promise<Record<string, unknown>[]> {
  const listOptions = params.updatedSince ? { updatedSince: params.updatedSince } : {};
  let projects = await listAllRecords('projects', listOptions);
  projects = sortProjects(projects);

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

export async function getProjectList(params: ProjectListParams): Promise<ProjectListResult> {
  const allProjects = await loadFilteredProjects(params);
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(200, Math.max(1, params.limit ?? 50));
  const offset = (page - 1) * limit;
  const pageProjects = allProjects.slice(offset, offset + limit);
  const projectIds = pageProjects.map((row) => String(row.id)).filter(Boolean);

  const statusFilters = resolveProjectListStatusFilters(params);

  const taskLoad = await loadProjectTaskRowsWithStructure(projectIds, statusFilters);

  const list: ProjectListItem[] = pageProjects.map((project) => {
    const projectId = String(project.id);
    return {
      ...project,
      tasks: buildNestedTaskTree(taskLoad.filtered, projectId, taskLoad.structuralById),
    };
  });

  const categoryIds = resolveCategoryIds(params);

  return {
    list,
    pagination: {
      page,
      limit,
      total: allProjects.length,
      totalPages: Math.ceil(allProjects.length / limit),
    },
    meta: {
      serverTime: new Date().toISOString(),
      includeCompleted: statusFilters.includeCompleted,
      includeCancelled: statusFilters.includeCancelled,
      includeShelved: statusFilters.includeShelved,
      ...(params.categoryId?.trim() ? { categoryId: params.categoryId.trim() } : {}),
      ...(categoryIds ? { categoryIds } : {}),
      ...(params.uncategorized ? { uncategorized: true } : {}),
    },
  };
}
