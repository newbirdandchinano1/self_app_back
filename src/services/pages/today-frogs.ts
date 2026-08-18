import type { RowDataPacket } from 'mysql2';
import { getTableMeta } from '../crud.js';
import { db } from '../../db/index.js';
import { isFrogAssignedOn } from '../calendar/aggregation.js';
import { formatRecordDateTimesForApi } from '../calendar/logical-day.js';
import {
  optionalNotDeleted,
  optionalNotPendingDelete,
} from './task-tree.js';
import {
  resolveTasksBootstrapContext,
  TASKS_PAGE_FILTERS_VERSION,
  type TasksBootstrapParams,
} from './tasks-bootstrap.js';

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function parseExtraData(extraData: unknown): {
  frogAssignedOn?: string;
  frogSessionCompletedOn?: string;
} {
  if (extraData == null || extraData === '') return {};
  try {
    return typeof extraData === 'string'
      ? (JSON.parse(extraData) as { frogAssignedOn?: string; frogSessionCompletedOn?: string })
      : (extraData as { frogAssignedOn?: string; frogSessionCompletedOn?: string });
  } catch {
    return {};
  }
}

export function isFrogDoneForToday(
  task: Record<string, unknown>,
  logicalToday: string,
): boolean {
  const status = String(task.status ?? '');
  if (status === 'done' || status === 'cancelled') return true;
  const extra = parseExtraData(task.extra_data);
  if (extra.frogSessionCompletedOn === logicalToday) return true;
  return false;
}

export function sortTodayFrogTasks(
  tasks: Record<string, unknown>[],
  logicalToday: string,
): Record<string, unknown>[] {
  return [...tasks].sort((a, b) => {
    const aDone = isFrogDoneForToday(a, logicalToday);
    const bDone = isFrogDoneForToday(b, logicalToday);
    if (aDone !== bDone) return aDone ? 1 : -1;

    const aPri = Number(a.priority ?? 0);
    const bPri = Number(b.priority ?? 0);
    if (aPri !== bPri) return bPri - aPri;

    return String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''));
  });
}

export interface TodayFrogsResult {
  logicalToday: string;
  count: number;
  tasks: Record<string, unknown>[];
  projectFrogs: Record<string, unknown>[];
  projectFrogIds: string[];
  meta: {
    serverFiltered: true;
    filtersVersion: string;
    serverTime: string;
  };
}

async function loadFrogCandidates(
  table: 'tasks' | 'projects',
  logicalToday: string,
): Promise<Record<string, unknown>[]> {
  const meta = await getTableMeta(table);
  const columns = new Set(meta.columns);
  const selectCols = meta.columns.map(quoteIdent).join(', ');
  const where = [...optionalNotDeleted(columns), ...optionalNotPendingDelete(columns)];
  const values: unknown[] = [];

  const jsonOn = `JSON_UNQUOTE(JSON_EXTRACT(extra_data, '$.frogAssignedOn'))`;
  const jsonDates = `JSON_EXTRACT(extra_data, '$.frogAssignedDates')`;
  const jsonValid = `(extra_data IS NOT NULL AND extra_data != '' AND JSON_VALID(extra_data))`;
  const parts = [
    `(${jsonValid} AND ${jsonOn} = ?)`,
    `(${jsonValid} AND JSON_CONTAINS(${jsonDates}, JSON_QUOTE(?)))`,
  ];
  values.push(logicalToday, logicalToday);

  if (columns.has('frog_assigned_on')) {
    parts.unshift('frog_assigned_on = ?');
    values.unshift(logicalToday);
  }

  where.push(`(${parts.join(' OR ')})`);

  if (table === 'projects' && columns.has('status')) {
    where.push(`(status IS NULL OR status != 'archived')`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectCols} FROM ${quoteIdent(table)} ${whereSql}`,
    values,
  );

  return rows
    .map((row) => formatRecordDateTimesForApi(row as Record<string, unknown>, table))
    .filter((row) =>
      isFrogAssignedOn(
        row.extra_data,
        logicalToday,
        columns.has('frog_assigned_on') ? String(row.frog_assigned_on ?? '') : null,
      ),
    );
}

export async function getTodayFrogTasks(params: TasksBootstrapParams): Promise<TodayFrogsResult> {
  const context = resolveTasksBootstrapContext(params);
  const logicalToday = context.logicalToday;

  const [taskRows, projectRows] = await Promise.all([
    loadFrogCandidates('tasks', logicalToday),
    loadFrogCandidates('projects', logicalToday),
  ]);

  const projectFrogs = sortTodayFrogTasks(projectRows, logicalToday);
  const projectFrogIds = projectFrogs.map((row) => String(row.id ?? '')).filter(Boolean);
  const projectIdSet = new Set(projectFrogIds);

  // 任务 id 与项目 id 碰撞时，项目青蛙优先
  const tasks = sortTodayFrogTasks(
    taskRows.filter((row) => !projectIdSet.has(String(row.id ?? ''))),
    logicalToday,
  );

  return {
    logicalToday,
    count: tasks.length + projectFrogs.length,
    tasks,
    projectFrogs,
    projectFrogIds,
    meta: {
      serverFiltered: true,
      filtersVersion: TASKS_PAGE_FILTERS_VERSION,
      serverTime: new Date().toISOString(),
    },
  };
}
