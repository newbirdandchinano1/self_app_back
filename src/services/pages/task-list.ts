import type { RowDataPacket } from 'mysql2';
import { getTableMeta } from '../crud.js';
import { db } from '../../db/index.js';
import {
  formatRecordDateTimesForApi,
  normalizeDbDateTimeForTableStorage,
} from '../calendar/logical-day.js';
import {
  addStatusFilters,
  isBlankColumn,
  optionalNotDeleted,
  optionalNotPendingDelete,
  parseCsv,
} from './task-tree.js';

export interface TaskListParams {
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

export interface TaskListResult {
  list: Record<string, unknown>[];
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
  };
}

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function resolveCategoryIds(params: TaskListParams): string[] | null {
  const ids = parseCsv(params.categoryIds);
  if (ids.length > 0) return ids;
  if (params.categoryId?.trim()) return [params.categoryId.trim()];
  return null;
}

export async function getTaskList(params: TaskListParams): Promise<TaskListResult> {
  const meta = await getTableMeta('tasks');
  const columns = new Set(meta.columns);
  const selectCols = meta.columns.map(quoteIdent).join(', ');

  const where = [...optionalNotDeleted(columns), ...optionalNotPendingDelete(columns)];
  const values: unknown[] = [];

  addStatusFilters(where, values, columns, {
    includeCompleted: params.includeCompleted === true,
    includeCancelled: params.includeCancelled === true,
    includeShelved: params.includeShelved,
  });

  if (params.updatedSince?.trim()) {
    where.push('updated_at > ?');
    values.push(
      normalizeDbDateTimeForTableStorage('tasks', params.updatedSince.trim()) ??
        params.updatedSince.trim(),
    );
  }

  const categoryIds = resolveCategoryIds(params);
  if (params.uncategorized) {
    where.push(isBlankColumn('category_id'));
  } else if (categoryIds && categoryIds.length > 0) {
    where.push(`category_id IN (${categoryIds.map(() => '?').join(', ')})`);
    values.push(...categoryIds);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const [countRows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM tasks ${whereSql}`,
    values,
  );
  const total = Number(countRows[0]?.total ?? 0);

  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(500, Math.max(1, params.limit ?? 50));
  const offset = (page - 1) * limit;

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectCols} FROM tasks ${whereSql}
     ORDER BY sort_order ASC, priority DESC, updated_at DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset],
  );

  const list = rows.map((row) => formatRecordDateTimesForApi(row as Record<string, unknown>, 'tasks'));

  return {
    list,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
    meta: {
      serverTime: new Date().toISOString(),
      ...(params.categoryId?.trim() ? { categoryId: params.categoryId.trim() } : {}),
      ...(categoryIds ? { categoryIds } : {}),
      ...(params.uncategorized ? { uncategorized: true } : {}),
    },
  };
}
