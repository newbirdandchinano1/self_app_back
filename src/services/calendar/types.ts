export type TasksDayBoundary = { hour: number; minute: number };

export const DEFAULT_TASKS_DAY_BOUNDARY: TasksDayBoundary = { hour: 0, minute: 0 };

export type FrogCalendarDayStatus = 'pending' | 'completed' | 'partial' | 'incomplete';
export type TodoCalendarDayReason = 'due' | 'completed' | 'completed-and-due';

export type TasksCalendarTaskItem = {
  id: string;
  title: string;
  status: string;
  priority: number;
  kind: 'frog' | 'standalone' | 'matrix' | 'due';
  projectId: string | null;
  frogDayStatus?: FrogCalendarDayStatus;
  todoDayReason?: TodoCalendarDayReason;
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
  hasDayRecord?: boolean;
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

export type TasksCalendarMeta = {
  renderReady?: boolean;
  view?: string;
  logicalToday?: string;
  serverTime?: string;
};

export type TasksCalendarGridDay = {
  ymd: string;
  level: 0 | 1 | 2 | 3 | 4;
  frogs: number;
  openTodos: number;
  habits: number;
  projectsDue: number;
  frogDone: boolean;
  habitChecked: boolean;
  dueCount: number;
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
  note?: string | null;
  extra_data: string | null;
  created_at?: string;
  context?: string | null;
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

export type CalendarFrogEventRow = {
  task_id: string;
  assigned_ymd: string;
  action: string;
  created_at: string;
};

export type CalendarExecutionEventRow = {
  task_id: string;
  action: string;
  created_at: string;
};
