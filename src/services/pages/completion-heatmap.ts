import { listAllRecords } from '../crud.js';
import { addDaysToLogicalYmd, getLogicalYmdFromCreatedAt } from '../calendar/logical-day.js';
import type { TasksDayBoundary } from '../calendar/types.js';
import { isValidYmd } from '../../utils/ymd.js';
import {
  COMPLETION_HEATMAP_WEEKS,
  resolveHeatmapRange,
  resolveHeatmapEventCreatedAtBounds,
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
  todos: Array<{ id: string; task_id: string; task_title: string }>;
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

function normalizeAction(raw: unknown): string {
  return String(raw ?? '').trim();
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
        action: normalizeAction(event.action),
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
  task_title: string;
  action: string;
  created_at: string;
  logicalYmd: string;
};

function aggregateTodoEvents(
  events: Record<string, unknown>[],
  boundary: TasksDayBoundary,
  startYmd: string,
  endYmd: string,
): {
  countsByDay: Record<string, number>;
  netEventsByDay: Map<string, TodoEventRow[]>;
} {
  const scoped: TodoEventRow[] = [];
  for (const event of events) {
    const action = normalizeAction(event.action);
    if (action !== 'completed' && action !== 'reopened') continue;

    const logicalYmd = getLogicalYmdFromCreatedAt(event.created_at, boundary);
    if (!logicalYmd || logicalYmd < startYmd || logicalYmd > endYmd) continue;

    const taskId = String(event.task_id ?? '').trim();
    if (!taskId) continue;

    scoped.push({
      id: String(event.id ?? ''),
      task_id: taskId,
      task_title: String(event.task_title ?? ''),
      action,
      created_at: String(event.created_at ?? ''),
      logicalYmd,
    });
  }

  const latestByKey = new Map<string, TodoEventRow>();
  for (const event of scoped) {
    const key = `${event.task_id}\0${event.logicalYmd}`;
    const existing = latestByKey.get(key);
    if (!existing || event.created_at > existing.created_at) {
      latestByKey.set(key, event);
    }
  }

  const countsByDay: Record<string, number> = {};
  const netEventsByDay = new Map<string, TodoEventRow[]>();
  for (const latest of latestByKey.values()) {
    if (latest.action !== 'completed') continue;
    countsByDay[latest.logicalYmd] = (countsByDay[latest.logicalYmd] ?? 0) + 1;
    const bucket = netEventsByDay.get(latest.logicalYmd) ?? [];
    bucket.push(latest);
    netEventsByDay.set(latest.logicalYmd, bucket);
  }

  for (const [ymd, dayEvents] of netEventsByDay) {
    dayEvents.sort((a, b) => a.created_at.localeCompare(b.created_at));
    netEventsByDay.set(ymd, dayEvents);
  }

  return { countsByDay, netEventsByDay };
}

function buildTodoDayDetail(
  events: TodoEventRow[],
): Array<{ id: string; task_id: string; task_title: string }> {
  return events.map((event) => ({
    id: event.id,
    task_id: event.task_id,
    task_title: event.task_title,
  }));
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

  const eventCreatedAtBounds = resolveHeatmapEventCreatedAtBounds(
    range.startYmd,
    range.endYmd,
    boundary,
  );

  const [frogEvents, todoEvents] = await Promise.all([
    listAllRecords('frog_completion_events', {
      assignedYmdGte: range.startYmd,
      assignedYmdLte: range.endYmd,
    }),
    listAllRecords('task_execution_events', eventCreatedAtBounds),
  ]);

  const { countsByDay: frogCounts, latestByKey } = aggregateFrogEvents(
    frogEvents,
    range.startYmd,
    range.endYmd,
  );
  const { countsByDay: todoCounts, netEventsByDay } = aggregateTodoEvents(
    todoEvents,
    boundary,
    range.startYmd,
    range.endYmd,
  );

  const countsByDay: Record<string, DayCount> = {};
  let cursor = range.startYmd;
  while (cursor <= range.endYmd) {
    const frogs = frogCounts[cursor] ?? 0;
    const todos = todoCounts[cursor] ?? 0;
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
      todos: buildTodoDayDetail(netEventsByDay.get(detailDay) ?? []),
    };
  }

  return result;
}
