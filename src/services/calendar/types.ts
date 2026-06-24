export type TasksDayBoundary = { hour: number; minute: number };

export const DEFAULT_TASKS_DAY_BOUNDARY: TasksDayBoundary = { hour: 0, minute: 0 };

export type TasksCalendarTaskItem = {
  id: string;
  title: string;
  status: string;
  priority: number;
  kind: 'frog' | 'standalone' | 'matrix' | 'due';
  projectId: string | null;
};

export type HabitKind = 'build' | 'break' | 'task';

export type TasksCalendarHabitItem = {
  id: string;
  name: string;
  icon: string;
  todayCount: number;
  dailyGoal: number | null;
  kind: HabitKind;
  periodProgress?: number | null;
  periodGoal?: number | null;
  taskShowPeriodCheck?: boolean;
};

export type TasksCalendarProjectItem = {
  id: string;
  name: string;
  status: string;
};

export type TasksCalendarDaySummary = {
  ymd: string;
  frogs: TasksCalendarTaskItem[];
  standaloneTodos: TasksCalendarTaskItem[];
  matrixTasks: TasksCalendarTaskItem[];
  dueTasks: TasksCalendarTaskItem[];
  habits: TasksCalendarHabitItem[];
  projectsDue: TasksCalendarProjectItem[];
};

export type CalendarTaskRow = {
  id: string;
  project_id: string | null;
  parent_task_id: string | null;
  title: string;
  status: string;
  priority: number;
  due_date: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  extra_data: string | null;
  frog_assigned_on?: string | null;
};

export type CalendarHabitRow = {
  id: string;
  name: string;
  icon: string;
  extra_data: string | null;
  created_at?: string;
};

export type CalendarProjectRow = {
  id: string;
  name: string;
  status: string;
  due_date: string | null;
};

export type CalendarCheckInRow = {
  habit_id: string;
  record_date: string;
  count: number;
};
