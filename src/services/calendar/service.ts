import type { RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import { filterNetCompletedEvents } from '../pages/task-net-completion.js';
import { taskHasRepeatingSchedule } from './aggregation.js';
import {
  buildTasksCalendarSummaries,
  emptyDay,
  projectCalendarDaysToGrid,
} from './aggregation.js';
import {
  getLogicalLocalYmd,
  getLogicalYmdFromCreatedAt,
  normalizeTasksDayBoundary,
} from './logical-day.js';
import type {
  CalendarCheckInRow,
  CalendarExecutionEventRow,
  CalendarFrogEventRow,
  CalendarHabitRow,
  CalendarProjectRow,
  CalendarTaskRow,
  TasksCalendarDaySummary,
  TasksCalendarGridDay,
  TasksCalendarMeta,
  TasksDayBoundary,
} from './types.js';

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

async function tableHasColumn(table: string, column: string): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
     LIMIT 1`,
    [table, column],
  );
  return rows.length > 0;
}

async function loadTasksForCalendar(): Promise<CalendarTaskRow[]> {
  const hasFrogCol = await tableHasColumn('tasks', 'frog_assigned_on');
  const hasSync = await tableHasColumn('tasks', 'sync_status');
  const frogCol = hasFrogCol ? 'frog_assigned_on' : 'NULL AS frog_assigned_on';
  const where = hasSync ? `WHERE (sync_status IS NULL OR sync_status != 'pending_delete')` : '';

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, project_id, parent_task_id, title, status, priority, due_date,
            completed_at, created_at, updated_at, extra_data, ${frogCol}
     FROM ${quoteIdent('tasks')} ${where}`,
  );
  return rows as CalendarTaskRow[];
}

async function loadHabits(): Promise<CalendarHabitRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, name, icon, extra_data, created_at FROM ${quoteIdent('habits')}`,
  );
  return rows as CalendarHabitRow[];
}

async function loadProjectsForCalendar(startYmd: string, endYmd: string): Promise<CalendarProjectRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, name, status, due_date FROM ${quoteIdent('projects')}
     WHERE status != 'archived'
       AND LEFT(COALESCE(due_date, ''), 10) BETWEEN ? AND ?`,
    [startYmd, endYmd],
  );
  return rows as CalendarProjectRow[];
}

async function loadHabitCheckIns(startYmd: string, endYmd: string): Promise<CalendarCheckInRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT habit_id, record_date, count FROM ${quoteIdent('habit_check_ins')}
     WHERE record_date >= ? AND record_date <= ?`,
    [startYmd, endYmd],
  );
  return rows as CalendarCheckInRow[];
}

async function loadFrogEvents(startYmd: string, endYmd: string): Promise<CalendarFrogEventRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT task_id, assigned_ymd, action, created_at
     FROM ${quoteIdent('frog_completion_events')}
     WHERE LEFT(TRIM(assigned_ymd), 10) BETWEEN ? AND ?`,
    [startYmd, endYmd],
  );
  return rows as CalendarFrogEventRow[];
}

async function loadExecutionEvents(): Promise<CalendarExecutionEventRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT task_id, action, created_at FROM ${quoteIdent('task_execution_events')}
     WHERE action IN ('completed', 'reopened')`,
  );
  return rows as CalendarExecutionEventRow[];
}

function buildCheckInMap(rows: CalendarCheckInRow[]): Map<string, Map<string, number>> {
  const map = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const ymd = row.record_date?.trim().slice(0, 10) ?? '';
    if (!ymd) continue;
    const habitId = String(row.habit_id ?? '').trim();
    if (!habitId) continue;
    const dayMap = map.get(ymd) ?? new Map<string, number>();
    dayMap.set(habitId, Number(row.count ?? 0));
    map.set(ymd, dayMap);
  }
  return map;
}

function buildFrogCompletedByDay(
  events: CalendarFrogEventRow[],
): Map<string, Set<string>> {
  const latestByKey = new Map<string, CalendarFrogEventRow>();
  for (const event of events) {
    const taskId = String(event.task_id ?? '').trim();
    const assignedYmd = String(event.assigned_ymd ?? '').trim().slice(0, 10);
    if (!taskId || !assignedYmd) continue;
    const key = `${taskId}\0${assignedYmd}`;
    const prev = latestByKey.get(key);
    if (!prev || event.created_at > prev.created_at) {
      latestByKey.set(key, event);
    }
  }
  const byDay = new Map<string, Set<string>>();
  for (const event of latestByKey.values()) {
    if (String(event.action ?? '').trim() !== 'completed') continue;
    const ymd = String(event.assigned_ymd).trim().slice(0, 10);
    const taskId = String(event.task_id).trim();
    const set = byDay.get(ymd) ?? new Set<string>();
    set.add(taskId);
    byDay.set(ymd, set);
  }
  return byDay;
}

function isBlank(value: unknown): boolean {
  return value == null || String(value).trim() === '';
}

function buildStandaloneCompletedByDay(
  events: CalendarExecutionEventRow[],
  tasks: CalendarTaskRow[],
  boundary: TasksDayBoundary,
): Map<string, Set<string>> {
  const repeatingTaskIds = new Set<string>();
  const standaloneIds = new Set<string>();
  for (const task of tasks) {
    if (!isBlank(task.project_id) || !isBlank(task.parent_task_id)) continue;
    standaloneIds.add(task.id);
    if (taskHasRepeatingSchedule(task.extra_data)) repeatingTaskIds.add(task.id);
  }

  const scoped = [];
  for (const event of events) {
    const action = String(event.action ?? '').trim();
    if (action !== 'completed' && action !== 'reopened') continue;
    const taskId = String(event.task_id ?? '').trim();
    if (!taskId || !standaloneIds.has(taskId)) continue;
    const logicalYmd = getLogicalYmdFromCreatedAt(event.created_at, boundary);
    if (!logicalYmd) continue;
    scoped.push({
      task_id: taskId,
      action,
      created_at: String(event.created_at ?? ''),
      logicalYmd,
    });
  }

  const net = filterNetCompletedEvents(scoped, repeatingTaskIds);
  const byDay = new Map<string, Set<string>>();
  for (const event of net) {
    const set = byDay.get(event.logicalYmd) ?? new Set<string>();
    set.add(event.task_id);
    byDay.set(event.logicalYmd, set);
  }
  return byDay;
}

export interface TasksCalendarListResult {
  start: string;
  end: string;
  meta: TasksCalendarMeta;
  days: Record<string, TasksCalendarDaySummary>;
}

export interface TasksCalendarGridResult {
  start: string;
  end: string;
  meta: TasksCalendarMeta;
  days: Record<string, TasksCalendarGridDay>;
}

export interface TasksCalendarDayResult {
  ymd: string;
  meta: TasksCalendarMeta;
  day: TasksCalendarDaySummary;
}

async function loadCalendarDays(params: {
  start: string;
  end: string;
  dayBoundaryHour?: number;
  dayBoundaryMinute?: number;
}): Promise<{
  start: string;
  end: string;
  logicalToday: string;
  serverTime: string;
  days: Record<string, TasksCalendarDaySummary>;
}> {
  const { start, end } = params;
  const dayBoundary: TasksDayBoundary = normalizeTasksDayBoundary({
    hour: params.dayBoundaryHour ?? 0,
    minute: params.dayBoundaryMinute ?? 0,
  });
  const logicalToday = getLogicalLocalYmd(new Date(), dayBoundary);
  const serverTime = new Date().toISOString();

  const [tasks, habits, projects, checkIns, frogEvents, executionEvents] = await Promise.all([
    loadTasksForCalendar(),
    loadHabits(),
    loadProjectsForCalendar(start, end),
    loadHabitCheckIns(start, end),
    loadFrogEvents(start, end),
    loadExecutionEvents(),
  ]);

  const days = buildTasksCalendarSummaries({
    startYmd: start,
    endYmd: end,
    tasks,
    habits,
    projects,
    habitCheckInsByDay: buildCheckInMap(checkIns),
    dayBoundary,
    logicalTodayYmd: logicalToday,
    frogCompletedTaskIdsByDay: buildFrogCompletedByDay(frogEvents),
    standaloneCompletedTaskIdsByDay: buildStandaloneCompletedByDay(
      executionEvents,
      tasks,
      dayBoundary,
    ),
  });

  return { start, end, logicalToday, serverTime, days };
}

export async function getTasksCalendarSummaries(params: {
  start: string;
  end: string;
  dayBoundaryHour?: number;
  dayBoundaryMinute?: number;
}): Promise<TasksCalendarListResult> {
  const loaded = await loadCalendarDays(params);
  return {
    start: loaded.start,
    end: loaded.end,
    meta: {
      renderReady: true,
      logicalToday: loaded.logicalToday,
      serverTime: loaded.serverTime,
    },
    days: loaded.days,
  };
}

export async function getTasksCalendarGrid(params: {
  start: string;
  end: string;
  dayBoundaryHour?: number;
  dayBoundaryMinute?: number;
}): Promise<TasksCalendarGridResult> {
  const loaded = await loadCalendarDays(params);
  return {
    start: loaded.start,
    end: loaded.end,
    meta: {
      view: 'grid',
      logicalToday: loaded.logicalToday,
      serverTime: loaded.serverTime,
    },
    days: projectCalendarDaysToGrid(loaded.days, loaded.logicalToday),
  };
}

export async function getTasksCalendarDay(params: {
  ymd: string;
  dayBoundaryHour?: number;
  dayBoundaryMinute?: number;
}): Promise<TasksCalendarDayResult> {
  const loaded = await loadCalendarDays({
    start: params.ymd,
    end: params.ymd,
    dayBoundaryHour: params.dayBoundaryHour,
    dayBoundaryMinute: params.dayBoundaryMinute,
  });
  return {
    ymd: params.ymd,
    meta: {
      renderReady: true,
      logicalToday: loaded.logicalToday,
      serverTime: loaded.serverTime,
    },
    day: loaded.days[params.ymd] ?? emptyDay(params.ymd),
  };
}
