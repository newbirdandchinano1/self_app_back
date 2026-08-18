import type { Request } from 'express';
import type { ProjectListParams } from '../../../services/pages/project-list.js';
import type { TaskListParams } from '../../../services/pages/task-list.js';
import type { TasksBootstrapParams } from '../../../services/pages/tasks-bootstrap.js';

export function parseBoolQuery(value: unknown): boolean | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}

export function parseIntQuery(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseStringQuery(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function parseTasksBootstrapParams(req: Request): TasksBootstrapParams {
  const dayBoundaryHour = parseIntQuery(req.query.dayBoundaryHour) ?? 0;
  const dayBoundaryMinute = parseIntQuery(req.query.dayBoundaryMinute) ?? 0;

  return {
    dayBoundaryHour,
    dayBoundaryMinute,
    heatmapStart: parseStringQuery(req.query.heatmapStart),
    heatmapEnd: parseStringQuery(req.query.heatmapEnd),
    habitCheckInStart: parseStringQuery(req.query.habitCheckInStart),
    habitCheckInEnd: parseStringQuery(req.query.habitCheckInEnd),
    habitCheckInMonths: parseIntQuery(req.query.habitCheckInMonths),
    include: parseStringQuery(req.query.include),
    taskView: parseStringQuery(req.query.taskView),
    taskViews: parseStringQuery(req.query.taskViews),
    logicalToday: parseStringQuery(req.query.logicalToday),
    weekStart: parseStringQuery(req.query.weekStart),
    weekEnd: parseStringQuery(req.query.weekEnd),
    projectIds: parseStringQuery(req.query.projectIds),
    includeCompleted: parseBoolQuery(req.query.includeCompleted),
    includeCancelled: parseBoolQuery(req.query.includeCancelled),
    includeShelved: parseBoolQuery(req.query.includeShelved),
    page: parseIntQuery(req.query.page),
    limit: parseIntQuery(req.query.limit),
  };
}

export function parseListFilterParams(req: Request): ProjectListParams & TaskListParams {
  return {
    categoryId: parseStringQuery(req.query.categoryId),
    categoryIds: parseStringQuery(req.query.categoryIds),
    uncategorized: parseBoolQuery(req.query.uncategorized),
    includeCompleted: parseBoolQuery(req.query.includeCompleted),
    includeCancelled: parseBoolQuery(req.query.includeCancelled),
    includeShelved: parseBoolQuery(req.query.includeShelved),
    page: parseIntQuery(req.query.page),
    limit: parseIntQuery(req.query.limit),
    updatedSince: parseStringQuery(req.query.updatedSince),
    projectId: parseStringQuery(req.query.projectId),
  };
}
