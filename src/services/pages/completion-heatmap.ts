import type { RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import {
  addDaysToLogicalYmd,
  compareTaskAuditDatetime,
  getLogicalYmdFromCreatedAt,
} from '../calendar/logical-day.js';
import { taskHasRepeatingSchedule } from '../calendar/aggregation.js';
import type { TasksDayBoundary } from '../calendar/types.js';
import { isValidYmd } from '../../utils/ymd.js';
import { COMPLETION_HEATMAP_WEEKS, resolveHeatmapRange } from './heatmap-range.js';
import { resolveTasksBootstrapContext, type TasksBootstrapParams } from './tasks-bootstrap.js';
import { excludeTodosAlreadyCountedAsFrogs, filterNetCompletedEvents } from './task-net-completion.js';
import { overviewScopeEventSql, overviewScopeTaskSql } from './tasks-overview-scope.js';

export interface DayCount {
  frogs: number;
  todos: number;
  total: number;
}

export interface CompletionHeatmapDayDetail {
  ymd: string;
  frogs: Array<{ task_id: string; task_title: string }>;
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

/** 标题：tasks.title → projects.name → 事件表 task_title 快照（兼容项目青蛙） */
async function resolveFrogTitles(
  latestByKey: Map<string, FrogLatest>,
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const latest of latestByKey.values()) {
    if (latest.action !== 'completed') continue;
    if (latest.task_id) ids.add(latest.task_id);
  }
  const titleById = new Map<string, string>();
  if (ids.size === 0) return titleById;

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

  const missing = idList.filter((id) => !titleById.has(id));
  if (missing.length > 0) {
    const ph = missing.map(() => '?').join(', ');
    const [projectRows] = await db.query<RowDataPacket[]>(
      `SELECT id, name FROM projects WHERE id IN (${ph})`,
      missing,
    );
    for (const row of projectRows) {
      const id = String(row.id ?? '').trim();
      const name = String(row.name ?? '').trim();
      if (id && name) titleById.set(id, name);
    }
  }

  return titleById;
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
): Array<{ task_id: string; task_title: string }> {
  const frogs: Array<{ task_id: string; task_title: string }> = [];
  for (const [key, latest] of latestByKey) {
    if (latest.action !== 'completed') continue;
    const [taskId, assignedYmd] = key.split('\0');
    if (assignedYmd !== ymd || !taskId) continue;
    frogs.push({
      task_id: taskId,
      task_title: titleById.get(taskId) || latest.task_title || taskId,
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
    const titleById = await resolveFrogTitles(latestByKey);
    result.dayDetail = {
      ymd: detailDay,
      frogs: buildFrogDayDetail(latestByKey, detailDay, titleById),
      todos: buildTodoDayDetail(netEventsByDay.get(detailDay) ?? []),
    };
  }

  return result;
}
