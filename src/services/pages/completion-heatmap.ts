import { listAllRecords } from '../crud.js';
import { getLogicalLocalYmd, addDaysToLogicalYmd } from '../calendar/logical-day.js';
import type { TasksDayBoundary } from '../calendar/types.js';
import { isValidYmd } from '../../utils/ymd.js';
import {
  COMPLETION_HEATMAP_WEEKS,
  resolveHeatmapRange,
} from './heatmap-range.js';
import { resolveTasksBootstrapContext, type TasksBootstrapParams } from './tasks-bootstrap.js';

export interface DayCount {
  frogs: number;
  todos: number;
  total: number;
}

export interface CompletionHeatmapDayDetail {
  ymd: string;
  frogs: Array<{ task_id: string; task_title: string }>;
  todos: Array<{ id: string; task_id: string; title: string }>;
}

export interface CompletionHeatmapResult {
  meta: {
    logicalToday: string;
    heatmapStart: string;
    heatmapEnd: string;
    completionHeatmapWeeks: number;
    serverTime: string;
  };
  countsByDay: Record<string, DayCount>;
  dayDetail?: CompletionHeatmapDayDetail;
}

function eventLogicalYmd(createdAt: string, boundary: TasksDayBoundary): string | null {
  const raw = createdAt.trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return getLogicalLocalYmd(new Date(ms), boundary);
}

type FrogLatest = { action: string; created_at: string; task_title: string };

function aggregateFrogEvents(
  events: Record<string, unknown>[],
  startYmd: string,
  endYmd: string,
): {
  countsByDay: Record<string, number>;
  latestByKey: Map<string, FrogLatest>;
} {
  const latestByKey = new Map<string, FrogLatest>();
  for (const event of events) {
    const taskId = String(event.task_id ?? '');
    const assignedYmd = String(event.assigned_ymd ?? '');
    if (!taskId || !assignedYmd || !isValidYmd(assignedYmd)) continue;
    const key = `${taskId}\0${assignedYmd}`;
    const createdAt = String(event.created_at ?? '');
    const existing = latestByKey.get(key);
    if (!existing || createdAt > existing.created_at) {
      latestByKey.set(key, {
        action: String(event.action ?? ''),
        created_at: createdAt,
        task_title: String(event.task_title ?? ''),
      });
    }
  }

  const countsByDay: Record<string, number> = {};
  for (const [key, latest] of latestByKey) {
    if (latest.action !== 'completed') continue;
    const assignedYmd = key.split('\0')[1] ?? '';
    if (assignedYmd < startYmd || assignedYmd > endYmd) continue;
    countsByDay[assignedYmd] = (countsByDay[assignedYmd] ?? 0) + 1;
  }

  return { countsByDay, latestByKey };
}

type TodoEventRow = {
  id: string;
  task_id: string;
  title: string;
  action: string;
  logicalYmd: string;
};

function aggregateTodoEvents(
  events: Record<string, unknown>[],
  boundary: TasksDayBoundary,
  startYmd: string,
  endYmd: string,
): {
  netByDay: Record<string, number>;
  eventsByDay: Map<string, TodoEventRow[]>;
} {
  const netByDay: Record<string, number> = {};
  const eventsByDay = new Map<string, TodoEventRow[]>();

  for (const event of events) {
    const logicalYmd = eventLogicalYmd(String(event.created_at ?? ''), boundary);
    if (!logicalYmd || logicalYmd < startYmd || logicalYmd > endYmd) continue;
    const action = String(event.action ?? '');
    if (action !== 'completed' && action !== 'reopened') continue;

    const row: TodoEventRow = {
      id: String(event.id ?? ''),
      task_id: String(event.task_id ?? ''),
      title: String(event.task_title ?? ''),
      action,
      logicalYmd,
    };
    const bucket = eventsByDay.get(logicalYmd) ?? [];
    bucket.push(row);
    eventsByDay.set(logicalYmd, bucket);

    const delta = action === 'completed' ? 1 : -1;
    netByDay[logicalYmd] = (netByDay[logicalYmd] ?? 0) + delta;
  }

  return { netByDay, eventsByDay };
}

function buildTodoDayDetail(events: TodoEventRow[]): Array<{ id: string; task_id: string; title: string }> {
  const netByTask = new Map<string, { id: string; task_id: string; title: string; net: number }>();
  for (const event of events) {
    const taskId = event.task_id;
    if (!taskId) continue;
    const prev = netByTask.get(taskId) ?? {
      id: event.id,
      task_id: taskId,
      title: event.title,
      net: 0,
    };
    if (event.action === 'completed') {
      prev.net += 1;
      prev.id = event.id;
      if (event.title) prev.title = event.title;
    } else {
      prev.net -= 1;
    }
    netByTask.set(taskId, prev);
  }

  return [...netByTask.values()]
    .filter((x) => x.net > 0)
    .map((x) => ({ id: x.id, task_id: x.task_id, title: x.title }));
}

function buildFrogDayDetail(
  latestByKey: Map<string, FrogLatest>,
  ymd: string,
): Array<{ task_id: string; task_title: string }> {
  const frogs: Array<{ task_id: string; task_title: string }> = [];
  for (const [key, latest] of latestByKey) {
    if (latest.action !== 'completed') continue;
    const [taskId, assignedYmd] = key.split('\0');
    if (assignedYmd !== ymd || !taskId) continue;
    frogs.push({ task_id: taskId, task_title: latest.task_title });
  }
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

  const [frogEvents, todoEvents] = await Promise.all([
    listAllRecords('frog_completion_events', {
      assignedYmdGte: range.startYmd,
      assignedYmdLte: range.endYmd,
    }),
    listAllRecords('task_execution_events', {
      createdAtGte: range.startYmd,
      createdAtLte: range.endYmd,
    }),
  ]);

  const { countsByDay: frogCounts, latestByKey } = aggregateFrogEvents(
    frogEvents,
    range.startYmd,
    range.endYmd,
  );
  const { netByDay: todoNet, eventsByDay } = aggregateTodoEvents(
    todoEvents,
    boundary,
    range.startYmd,
    range.endYmd,
  );

  const countsByDay: Record<string, DayCount> = {};
  let cursor = range.startYmd;
  while (cursor <= range.endYmd) {
    const frogs = frogCounts[cursor] ?? 0;
    const todos = Math.max(0, todoNet[cursor] ?? 0);
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
    },
    countsByDay,
  };

  const detailDay = params.day?.trim();
  const wantDetail = params.includeDayDetail === true || Boolean(detailDay);
  if (wantDetail && detailDay && isValidYmd(detailDay)) {
    result.dayDetail = {
      ymd: detailDay,
      frogs: buildFrogDayDetail(latestByKey, detailDay),
      todos: buildTodoDayDetail(eventsByDay.get(detailDay) ?? []),
    };
  }

  return result;
}
