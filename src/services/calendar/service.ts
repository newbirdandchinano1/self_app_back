import type { RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import { buildTasksCalendarSummaries } from './aggregation.js';
import { normalizeTasksDayBoundary } from './logical-day.js';
import type {
  CalendarCheckInRow,
  CalendarHabitRow,
  CalendarProjectRow,
  CalendarTaskRow,
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

async function loadTasksForCalendar(startYmd: string, endYmd: string): Promise<CalendarTaskRow[]> {
  const hasFrogCol = await tableHasColumn('tasks', 'frog_assigned_on');
  const frogCol = hasFrogCol ? 'frog_assigned_on' : 'NULL AS frog_assigned_on';
  const frogClause = hasFrogCol ? 'OR frog_assigned_on BETWEEN ? AND ?' : '';
  const params: unknown[] = [startYmd, endYmd];
  if (hasFrogCol) params.push(startYmd, endYmd);

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, project_id, parent_task_id, title, status, priority, due_date,
            completed_at, created_at, updated_at, extra_data, ${frogCol}
     FROM ${quoteIdent('tasks')}
     WHERE (
       LEFT(COALESCE(due_date, ''), 10) BETWEEN ? AND ?
       ${frogClause}
       OR status NOT IN ('cancelled')
     )`,
    params,
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

function buildCheckInMap(rows: CalendarCheckInRow[]): Map<string, Map<string, number>> {
  const map = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const ymd = row.record_date?.trim().slice(0, 10) ?? '';
    if (!ymd) continue;
    const dayMap = map.get(ymd) ?? new Map<string, number>();
    dayMap.set(row.habit_id, Number(row.count ?? 0));
    map.set(ymd, dayMap);
  }
  return map;
}

export interface TasksCalendarResult {
  start: string;
  end: string;
  days: Record<string, import('./types.js').TasksCalendarDaySummary>;
}

export async function getTasksCalendarSummaries(params: {
  start: string;
  end: string;
  dayBoundaryHour?: number;
  dayBoundaryMinute?: number;
}): Promise<TasksCalendarResult> {
  const { start, end } = params;
  const dayBoundary: TasksDayBoundary = normalizeTasksDayBoundary({
    hour: params.dayBoundaryHour ?? 0,
    minute: params.dayBoundaryMinute ?? 0,
  });

  const [tasks, habits, projects, checkIns] = await Promise.all([
    loadTasksForCalendar(start, end),
    loadHabits(),
    loadProjectsForCalendar(start, end),
    loadHabitCheckIns(start, end),
  ]);

  const habitCheckInsByDay = buildCheckInMap(checkIns);
  const days = buildTasksCalendarSummaries({
    startYmd: start,
    endYmd: end,
    tasks,
    habits,
    projects,
    habitCheckInsByDay,
    dayBoundary,
  });

  return { start, end, days };
}
