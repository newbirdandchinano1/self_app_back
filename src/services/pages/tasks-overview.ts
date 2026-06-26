import type { RowDataPacket } from 'mysql2';
import { getTableMeta } from '../crud.js';
import { db } from '../../db/index.js';
import { getLogicalYmdFromCreatedAt, normalizeTasksDayBoundary } from '../calendar/logical-day.js';
import type { TasksDayBoundary } from '../calendar/types.js';
import { isValidYmd } from '../../utils/ymd.js';
import { resolveOverviewHeatmapRange } from './heatmap-range.js';
import type { TasksBootstrapParams } from './tasks-bootstrap.js';
import {
  isOverviewScopeEvent,
  overviewScopeEventSql,
  overviewScopeTaskSql,
} from './tasks-overview-scope.js';

export const TASKS_OVERVIEW_FILTERS_VERSION = 'tasks-overview-v1';

export type TasksOverviewStatKey =
  | 'open'
  | 'doneOrCancelled'
  | 'totalActive'
  | 'completedEvents'
  | 'reopenedEvents';

export interface TasksOverviewParams extends TasksBootstrapParams {
  eventsPage?: number;
  eventsLimit?: number;
  statKey?: string;
  statPage?: number;
  statLimit?: number;
  day?: string;
  includeDayDetail?: boolean;
}

export interface TaskOverviewEvent {
  id: string;
  task_id: string | null;
  action: string;
  created_at: string;
  task_title: string | null;
}

export interface PaginatedBlock<T> {
  list: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

type ScopedEventRow = TaskOverviewEvent & { logicalYmd: string };

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function clampPagination(page?: number, limit?: number, defaultLimit = 25) {
  const p = Math.max(1, page ?? 1);
  const l = Math.min(100, Math.max(1, limit ?? defaultLimit));
  return { page: p, limit: l, offset: (p - 1) * l };
}

function buildPagination<T>(list: T[], page: number, limit: number, total: number): PaginatedBlock<T> {
  return {
    list,
    page,
    limit,
    total,
    totalPages: total > 0 ? Math.ceil(total / limit) : 0,
  };
}

function eventLogicalYmd(createdAt: unknown, boundary: TasksDayBoundary): string | null {
  return getLogicalYmdFromCreatedAt(createdAt, boundary);
}

function formatEvent(row: Record<string, unknown>): TaskOverviewEvent {
  const taskIdRaw = row.task_id;
  return {
    id: String(row.id ?? ''),
    task_id: taskIdRaw == null || String(taskIdRaw).trim() === '' ? null : String(taskIdRaw),
    action: String(row.action ?? ''),
    created_at: String(row.created_at ?? ''),
    task_title: row.task_title == null ? null : String(row.task_title),
  };
}

function parseStatKey(raw?: string): TasksOverviewStatKey | undefined {
  const key = raw?.trim();
  if (
    key === 'open' ||
    key === 'doneOrCancelled' ||
    key === 'totalActive' ||
    key === 'completedEvents' ||
    key === 'reopenedEvents'
  ) {
    return key;
  }
  return undefined;
}

function resolveOverviewContext(params: TasksOverviewParams) {
  const dayBoundary: TasksDayBoundary = normalizeTasksDayBoundary({
    hour: params.dayBoundaryHour ?? 0,
    minute: params.dayBoundaryMinute ?? 0,
  });

  const { startYmd, endYmd, logicalToday } = resolveOverviewHeatmapRange({
    heatmapStart: params.heatmapStart,
    heatmapEnd: params.heatmapEnd,
    dayBoundary,
  });

  const resolvedLogicalToday =
    params.logicalToday?.trim() && isValidYmd(params.logicalToday)
      ? params.logicalToday.trim()
      : logicalToday;

  return {
    dayBoundary,
    logicalToday: resolvedLogicalToday,
    heatmapStart: startYmd,
    heatmapEnd: endYmd,
  };
}

async function loadScopeTaskIds(): Promise<Set<string>> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id FROM tasks WHERE ${overviewScopeTaskSql()}`,
  );
  return new Set(rows.map((r) => String(r.id ?? '')).filter(Boolean));
}

async function loadAllTaskIds(): Promise<Set<string>> {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT id FROM tasks`);
  return new Set(rows.map((r) => String(r.id ?? '')).filter(Boolean));
}

async function queryInsightTaskCounts(): Promise<{
  open: number;
  doneOrCancelled: number;
  totalActive: number;
}> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT
       SUM(CASE WHEN status NOT IN ('done', 'cancelled') THEN 1 ELSE 0 END) AS open_count,
       SUM(CASE WHEN status IN ('done', 'cancelled') THEN 1 ELSE 0 END) AS done_or_cancelled_count,
       COUNT(*) AS total_active
     FROM tasks
     WHERE ${overviewScopeTaskSql()}`,
  );
  const row = rows[0] ?? {};
  return {
    open: Number(row.open_count ?? 0),
    doneOrCancelled: Number(row.done_or_cancelled_count ?? 0),
    totalActive: Number(row.total_active ?? 0),
  };
}

async function queryInsightEventCounts(): Promise<{ completedEvents: number; reopenedEvents: number }> {
  const scopeSql = overviewScopeEventSql('tee');
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT
       SUM(CASE WHEN tee.action = 'completed' THEN 1 ELSE 0 END) AS completed_events,
       SUM(CASE WHEN tee.action = 'reopened' THEN 1 ELSE 0 END) AS reopened_events
     FROM task_execution_events tee
     WHERE tee.action IN ('completed', 'reopened')
       AND ${scopeSql}`,
  );
  const row = rows[0] ?? {};
  return {
    completedEvents: Number(row.completed_events ?? 0),
    reopenedEvents: Number(row.reopened_events ?? 0),
  };
}

async function loadScopedEvents(
  boundary: TasksDayBoundary,
  scopeTaskIds: Set<string>,
  allTaskIds: Set<string>,
): Promise<ScopedEventRow[]> {
  const scopeSql = overviewScopeEventSql('tee');
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT tee.id, tee.task_id, tee.action, tee.created_at, tee.task_title
     FROM task_execution_events tee
     WHERE tee.action IN ('completed', 'reopened')
       AND ${scopeSql}
     ORDER BY tee.created_at ASC`,
  );

  const out: ScopedEventRow[] = [];
  for (const row of rows) {
    const taskId = String(row.task_id ?? '').trim();
    if (!isOverviewScopeEvent(taskId, scopeTaskIds, allTaskIds)) continue;
    const logicalYmd = eventLogicalYmd(row.created_at, boundary);
    if (!logicalYmd) continue;
    out.push({
      ...formatEvent(row as Record<string, unknown>),
      logicalYmd,
    });
  }
  return out;
}

function aggregateNetCompleted(events: ScopedEventRow[]): {
  countsByDayAll: Record<string, number>;
  firstCompletedDay: string | null;
  netEventsByDay: Map<string, ScopedEventRow[]>;
} {
  const latestByKey = new Map<string, ScopedEventRow>();
  for (const event of events) {
    const taskId = event.task_id?.trim();
    if (!taskId) continue;
    const key = `${taskId}\0${event.logicalYmd}`;
    const existing = latestByKey.get(key);
    if (!existing || event.created_at > existing.created_at) {
      latestByKey.set(key, event);
    }
  }

  const countsByDayAll: Record<string, number> = {};
  const netEventsByDay = new Map<string, ScopedEventRow[]>();
  let firstCompletedDay: string | null = null;

  for (const latest of latestByKey.values()) {
    if (latest.action !== 'completed') continue;
    const ymd = latest.logicalYmd;
    countsByDayAll[ymd] = (countsByDayAll[ymd] ?? 0) + 1;
    const bucket = netEventsByDay.get(ymd) ?? [];
    bucket.push(latest);
    netEventsByDay.set(ymd, bucket);
    if (firstCompletedDay === null || ymd < firstCompletedDay) {
      firstCompletedDay = ymd;
    }
  }

  for (const [ymd, dayEvents] of netEventsByDay) {
    dayEvents.sort((a, b) => a.created_at.localeCompare(b.created_at));
    netEventsByDay.set(ymd, dayEvents);
  }

  return { countsByDayAll, firstCompletedDay, netEventsByDay };
}

function sliceCountsByDayRange(
  countsByDayAll: Record<string, number>,
  startYmd: string,
  endYmd: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [ymd, count] of Object.entries(countsByDayAll)) {
    if (ymd >= startYmd && ymd <= endYmd) {
      out[ymd] = count;
    }
  }
  return out;
}

async function queryRecentEvents(
  page: number,
  limit: number,
  offset: number,
): Promise<PaginatedBlock<TaskOverviewEvent>> {
  const scopeSql = overviewScopeEventSql('tee');
  const [countRows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total
     FROM task_execution_events tee
     WHERE tee.action IN ('completed', 'reopened')
       AND ${scopeSql}`,
  );
  const total = Number(countRows[0]?.total ?? 0);

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT tee.id, tee.task_id, tee.action, tee.created_at, tee.task_title
     FROM task_execution_events tee
     WHERE tee.action IN ('completed', 'reopened')
       AND ${scopeSql}
     ORDER BY tee.created_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );

  return buildPagination(
    rows.map((row) => formatEvent(row as Record<string, unknown>)),
    page,
    limit,
    total,
  );
}

async function queryStatDetailTasks(
  statKey: 'open' | 'doneOrCancelled' | 'totalActive',
  page: number,
  limit: number,
  offset: number,
): Promise<PaginatedBlock<Record<string, unknown>>> {
  const meta = await getTableMeta('tasks');
  const selectCols = meta.columns.map(quoteIdent).join(', ');
  const scopeSql = overviewScopeTaskSql();

  let statusFilter = '';
  if (statKey === 'open') {
    statusFilter = `AND (status IS NULL OR status NOT IN ('done', 'cancelled'))`;
  } else if (statKey === 'doneOrCancelled') {
    statusFilter = `AND status IN ('done', 'cancelled')`;
  }

  const [countRows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM tasks WHERE ${scopeSql} ${statusFilter}`,
  );
  const total = Number(countRows[0]?.total ?? 0);

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectCols} FROM tasks
     WHERE ${scopeSql} ${statusFilter}
     ORDER BY updated_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );

  return buildPagination(rows.map((row) => row as Record<string, unknown>), page, limit, total);
}

async function queryStatDetailEvents(
  action: 'completed' | 'reopened',
  page: number,
  limit: number,
  offset: number,
): Promise<PaginatedBlock<TaskOverviewEvent>> {
  const scopeSql = overviewScopeEventSql('tee');
  const [countRows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total
     FROM task_execution_events tee
     WHERE tee.action = ?
       AND ${scopeSql}`,
    [action],
  );
  const total = Number(countRows[0]?.total ?? 0);

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT tee.id, tee.task_id, tee.action, tee.created_at, tee.task_title
     FROM task_execution_events tee
     WHERE tee.action = ?
       AND ${scopeSql}
     ORDER BY tee.created_at DESC
     LIMIT ? OFFSET ?`,
    [action, limit, offset],
  );

  return buildPagination(
    rows.map((row) => formatEvent(row as Record<string, unknown>)),
    page,
    limit,
    total,
  );
}

export interface TasksOverviewResult {
  meta: {
    serverTime: string;
    logicalToday: string;
    heatmapStart: string;
    heatmapEnd: string;
    firstCompletedDay: string | null;
    filtersVersion: string;
  };
  insightCounts: {
    open: number;
    doneOrCancelled: number;
    totalActive: number;
    completedEvents: number;
    reopenedEvents: number;
  };
  countsByDay: Record<string, number>;
  recentEvents: PaginatedBlock<TaskOverviewEvent>;
  statDetail?: {
    statKey: TasksOverviewStatKey;
    mode: 'tasks' | 'events';
    tasks?: PaginatedBlock<Record<string, unknown>>;
    events?: PaginatedBlock<TaskOverviewEvent>;
  };
  dayDetail?: {
    ymd: string;
    netCompletedCount: number;
    events: TaskOverviewEvent[];
  };
}

export async function getTasksOverview(params: TasksOverviewParams): Promise<TasksOverviewResult> {
  const context = resolveOverviewContext(params);
  const eventsPagination = clampPagination(params.eventsPage, params.eventsLimit);
  const statPagination = clampPagination(params.statPage, params.statLimit);
  const statKey = parseStatKey(params.statKey);

  const [scopeTaskIds, allTaskIds, taskCounts, eventCounts, recentEvents] = await Promise.all([
    loadScopeTaskIds(),
    loadAllTaskIds(),
    queryInsightTaskCounts(),
    queryInsightEventCounts(),
    queryRecentEvents(eventsPagination.page, eventsPagination.limit, eventsPagination.offset),
  ]);

  const scopedEvents = await loadScopedEvents(context.dayBoundary, scopeTaskIds, allTaskIds);

  const { countsByDayAll, firstCompletedDay, netEventsByDay } = aggregateNetCompleted(scopedEvents);
  const countsByDay = sliceCountsByDayRange(
    countsByDayAll,
    context.heatmapStart,
    context.heatmapEnd,
  );

  const result: TasksOverviewResult = {
    meta: {
      serverTime: new Date().toISOString(),
      logicalToday: context.logicalToday,
      heatmapStart: context.heatmapStart,
      heatmapEnd: context.heatmapEnd,
      firstCompletedDay,
      filtersVersion: TASKS_OVERVIEW_FILTERS_VERSION,
    },
    insightCounts: {
      ...taskCounts,
      ...eventCounts,
    },
    countsByDay,
    recentEvents,
  };

  if (statKey) {
    if (statKey === 'open' || statKey === 'doneOrCancelled' || statKey === 'totalActive') {
      result.statDetail = {
        statKey,
        mode: 'tasks',
        tasks: await queryStatDetailTasks(
          statKey,
          statPagination.page,
          statPagination.limit,
          statPagination.offset,
        ),
      };
    } else {
      const action = statKey === 'completedEvents' ? 'completed' : 'reopened';
      result.statDetail = {
        statKey,
        mode: 'events',
        events: await queryStatDetailEvents(
          action,
          statPagination.page,
          statPagination.limit,
          statPagination.offset,
        ),
      };
    }
  }

  const detailDay = params.day?.trim();
  const wantDayDetail = params.includeDayDetail === true && detailDay && isValidYmd(detailDay);
  if (wantDayDetail) {
    const dayEvents = netEventsByDay.get(detailDay) ?? [];
    result.dayDetail = {
      ymd: detailDay,
      netCompletedCount: countsByDayAll[detailDay] ?? countsByDay[detailDay] ?? dayEvents.length,
      events: dayEvents.map(({ logicalYmd: _y, ...event }) => event),
    };
  }

  return result;
}
