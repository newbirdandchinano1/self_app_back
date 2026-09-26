import type { RowDataPacket } from 'mysql2';
import { getTableMeta } from '../crud.js';
import { db } from '../../db/index.js';
import {
  addDaysToLogicalYmd,
  compareTaskAuditDatetime,
  getLogicalYmdFromCreatedAt,
  normalizeTasksDayBoundary,
  formatDbDateTimeForApi,
  formatRecordDateTimesForApi,
} from '../calendar/logical-day.js';
import { taskHasRepeatingSchedule } from '../calendar/aggregation.js';
import type { TasksDayBoundary } from '../calendar/types.js';
import { isValidYmd } from '../../utils/ymd.js';
import {
  COMPLETION_HEATMAP_WEEKS,
  resolveHeatmapRange,
  resolveOverviewHeatmapRange,
} from '../calendar/heatmap-range.js';
import {
  excludeTodosAlreadyCountedAsFrogs,
  filterNetCompletedEvents,
} from '../calendar/net-completion.js';
import {
  resolveTasksBootstrapContext,
  type TasksBootstrapParams,
} from './tasks-bootstrap.js';

/** 独立待办（Overview Scope）过滤条件，与 APP `TASK_OVERVIEW_SCOPE_WHERE` 一致 */
export const OVERVIEW_SCOPE_TASK_WHERE = `(project_id IS NULL OR TRIM(project_id) = '')
  AND (parent_task_id IS NULL OR TRIM(parent_task_id) = '')`;

export function overviewScopeTaskSql(alias = ''): string {
  const p = alias ? `${alias}.project_id` : 'project_id';
  const pt = alias ? `${alias}.parent_task_id` : 'parent_task_id';
  return `(${p} IS NULL OR TRIM(${p}) = '') AND (${pt} IS NULL OR TRIM(${pt}) = '')`;
}

/** 事件是否属于 overview scope（含已删独立待办的事件快照） */
export function isOverviewScopeEvent(
  taskId: string,
  scopeTaskIds: Set<string>,
  allTaskIds: Set<string>,
): boolean {
  const id = taskId.trim();
  if (!id) return false;
  if (scopeTaskIds.has(id)) return true;
  return !allTaskIds.has(id);
}

export function overviewScopeEventSql(teeAlias = 'tee'): string {
  const tScope = overviewScopeTaskSql('t');
  return `(
    EXISTS (
      SELECT 1 FROM tasks t
      WHERE t.id = ${teeAlias}.task_id
      AND ${tScope}
    )
    OR (
      ${teeAlias}.task_id IS NOT NULL AND TRIM(${teeAlias}.task_id) != ''
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = ${teeAlias}.task_id)
    )
  )`;
}

export const TASKS_OVERVIEW_FILTERS_VERSION = 'tasks-overview-v2';

export type TasksOverviewStatKey =
  | 'open'
  | 'doneOrCancelled'
  | 'totalActive'
  | 'recurring'
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
  const createdAtRaw = row.created_at;
  return {
    id: String(row.id ?? ''),
    task_id: taskIdRaw == null || String(taskIdRaw).trim() === '' ? null : String(taskIdRaw),
    action: String(row.action ?? ''),
    created_at: formatDbDateTimeForApi(createdAtRaw) ?? String(createdAtRaw ?? ''),
    task_title: row.task_title == null ? null : String(row.task_title),
  };
}

function parseStatKey(raw?: string): TasksOverviewStatKey | undefined {
  const key = raw?.trim();
  if (
    key === 'open' ||
    key === 'doneOrCancelled' ||
    key === 'totalActive' ||
    key === 'recurring' ||
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

async function loadRepeatingScopeTaskIds(): Promise<Set<string>> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, extra_data FROM tasks WHERE ${overviewScopeTaskSql()}`,
  );
  const ids = new Set<string>();
  for (const row of rows) {
    const id = String(row.id ?? '').trim();
    if (!id) continue;
    const extra = row.extra_data == null ? null : String(row.extra_data);
    if (taskHasRepeatingSchedule(extra)) ids.add(id);
  }
  return ids;
}

async function loadAllTaskIds(): Promise<Set<string>> {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT id FROM tasks`);
  return new Set(rows.map((r) => String(r.id ?? '')).filter(Boolean));
}

async function queryInsightTaskCounts(): Promise<{
  open: number;
  doneOrCancelled: number;
  totalActive: number;
  recurring: number;
}> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, status, extra_data FROM tasks WHERE ${overviewScopeTaskSql()}`,
  );
  let open = 0;
  let doneOrCancelled = 0;
  let recurring = 0;
  for (const row of rows) {
    const status = String(row.status ?? '');
    if (status === 'done' || status === 'cancelled') doneOrCancelled += 1;
    else open += 1;
    const extra = row.extra_data == null ? null : String(row.extra_data);
    if (taskHasRepeatingSchedule(extra)) recurring += 1;
  }
  return {
    open,
    doneOrCancelled,
    totalActive: rows.length,
    recurring,
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

function aggregateNetCompleted(
  events: ScopedEventRow[],
  repeatingTaskIds: Set<string>,
): {
  countsByDayAll: Record<string, number>;
  firstCompletedDay: string | null;
  netEventsByDay: Map<string, ScopedEventRow[]>;
} {
  const netEvents = filterNetCompletedEvents(
    events
      .map((event) => ({
        ...event,
        task_id: event.task_id?.trim() ?? '',
      }))
      .filter((event) => event.task_id),
    repeatingTaskIds,
  );

  const countsByDayAll: Record<string, number> = {};
  const netEventsByDay = new Map<string, ScopedEventRow[]>();
  let firstCompletedDay: string | null = null;

  for (const latest of netEvents) {
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
  statKey: 'open' | 'doneOrCancelled' | 'totalActive' | 'recurring',
  page: number,
  limit: number,
  offset: number,
): Promise<PaginatedBlock<Record<string, unknown>>> {
  const meta = await getTableMeta('tasks');
  const selectCols = meta.columns.map(quoteIdent).join(', ');
  const scopeSql = overviewScopeTaskSql();

  if (statKey === 'recurring') {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT ${selectCols} FROM tasks WHERE ${scopeSql} ORDER BY updated_at DESC`,
    );
    const filtered = rows.filter((row) =>
      taskHasRepeatingSchedule(row.extra_data == null ? null : String(row.extra_data)),
    );
    const total = filtered.length;
    return buildPagination(
      filtered.slice(offset, offset + limit).map((row) =>
        formatRecordDateTimesForApi(row as Record<string, unknown>),
      ),
      page,
      limit,
      total,
    );
  }

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

  return buildPagination(
    rows.map((row) => formatRecordDateTimesForApi(row as Record<string, unknown>)),
    page,
    limit,
    total,
  );
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
    recurring: number;
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

  const [scopeTaskIds, allTaskIds, repeatingTaskIds, taskCounts, eventCounts, recentEvents] =
    await Promise.all([
      loadScopeTaskIds(),
      loadAllTaskIds(),
      loadRepeatingScopeTaskIds(),
      queryInsightTaskCounts(),
      queryInsightEventCounts(),
      queryRecentEvents(eventsPagination.page, eventsPagination.limit, eventsPagination.offset),
    ]);

  const scopedEvents = await loadScopedEvents(context.dayBoundary, scopeTaskIds, allTaskIds);

  const { countsByDayAll, firstCompletedDay, netEventsByDay } = aggregateNetCompleted(
    scopedEvents,
    repeatingTaskIds,
  );
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
    if (
      statKey === 'open' ||
      statKey === 'doneOrCancelled' ||
      statKey === 'totalActive' ||
      statKey === 'recurring'
    ) {
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

export interface DayCount {
  frogs: number;
  todos: number;
  total: number;
}

export type CompletionHeatmapFrogSubject = 'task' | 'project';

export interface CompletionHeatmapDayDetail {
  ymd: string;
  /** task_id 为青蛙主体：任务 id 或项目 id；主体已删时仍返回，标题优先快照 */
  frogs: Array<{
    task_id: string;
    task_title: string;
    subject?: CompletionHeatmapFrogSubject;
  }>;
  todos: Array<{ id: string; task_id: string; task_title: string; title: string }>;
}

export interface CompletionHeatmapResult {
  meta: {
    logicalToday: string;
    heatmapStart: string;
    heatmapEnd: string;
    completionHeatmapWeeks: number;
    serverTime: string;
    todoNetCompleted: true;
  };
  countsByDay: Record<string, DayCount>;
  dayDetail?: CompletionHeatmapDayDetail;
}

function normalizeAction(raw: unknown): string {
  return String(raw ?? '').trim();
}

/** 与日历聚合一致：取 YYYY-MM-DD，兼容误写入的 datetime / ISO 前缀 */
function normalizeAssignedYmd(raw: unknown): string {
  const ymd = String(raw ?? '')
    .trim()
    .slice(0, 10);
  return isValidYmd(ymd) ? ymd : '';
}

type FrogLatest = {
  id: string;
  task_id: string;
  action: string;
  created_at: string;
  task_title: string;
};

/**
 * 青蛙净完成：按 (task_id, assigned_ymd) 取最新事件；
 * 此处 task_id 可能是 tasks.id，也可能是 projects.id（项目青蛙）。
 * task_id 为空时退化为 (id, assigned_ymd)。仅最新为 completed 计入。
 * 禁止要求主体必须存在于 tasks。
 */
export function aggregateFrogEvents(
  events: Record<string, unknown>[],
  startYmd: string,
  endYmd: string,
): {
  countsByDay: Record<string, number>;
  latestByKey: Map<string, FrogLatest>;
  taskIdsByDay: Map<string, Set<string>>;
} {
  const latestByKey = new Map<string, FrogLatest>();
  for (const event of events) {
    const assignedYmd = normalizeAssignedYmd(event.assigned_ymd);
    if (!assignedYmd) continue;

    const eventId = String(event.id ?? '').trim();
    const taskIdRaw = String(event.task_id ?? '').trim();
    // 无 task_id 时用事件 id 分组，避免整行被丢弃
    const groupId = taskIdRaw || eventId;
    if (!groupId) continue;

    const createdAt = String(event.created_at ?? '');
    const key = `${groupId}\0${assignedYmd}`;
    const candidate: FrogLatest = {
      id: eventId,
      task_id: groupId,
      action: normalizeAction(event.action),
      created_at: createdAt,
      task_title: String(event.task_title ?? '').trim(),
    };
    const existing = latestByKey.get(key);
    if (!existing) {
      latestByKey.set(key, candidate);
      continue;
    }
    const cmp = compareTaskAuditDatetime(candidate.created_at, existing.created_at);
    if (cmp > 0 || (cmp === 0 && candidate.id > existing.id)) {
      latestByKey.set(key, candidate);
    }
  }

  const countsByDay: Record<string, number> = {};
  const taskIdsByDay = new Map<string, Set<string>>();
  for (const [key, latest] of latestByKey) {
    if (latest.action !== 'completed') continue;
    const [taskId, assignedYmd] = key.split('\0');
    if (!taskId || !assignedYmd) continue;
    if (assignedYmd < startYmd || assignedYmd > endYmd) continue;
    countsByDay[assignedYmd] = (countsByDay[assignedYmd] ?? 0) + 1;
    const bucket = taskIdsByDay.get(assignedYmd) ?? new Set<string>();
    bucket.add(taskId);
    taskIdsByDay.set(assignedYmd, bucket);
  }

  return { countsByDay, latestByKey, taskIdsByDay };
}

type TodoEventRow = {
  id: string;
  task_id: string;
  task_title: string;
  action: string;
  created_at: string;
  logicalYmd: string;
};

async function loadRepeatingStandaloneTaskIds(): Promise<Set<string>> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, extra_data FROM tasks WHERE ${overviewScopeTaskSql()}`,
  );
  const ids = new Set<string>();
  for (const row of rows) {
    const id = String(row.id ?? '').trim();
    if (!id) continue;
    const extra = row.extra_data == null ? null : String(row.extra_data);
    if (taskHasRepeatingSchedule(extra)) ids.add(id);
  }
  return ids;
}

async function loadScopedTodoEvents(): Promise<Record<string, unknown>[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT tee.id, tee.task_id, tee.action, tee.created_at, tee.task_title
     FROM task_execution_events tee
     WHERE tee.action IN ('completed', 'reopened')
       AND ${overviewScopeEventSql('tee')}`,
  );
  return rows as Record<string, unknown>[];
}

/**
 * 直接查库，避免 listAllRecords 把 created_at 转成 ISO/Z 后影响墙上时钟比较。
 * 禁止 JOIN/EXISTS tasks：项目青蛙的 task_id 存的是 projects.id，内连接会被滤掉。
 */
async function loadFrogCompletionEvents(
  startYmd: string,
  endYmd: string,
): Promise<Record<string, unknown>[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, task_id, assigned_ymd, action, created_at, task_title
     FROM frog_completion_events
     WHERE LEFT(TRIM(assigned_ymd), 10) BETWEEN ? AND ?`,
    [startYmd, endYmd],
  );
  return rows as Record<string, unknown>[];
}

/** 标题：tasks.title → projects.name → 事件表 task_title 快照（主体已删仍可用快照） */
async function resolveFrogTitles(
  latestByKey: Map<string, FrogLatest>,
): Promise<{ titleById: Map<string, string>; projectIds: Set<string> }> {
  const ids = new Set<string>();
  for (const latest of latestByKey.values()) {
    if (latest.action !== 'completed') continue;
    if (latest.task_id) ids.add(latest.task_id);
  }
  const titleById = new Map<string, string>();
  const projectIds = new Set<string>();
  if (ids.size === 0) return { titleById, projectIds };

  const idList = [...ids];
  const placeholders = idList.map(() => '?').join(', ');

  const [taskRows] = await db.query<RowDataPacket[]>(
    `SELECT id, title FROM tasks WHERE id IN (${placeholders})`,
    idList,
  );
  for (const row of taskRows) {
    const id = String(row.id ?? '').trim();
    const title = String(row.title ?? '').trim();
    if (id && title) titleById.set(id, title);
  }

  // 项目青蛙 / 误写入项目 id：始终查 projects（含仍存活的行），并记下 subject
  const [projectRows] = await db.query<RowDataPacket[]>(
    `SELECT id, name FROM projects WHERE id IN (${placeholders})`,
    idList,
  );
  for (const row of projectRows) {
    const id = String(row.id ?? '').trim();
    const name = String(row.name ?? '').trim();
    if (!id) continue;
    projectIds.add(id);
    if (name && !titleById.has(id)) titleById.set(id, name);
  }

  return { titleById, projectIds };
}

function inferFrogSubject(
  taskId: string,
  projectIds: Set<string>,
): CompletionHeatmapFrogSubject | undefined {
  if (projectIds.has(taskId) || taskId.startsWith('p_')) return 'project';
  if (taskId.startsWith('tsk_') || taskId.startsWith('t_')) return 'task';
  return undefined;
}

function aggregateTodoEvents(
  events: Record<string, unknown>[],
  boundary: TasksDayBoundary,
  startYmd: string,
  endYmd: string,
  repeatingTaskIds: Set<string>,
): {
  countsByDay: Record<string, number>;
  netEventsByDay: Map<string, TodoEventRow[]>;
} {
  const scoped: TodoEventRow[] = [];

  for (const event of events) {
    const action = normalizeAction(event.action);
    if (action !== 'completed' && action !== 'reopened') continue;

    const taskId = String(event.task_id ?? '').trim();
    if (!taskId) continue;

    const logicalYmd = getLogicalYmdFromCreatedAt(event.created_at, boundary);
    if (!logicalYmd) continue;

    scoped.push({
      id: String(event.id ?? ''),
      task_id: taskId,
      task_title: String(event.task_title ?? ''),
      action,
      created_at: String(event.created_at ?? ''),
      logicalYmd,
    });
  }

  const net = filterNetCompletedEvents(scoped, repeatingTaskIds);
  const countsByDay: Record<string, number> = {};
  const netEventsByDay = new Map<string, TodoEventRow[]>();

  for (const latest of net) {
    if (latest.logicalYmd < startYmd || latest.logicalYmd > endYmd) continue;
    countsByDay[latest.logicalYmd] = (countsByDay[latest.logicalYmd] ?? 0) + 1;
    const bucket = netEventsByDay.get(latest.logicalYmd) ?? [];
    bucket.push(latest);
    netEventsByDay.set(latest.logicalYmd, bucket);
  }

  for (const [ymd, dayEvents] of netEventsByDay) {
    dayEvents.sort((a, b) => compareTaskAuditDatetime(a.created_at, b.created_at));
    netEventsByDay.set(ymd, dayEvents);
  }

  return { countsByDay, netEventsByDay };
}

function excludeFrogTodos(
  events: TodoEventRow[],
  frogTaskIds: Set<string> | undefined,
): TodoEventRow[] {
  return excludeTodosAlreadyCountedAsFrogs(events, frogTaskIds ?? new Set());
}

function buildTodoDayDetail(
  events: TodoEventRow[],
): Array<{ id: string; task_id: string; task_title: string; title: string }> {
  return events.map((event) => ({
    id: event.id,
    task_id: event.task_id,
    task_title: event.task_title,
    title: event.task_title,
  }));
}

function buildFrogDayDetail(
  latestByKey: Map<string, FrogLatest>,
  ymd: string,
  titleById: Map<string, string>,
  projectIds: Set<string>,
): Array<{
  task_id: string;
  task_title: string;
  subject?: CompletionHeatmapFrogSubject;
}> {
  const frogs: Array<{
    task_id: string;
    task_title: string;
    subject?: CompletionHeatmapFrogSubject;
  }> = [];
  for (const [key, latest] of latestByKey) {
    if (latest.action !== 'completed') continue;
    const [taskId, assignedYmd] = key.split('\0');
    if (assignedYmd !== ymd || !taskId) continue;
    const subject = inferFrogSubject(taskId, projectIds);
    frogs.push({
      task_id: taskId,
      task_title: titleById.get(taskId) || latest.task_title || taskId,
      ...(subject ? { subject } : {}),
    });
  }
  frogs.sort((a, b) => a.task_id.localeCompare(b.task_id));
  return frogs;
}

export interface CompletionHeatmapParams extends TasksBootstrapParams {
  day?: string;
  includeDayDetail?: boolean;
}

export async function getCompletionHeatmap(
  params: CompletionHeatmapParams,
): Promise<CompletionHeatmapResult> {
  const context = resolveTasksBootstrapContext(params);
  const boundary = context.dayBoundary;

  const range = resolveHeatmapRange({
    heatmapStart: params.heatmapStart,
    heatmapEnd: params.heatmapEnd,
    dayBoundary: boundary,
  });

  const [frogEvents, todoEvents, repeatingTaskIds] = await Promise.all([
    loadFrogCompletionEvents(range.startYmd, range.endYmd),
    loadScopedTodoEvents(),
    loadRepeatingStandaloneTaskIds(),
  ]);

  const {
    countsByDay: frogCounts,
    latestByKey,
    taskIdsByDay: frogTaskIdsByDay,
  } = aggregateFrogEvents(frogEvents, range.startYmd, range.endYmd);

  const { netEventsByDay } = aggregateTodoEvents(
    todoEvents,
    boundary,
    range.startYmd,
    range.endYmd,
    repeatingTaskIds,
  );

  const countsByDay: Record<string, DayCount> = {};
  let cursor = range.startYmd;
  while (cursor <= range.endYmd) {
    const frogs = frogCounts[cursor] ?? 0;
    const todosNet = excludeFrogTodos(netEventsByDay.get(cursor) ?? [], frogTaskIdsByDay.get(cursor));
    netEventsByDay.set(cursor, todosNet);
    const todos = todosNet.length;
    countsByDay[cursor] = { frogs, todos, total: frogs + todos };
    cursor = addDaysToLogicalYmd(cursor, 1);
  }

  const result: CompletionHeatmapResult = {
    meta: {
      logicalToday: context.logicalToday,
      heatmapStart: range.startYmd,
      heatmapEnd: range.endYmd,
      completionHeatmapWeeks: COMPLETION_HEATMAP_WEEKS,
      serverTime: new Date().toISOString(),
      todoNetCompleted: true,
    },
    countsByDay,
  };

  const detailDay = params.day?.trim();
  if (params.includeDayDetail === true && detailDay && isValidYmd(detailDay)) {
    const { titleById, projectIds } = await resolveFrogTitles(latestByKey);
    result.dayDetail = {
      ymd: detailDay,
      frogs: buildFrogDayDetail(latestByKey, detailDay, titleById, projectIds),
      todos: buildTodoDayDetail(netEventsByDay.get(detailDay) ?? []),
    };
  }

  return result;
}
