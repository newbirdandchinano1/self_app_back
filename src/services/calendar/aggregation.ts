/**
 * 任务日历聚合逻辑（与前端 lib/tasks-calendar-data.ts 及关联模块对齐）
 */
import { addDaysToYmd, dueDateYmd, formatLocalYmd, ymdToLocalDate } from '../../utils/ymd.js';
import {
  addDaysToLogicalYmd,
  formatLocalYmdFromDate,
  getLogicalYmdFromCreatedAt,
  logicalYmdToLocalDate,
  startOfWeekMonday,
} from './logical-day.js';
import {
  DEFAULT_TASKS_DAY_BOUNDARY,
  type CalendarHabitRow,
  type CalendarProjectRow,
  type CalendarTaskRow,
  type FrogCalendarDayStatus,
  type HabitKind,
  type TasksCalendarDaySummary,
  type TasksCalendarGridDay,
  type TasksCalendarHabitItem,
  type TasksCalendarTaskItem,
  type TasksDayBoundary,
  type TodoCalendarDayReason,
} from './types.js';

type ProjectScheduleMeta = {
  mode?: 'date' | 'time';
  date?: string;
  range?: { start: string; end: string };
};

type TaskMetaExtra = {
  frogAssignedOn?: string;
  frogAssignedDates?: unknown;
  frogSessionCompletedOn?: string;
};

type TaskRepeatOption = '不重复' | '每天' | '每周' | '每月' | '每年';
type TaskRepeatSchedule = {
  repeatOption: TaskRepeatOption;
  weeklyDays: number[];
  monthlyDays: number[];
  yearlyDate: string;
};

type BuildHabitExpectedGoalType = 'days' | 'times' | 'consecutive_days';
type BuildHabitExpectedGoal = { type: BuildHabitExpectedGoalType; value: number };
type TaskRepeatPeriod = '每日' | '每周' | '每月' | '每年';

const HABIT_CN_WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;
const REPEAT_OPTIONS: TaskRepeatOption[] = ['不重复', '每天', '每周', '每月', '每年'];
const CN_WEEKDAY_TO_MON1: Record<string, number> = {
  周一: 1,
  周二: 2,
  周三: 3,
  周四: 4,
  周五: 5,
  周六: 6,
  周日: 7,
};

function parseExtraObject(extraData: string | null): Record<string, unknown> {
  if (!extraData) return {};
  try {
    const parsed = JSON.parse(extraData) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

function parseProjectSchedule(extraData: string | null): ProjectScheduleMeta | null {
  const schedule = parseExtraObject(extraData).schedule;
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return null;
  return schedule as ProjectScheduleMeta;
}

function parseTaskMeta(extraData: string | null): TaskMetaExtra {
  return parseExtraObject(extraData) as TaskMetaExtra;
}

function normalizeYmd(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

export function extraDataToString(extraData: unknown): string | null {
  if (extraData == null || extraData === '') return null;
  if (typeof extraData === 'string') return extraData;
  try {
    return JSON.stringify(extraData);
  } catch {
    return null;
  }
}

/** 与客户端 isFrogAssignedOn(extra_data, ymd) 对齐：指派日来自 extra_data 与可选列 */
export function collectFrogAssignedDates(
  extraData: unknown,
  frogAssignedOnColumn?: string | null,
): string[] {
  const extra = parseTaskMeta(extraDataToString(extraData));
  const dates = new Set<string>();
  if (Array.isArray(extra.frogAssignedDates)) {
    for (const item of extra.frogAssignedDates) {
      const ymd = normalizeYmd(item);
      if (ymd) dates.add(ymd);
    }
  }
  const fromExtra = normalizeYmd(extra.frogAssignedOn);
  if (fromExtra) dates.add(fromExtra);
  const fromCol = normalizeYmd(frogAssignedOnColumn);
  if (fromCol) dates.add(fromCol);
  return [...dates].sort();
}

export function isFrogAssignedOn(
  extraData: unknown,
  logicalYmd: string,
  frogAssignedOnColumn?: string | null,
): boolean {
  if (!logicalYmd) return false;
  return collectFrogAssignedDates(extraData, frogAssignedOnColumn).includes(logicalYmd);
}

function getFrogAssignedDates(task: CalendarTaskRow): string[] {
  return collectFrogAssignedDates(task.extra_data, task.frog_assigned_on);
}

function getFrogSessionCompletedOn(extraData: string | null): string {
  const raw = parseTaskMeta(extraData).frogSessionCompletedOn;
  return typeof raw === 'string' ? raw.trim() : '';
}

function resolveFrogCalendarDayStatus(params: {
  taskStatus: string;
  viewYmd: string;
  logicalTodayYmd: string;
  hasCompletionEvent: boolean;
  frogSessionCompletedOn: string;
}): FrogCalendarDayStatus {
  if (isTaskTerminalStatus(params.taskStatus)) return 'completed';
  if (params.hasCompletionEvent) return 'partial';
  if (
    params.viewYmd === params.logicalTodayYmd &&
    params.frogSessionCompletedOn === params.viewYmd
  ) {
    return 'partial';
  }
  if (params.viewYmd < params.logicalTodayYmd) return 'incomplete';
  return 'pending';
}

export function formatScheduleDateToYMD(value: string): string {
  const t = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t.slice(0, 10);
  return formatLocalYmd(d);
}

export function isLogicalDayInYmdRange(todayYmd: string, startYmd: string, endYmd: string): boolean {
  if (!startYmd || !endYmd) return true;
  if (todayYmd < startYmd) return false;
  if (startYmd === endYmd) return todayYmd === startYmd;
  if (endYmd === addDaysToYmd(startYmd, 1)) return todayYmd < endYmd;
  return todayYmd <= endYmd;
}

function isTaskTerminalStatus(status: string): boolean {
  return status === 'done' || status === 'cancelled';
}

function isTaskShelvedStatus(status: string): boolean {
  return status === 'shelved';
}

function isTaskActiveStatus(status: string): boolean {
  return !isTaskTerminalStatus(status) && !isTaskShelvedStatus(status);
}

function isMatrixTask(task: CalendarTaskRow): boolean {
  return !!(task.project_id || task.parent_task_id);
}

function toTaskItem(task: CalendarTaskRow, kind: TasksCalendarTaskItem['kind']): TasksCalendarTaskItem {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    kind,
    projectId: task.project_id,
  };
}

export function emptyDay(ymd: string): TasksCalendarDaySummary {
  return {
    ymd,
    frogs: [],
    standaloneTodos: [],
    matrixTasks: [],
    dueTasks: [],
    habits: [],
    projectsDue: [],
  };
}

function parseHabitKind(extraData: string | null): HabitKind {
  const kind = parseExtraObject(extraData).habitKind;
  if (kind === 'break') return 'break';
  if (kind === 'task') return 'task';
  return 'build';
}

/** habits.extra_data.reward_points：单次有效打卡奖励，缺省 0，范围 0..99999 */
function parseHabitRewardPoints(extraData: string | null): number {
  const raw = parseExtraObject(extraData).reward_points;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.min(99999, Math.max(0, Math.round(raw)));
}

function parseQuantifyRaw(extraData: string | null) {
  const q = parseExtraObject(extraData).quantify;
  if (!q || typeof q !== 'object' || Array.isArray(q)) return null;
  return q as { dailyGoal?: unknown; consecutiveTargetDays?: unknown; expectedGoal?: unknown };
}

function parseHabitDailyGoal(extraData: string | null, kind?: HabitKind): number | null {
  const resolvedKind = kind ?? parseHabitKind(extraData);
  const g = parseQuantifyRaw(extraData)?.dailyGoal;
  if (g === null || g === undefined) return resolvedKind === 'break' ? 0 : null;
  let numeric: number | null = null;
  if (typeof g === 'number' && Number.isFinite(g)) numeric = g;
  else if (typeof g === 'string' && g.trim() !== '') {
    const n = Number(g);
    if (Number.isFinite(n)) numeric = n;
  }
  if (numeric == null) return resolvedKind === 'break' ? 0 : null;
  const rounded = Math.min(99, Math.max(0, Math.round(numeric)));
  if ((resolvedKind === 'build' || resolvedKind === 'task') && rounded <= 0) return null;
  return rounded;
}

function isHabitDayGoalMet(params: {
  kind: HabitKind;
  todayCount: number;
  dailyGoal?: number | null;
}): boolean {
  const { kind, todayCount } = params;
  const count = Math.max(0, Math.floor(todayCount));
  const dailyGoal = params.dailyGoal ?? (kind === 'break' ? 0 : null);
  if (kind === 'break') {
    const threshold = dailyGoal ?? 0;
    if (threshold <= 0) return count === 0;
    return count < threshold;
  }
  if (dailyGoal != null) return count >= dailyGoal;
  return count > 0;
}

function parseBuildHabitExpectedGoal(extraData: string | null): BuildHabitExpectedGoal | null {
  const raw = parseQuantifyRaw(extraData)?.expectedGoal;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as { type?: unknown; value?: unknown };
  const type = obj.type;
  if (type !== 'days' && type !== 'times' && type !== 'consecutive_days') return null;
  if (typeof obj.value !== 'number' || !Number.isFinite(obj.value)) return null;
  const value = Math.round(obj.value);
  if (value < 1) return null;
  const max = type === 'times' ? 9999 : 999;
  return { type, value: Math.min(max, Math.max(1, value)) };
}

function countBuildAchievedDays(checkIns: Record<string, number>, dailyGoal: number | null): number {
  return Object.values(checkIns).filter((c) =>
    isHabitDayGoalMet({ kind: 'build', todayCount: c, dailyGoal }),
  ).length;
}

function computeTotalCheckInCount(checkIns: Record<string, number>): number {
  return Object.values(checkIns).reduce((sum, c) => sum + Math.max(0, Math.floor(c)), 0);
}

function computeConsecutiveGoalMetDays(params: {
  checkIns: Record<string, number>;
  endYmd: string;
  kind: HabitKind;
  dailyGoal?: number | null;
  maxLookback?: number;
  minYmd?: string | null;
}): number {
  const { checkIns, endYmd, kind, dailyGoal, maxLookback = 999, minYmd } = params;
  let streak = 0;
  let cursor = endYmd;
  for (let i = 0; i < maxLookback; i++) {
    if (minYmd && cursor < minYmd) break;
    const cnt = checkIns[cursor] ?? 0;
    if (!isHabitDayGoalMet({ kind, todayCount: cnt, dailyGoal })) break;
    streak++;
    cursor = addDaysToYmd(cursor, -1);
  }
  return streak;
}

function computeBuildExpectedGoalProgress(params: {
  expectedGoal: BuildHabitExpectedGoal;
  checkIns: Record<string, number>;
  dailyGoal?: number | null;
  endYmd?: string;
  kind?: HabitKind;
}): number {
  const { expectedGoal, checkIns } = params;
  const dailyGoal = params.dailyGoal ?? null;
  const kind = params.kind ?? 'build';
  if (expectedGoal.type === 'days') return countBuildAchievedDays(checkIns, dailyGoal);
  if (expectedGoal.type === 'consecutive_days') {
    let endYmd = params.endYmd?.trim() ?? '';
    if (!endYmd) endYmd = Object.keys(checkIns).sort().at(-1) ?? '';
    if (!endYmd) return 0;
    return computeConsecutiveGoalMetDays({ checkIns, endYmd, kind, dailyGoal });
  }
  return computeTotalCheckInCount(checkIns);
}

function parseBreakHabitCycle(extraData: string | null): { completedAt: string | null } {
  const raw = parseExtraObject(extraData).breakHabitCycle;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { completedAt: null };
  const completedAt = (raw as { completedAt?: unknown }).completedAt;
  if (typeof completedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(completedAt.trim())) {
    return { completedAt: completedAt.trim() };
  }
  return { completedAt: null };
}

function isBreakHabitSucceeded(extraData: string | null): boolean {
  return parseBreakHabitCycle(extraData).completedAt != null;
}

function parseBuildHabitCycle(extraData: string | null): { completedAt: string | null } {
  const raw = parseExtraObject(extraData).buildHabitCycle;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { completedAt: null };
  const completedAt = (raw as { completedAt?: unknown }).completedAt;
  if (typeof completedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(completedAt.trim())) {
    return { completedAt: completedAt.trim() };
  }
  return { completedAt: null };
}

function isBuildHabitSucceeded(extraData: string | null): boolean {
  return parseBuildHabitCycle(extraData).completedAt != null;
}

function parseHabitSchedule(extraData: string | null) {
  const s = parseExtraObject(extraData).schedule;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  return s as { activeTab?: string; selectedDays?: unknown; monthlySpecificDays?: unknown };
}

function isHabitScheduledOnLogicalYmd(extraData: string | null, logicalYmd: string): boolean {
  const schedule = parseHabitSchedule(extraData);
  const tab = schedule?.activeTab;
  if (!tab || typeof tab !== 'string') return true;
  if (tab === '每天' || tab === '每周N天' || tab === '每月N天') return true;
  const d = logicalYmdToLocalDate(logicalYmd);
  if (tab === '每周定期') {
    const selected = Array.isArray(schedule?.selectedDays)
      ? schedule.selectedDays.filter((x): x is string => typeof x === 'string')
      : [];
    if (selected.length === 0) return false;
    return selected.includes(HABIT_CN_WEEKDAY_LABELS[d.getDay()]);
  }
  if (tab === '每月定期') {
    const dom = d.getDate();
    const days = Array.isArray(schedule?.monthlySpecificDays)
      ? schedule.monthlySpecificDays.filter(
          (n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= 31,
        )
      : [];
    if (days.length === 0) return false;
    return days.includes(dom);
  }
  return true;
}

function ymdFromDate(d: Date): string {
  return formatLocalYmdFromDate(d);
}

function parseTaskRepeatPeriod(extraData: string | null): TaskRepeatPeriod {
  const tab = parseExtraObject(extraData).schedule;
  if (!tab || typeof tab !== 'object' || Array.isArray(tab)) return '每月';
  const activeTab = (tab as { activeTab?: unknown }).activeTab;
  const periods: TaskRepeatPeriod[] = ['每日', '每周', '每月', '每年'];
  if (typeof activeTab === 'string' && periods.includes(activeTab as TaskRepeatPeriod)) {
    return activeTab as TaskRepeatPeriod;
  }
  return '每月';
}

function getTaskPeriodRange(logicalYmd: string, period: TaskRepeatPeriod) {
  const d = logicalYmdToLocalDate(logicalYmd);
  if (period === '每日') return { startYmd: logicalYmd, endYmd: logicalYmd };
  if (period === '每周') {
    const monday = startOfWeekMonday(d);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { startYmd: ymdFromDate(monday), endYmd: ymdFromDate(sunday) };
  }
  if (period === '每月') {
    const start = new Date(d.getFullYear(), d.getMonth(), 1, 12, 0, 0, 0);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 12, 0, 0, 0);
    return { startYmd: ymdFromDate(start), endYmd: ymdFromDate(end) };
  }
  const start = new Date(d.getFullYear(), 0, 1, 12, 0, 0, 0);
  const end = new Date(d.getFullYear(), 11, 31, 12, 0, 0, 0);
  return { startYmd: ymdFromDate(start), endYmd: ymdFromDate(end) };
}

function filterCheckInsInRange(
  checkIns: Record<string, number>,
  startYmd: string,
  endYmd: string,
  asOfYmd?: string,
): Record<string, number> {
  const effectiveEnd = asOfYmd && asOfYmd < endYmd ? asOfYmd : endYmd;
  const out: Record<string, number> = {};
  for (const [ymd, count] of Object.entries(checkIns)) {
    if (ymd >= startYmd && ymd <= effectiveEnd) out[ymd] = count;
  }
  return out;
}

function computeTaskPeriodGoalProgress(params: {
  expectedGoal: BuildHabitExpectedGoal;
  checkIns: Record<string, number>;
  dailyGoal?: number | null;
  logicalYmd: string;
  period: TaskRepeatPeriod;
  asOfYmd?: string;
}): number {
  const { expectedGoal, checkIns, logicalYmd, period, asOfYmd } = params;
  const dailyGoal = params.dailyGoal ?? null;
  const { startYmd, endYmd } = getTaskPeriodRange(logicalYmd, period);
  const periodCheckIns = filterCheckInsInRange(checkIns, startYmd, endYmd, asOfYmd);
  return computeBuildExpectedGoalProgress({ expectedGoal, checkIns: periodCheckIns, dailyGoal });
}

function getTaskHabitTasksViewState(params: {
  extraData: string | null;
  checkIns: Record<string, number>;
  logicalYmd: string;
}) {
  if (parseHabitKind(params.extraData) !== 'task') return null;
  const expectedGoal = parseBuildHabitExpectedGoal(params.extraData);
  if (expectedGoal == null) return null;
  const period = parseTaskRepeatPeriod(params.extraData);
  const dailyGoal = parseHabitDailyGoal(params.extraData, 'task');
  const periodProgress = computeTaskPeriodGoalProgress({
    expectedGoal,
    checkIns: params.checkIns,
    dailyGoal,
    logicalYmd: params.logicalYmd,
    period,
    asOfYmd: params.logicalYmd,
  });
  const { startYmd } = getTaskPeriodRange(params.logicalYmd, period);
  const yesterday = addDaysToLogicalYmd(params.logicalYmd, -1);
  const progressAsOfYesterday =
    yesterday >= startYmd
      ? computeTaskPeriodGoalProgress({
          expectedGoal,
          checkIns: params.checkIns,
          dailyGoal,
          logicalYmd: params.logicalYmd,
          period,
          asOfYmd: yesterday,
        })
      : 0;
  const goalValue = expectedGoal.value;
  const periodGoalMet = periodProgress >= goalValue;
  const wasMetBeforeViewDay = progressAsOfYesterday >= goalValue;
  return {
    periodProgress,
    periodGoal: goalValue,
    showPeriodCheckOnViewDay: periodGoalMet && !wasMetBeforeViewDay,
    hiddenOnViewDay: wasMetBeforeViewDay,
  };
}

function normalizeWeeklyDays(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => (typeof x === 'number' ? Math.round(x) : parseInt(String(x), 10)))
    .filter((n) => n >= 1 && n <= 7);
}

function normalizeMonthlyDays(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => (typeof x === 'number' ? Math.round(x) : parseInt(String(x), 10)))
    .filter((n) => n >= 1 && n <= 31);
}

function parseWeeklyDaysFromRepeatText(repeat: string): number[] {
  const days: number[] = [];
  for (const [label, value] of Object.entries(CN_WEEKDAY_TO_MON1)) {
    if (repeat.includes(label)) days.push(value);
  }
  return days;
}

function parseMonthlyDaysFromRepeatText(repeat: string): number[] {
  const m = repeat.match(/每月\s*([\d、,，\s]+)/);
  if (!m) return [];
  return m[1]
    .split(/[、,，\s]+/)
    .map((s) => parseInt(s.replace(/日/g, ''), 10))
    .filter((n) => n >= 1 && n <= 31);
}

function resolveRepeatDayFields(
  repeatOption: TaskRepeatOption,
  schedule: Record<string, unknown>,
  repeatFromRoot: string,
) {
  const repeatSummary = typeof schedule.repeatSummary === 'string' ? schedule.repeatSummary.trim() : '';
  const textFallback = repeatSummary || repeatFromRoot;
  let weeklyDays = normalizeWeeklyDays(schedule.weeklyDays);
  let monthlyDays = normalizeMonthlyDays(schedule.monthlyDays);
  let yearlyDate = typeof schedule.yearlyDate === 'string' ? schedule.yearlyDate.trim() : '';
  if (repeatOption === '每周' && weeklyDays.length === 0 && textFallback) {
    weeklyDays = parseWeeklyDaysFromRepeatText(textFallback);
  }
  if (repeatOption === '每月' && monthlyDays.length === 0 && textFallback) {
    monthlyDays = parseMonthlyDaysFromRepeatText(textFallback);
  }
  if (repeatOption === '每年' && !yearlyDate && textFallback) {
    const m = textFallback.match(/(\d{1,2})月(\d{1,2})日/);
    if (m) {
      yearlyDate = `2000-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
    }
  }
  return { weeklyDays, monthlyDays, yearlyDate };
}

export function parseTaskRepeatSchedule(extraData: string | null): TaskRepeatSchedule | null {
  const root = parseExtraObject(extraData);
  const repeatFromRoot = typeof root.repeat === 'string' ? root.repeat.trim() : '';
  const schedule = root.schedule;
  if (schedule && typeof schedule === 'object' && !Array.isArray(schedule)) {
    const s = schedule as Record<string, unknown>;
    const opt = s.repeatOption;
    if (typeof opt === 'string' && REPEAT_OPTIONS.includes(opt as TaskRepeatOption) && opt !== '不重复') {
      return { repeatOption: opt as TaskRepeatOption, ...resolveRepeatDayFields(opt as TaskRepeatOption, s, repeatFromRoot) };
    }
  }
  const repeat = repeatFromRoot;
  if (!repeat || repeat === '不重复') return null;
  if (repeat === '每天' || repeat.startsWith('每天')) {
    return { repeatOption: '每天', weeklyDays: [], monthlyDays: [], yearlyDate: '' };
  }
  if (repeat.startsWith('每周')) {
    return { repeatOption: '每周', weeklyDays: parseWeeklyDaysFromRepeatText(repeat), monthlyDays: [], yearlyDate: '' };
  }
  if (repeat.startsWith('每月')) {
    return { repeatOption: '每月', weeklyDays: [], monthlyDays: parseMonthlyDaysFromRepeatText(repeat), yearlyDate: '' };
  }
  if (repeat.startsWith('每年')) {
    const m = repeat.match(/(\d{1,2})月(\d{1,2})日/);
    if (m) {
      const mo = String(Number(m[1])).padStart(2, '0');
      const day = String(Number(m[2])).padStart(2, '0');
      return { repeatOption: '每年', weeklyDays: [], monthlyDays: [], yearlyDate: `2000-${mo}-${day}` };
    }
    return { repeatOption: '每年', weeklyDays: [], monthlyDays: [], yearlyDate: '' };
  }
  return null;
}

export function taskHasRepeatingSchedule(extraData: string | null): boolean {
  return parseTaskRepeatSchedule(extraData) != null;
}

function getWeekdayMonAs1(ymd: string): number {
  const d = ymdToLocalDate(ymd);
  if (!d) return 1;
  return ((d.getDay() + 6) % 7) + 1;
}

function getDayOfMonth(ymd: string): number {
  const d = ymdToLocalDate(ymd);
  return d ? d.getDate() : 1;
}

function isTaskRepeatDueOnLogicalDay(logicalYmd: string, schedule: TaskRepeatSchedule): boolean {
  switch (schedule.repeatOption) {
    case '每天':
      return true;
    case '每周':
      return schedule.weeklyDays.length > 0 && schedule.weeklyDays.includes(getWeekdayMonAs1(logicalYmd));
    case '每月':
      return schedule.monthlyDays.length > 0 && schedule.monthlyDays.includes(getDayOfMonth(logicalYmd));
    case '每年': {
      const anchor = schedule.yearlyDate;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return false;
      return logicalYmd.slice(5) === anchor.slice(5);
    }
    default:
      return false;
  }
}

function isTaskDueOverdue(dueYmd: string, isDone: boolean, todayYmd: string): boolean {
  if (isDone || !dueYmd.trim()) return false;
  const due = ymdToLocalDate(dueYmd);
  const today = ymdToLocalDate(todayYmd);
  if (!due || !today) return false;
  return due.getTime() < today.getTime();
}

function isTaskRowOverdue(task: CalendarTaskRow, logicalTodayYmd: string): boolean {
  const isDone = task.status === 'done' || task.status === 'cancelled';
  return isTaskDueOverdue(dueDateYmd(task.due_date), isDone, logicalTodayYmd);
}

function isStandaloneTodoOpen(task: CalendarTaskRow): boolean {
  return isTaskActiveStatus(task.status);
}

function isStandaloneTodoScheduleExpired(task: CalendarTaskRow, logicalTodayYmd: string): boolean {
  if (!isStandaloneTodoOpen(task)) return false;
  const schedule = parseProjectSchedule(task.extra_data);
  if (!schedule) return false;
  if (schedule.mode === 'time' && schedule.range?.start && schedule.range?.end) {
    const start = formatScheduleDateToYMD(schedule.range.start);
    const end = formatScheduleDateToYMD(schedule.range.end);
    return !isLogicalDayInYmdRange(logicalTodayYmd, start, end);
  }
  if (schedule.date) {
    return logicalTodayYmd > formatScheduleDateToYMD(schedule.date);
  }
  return false;
}

function hasMissedRepeatOccurrenceBeforeToday(
  task: CalendarTaskRow,
  logicalTodayYmd: string,
  repeatSchedule: TaskRepeatSchedule,
): boolean {
  const createdYmd = task.created_at?.trim().slice(0, 10) ?? '';
  let cursor = addDaysToYmd(logicalTodayYmd, -1);
  for (let i = 0; i < 400; i += 1) {
    if (createdYmd && /^\d{4}-\d{2}-\d{2}$/.test(createdYmd) && cursor < createdYmd) break;
    if (isTaskRepeatDueOnLogicalDay(cursor, repeatSchedule)) return true;
    cursor = addDaysToYmd(cursor, -1);
  }
  return false;
}

function standaloneTodoPassesDayBoundaryFilter(
  task: CalendarTaskRow,
  boundary: TasksDayBoundary,
  logicalTodayYmd: string,
): boolean {
  if (task.status !== 'done' && task.status !== 'cancelled') return true;
  const raw = task.completed_at?.trim() || task.updated_at?.trim();
  if (!raw) return true;
  const doneLogicalYmd = getLogicalYmdFromCreatedAt(raw, boundary);
  if (!doneLogicalYmd) return true;
  return doneLogicalYmd >= logicalTodayYmd;
}

/**
 * 任务 Tab 独立待办列表：含搁置、未到执行日的重复待办、今日日界内已完成/取消。
 * 已完成且超出日界的不再出现。
 */
export function isStandaloneTodoInTasksPageList(
  task: CalendarTaskRow,
  logicalViewYmd: string,
  boundary: TasksDayBoundary,
): boolean {
  if (task.project_id || task.parent_task_id) return false;
  return standaloneTodoPassesDayBoundaryFilter(task, boundary, logicalViewYmd);
}

function standaloneTodoPassesRepeatDayFilter(task: CalendarTaskRow, logicalTodayYmd: string): boolean {
  if (isTaskShelvedStatus(task.status)) return true;
  const schedule = parseTaskRepeatSchedule(task.extra_data);
  if (!schedule) return true;
  if (isTaskRepeatDueOnLogicalDay(logicalTodayYmd, schedule)) return true;
  if (!isStandaloneTodoOpen(task)) return false;
  if (isTaskRowOverdue(task, logicalTodayYmd)) return true;
  if (isStandaloneTodoScheduleExpired(task, logicalTodayYmd)) return true;
  return hasMissedRepeatOccurrenceBeforeToday(task, logicalTodayYmd, schedule);
}

function standaloneTodoPassesScheduleWindowFilter(task: CalendarTaskRow, logicalTodayYmd: string): boolean {
  if (isTaskShelvedStatus(task.status)) return true;
  if (parseTaskRepeatSchedule(task.extra_data)) return true;
  const schedule = parseProjectSchedule(task.extra_data);
  if (schedule?.mode === 'time' && schedule.range?.start && schedule.range?.end) {
    const start = formatScheduleDateToYMD(schedule.range.start);
    const end = formatScheduleDateToYMD(schedule.range.end);
    if (isLogicalDayInYmdRange(logicalTodayYmd, start, end)) return true;
    return isStandaloneTodoOpen(task) && isStandaloneTodoScheduleExpired(task, logicalTodayYmd);
  }
  if (schedule?.date) {
    const schedYmd = formatScheduleDateToYMD(schedule.date);
    if (logicalTodayYmd === schedYmd) return true;
    return isStandaloneTodoOpen(task) && logicalTodayYmd > schedYmd;
  }
  return true;
}

export function isStandaloneTodoVisibleOnDay(
  task: CalendarTaskRow,
  logicalViewYmd: string,
  boundary: TasksDayBoundary,
): boolean {
  if (task.project_id || task.parent_task_id) return false;
  return (
    standaloneTodoPassesDayBoundaryFilter(task, boundary, logicalViewYmd) &&
    standaloneTodoPassesRepeatDayFilter(task, logicalViewYmd) &&
    standaloneTodoPassesScheduleWindowFilter(task, logicalViewYmd)
  );
}

/** 与客户端 sortStandaloneTodosLocally 一致：活跃 → 搁置 → 终态，组内 created_at ASC */
export function sortStandaloneTodos<T extends { status?: string; created_at?: string; id?: string }>(
  rows: T[],
): T[] {
  const isDoneRow = (t: T) => t.status === 'done' || t.status === 'cancelled';
  const createdMs = (t: T) => Date.parse(t.created_at ?? '') || 0;

  return rows.slice().sort((a, b) => {
    const da = isDoneRow(a);
    const db = isDoneRow(b);
    if (da !== db) return da ? 1 : -1;

    const sa = a.status === 'shelved';
    const sb = b.status === 'shelved';
    if (sa !== sb) return sa ? 1 : -1;

    const ca = createdMs(a);
    const cb = createdMs(b);
    if (ca !== cb) return ca - cb;

    return String(a.id ?? '').localeCompare(String(b.id ?? ''));
  });
}

function isStandaloneCalendarTask(task: CalendarTaskRow): boolean {
  return !task.project_id && !task.parent_task_id;
}

function todoCalendarSortRank(reason: TodoCalendarDayReason | undefined): number {
  if (reason === 'due') return 0;
  if (reason === 'completed-and-due') return 1;
  return 2;
}

function taskCompletedOnLogicalDay(
  task: CalendarTaskRow,
  ymd: string,
  boundary: TasksDayBoundary,
): boolean {
  if (!isTaskTerminalStatus(task.status)) return false;
  const raw = task.completed_at?.trim() || task.updated_at?.trim();
  if (!raw) return false;
  return getLogicalYmdFromCreatedAt(raw, boundary) === ymd;
}

export function isHabitVisibleOnCalendarDay(
  habitCreatedAt: string | null | undefined,
  viewYmd: string,
  boundary: TasksDayBoundary,
): boolean {
  if (!habitCreatedAt?.trim()) return true;
  const createdYmd = getLogicalYmdFromCreatedAt(habitCreatedAt, boundary);
  if (!createdYmd) return true;
  return viewYmd >= createdYmd;
}

function truthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function parseSubHabitIds(extraData: string | null): string[] {
  const raw = parseExtraObject(extraData).subHabits;
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) {
      ids.push(item.trim());
      continue;
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const id = rec.id ?? rec.key;
      if (typeof id === 'string' && id.trim()) ids.push(id.trim());
    }
  }
  return ids;
}

function isSubHabitCheckedOnDay(checkIns: unknown, subId: string, ymd: string): boolean {
  if (!checkIns || typeof checkIns !== 'object' || Array.isArray(checkIns)) return false;
  const obj = checkIns as Record<string, unknown>;

  const byDay = obj[ymd];
  if (Array.isArray(byDay)) return byDay.map(String).includes(subId);
  if (byDay && typeof byDay === 'object' && !Array.isArray(byDay)) {
    return truthyFlag((byDay as Record<string, unknown>)[subId]);
  }

  const bySub = obj[subId];
  if (Array.isArray(bySub)) return bySub.map(String).includes(ymd);
  if (bySub && typeof bySub === 'object' && !Array.isArray(bySub)) {
    return truthyFlag((bySub as Record<string, unknown>)[ymd]);
  }
  return false;
}

/** 子习惯未全完成时父习惯不得显示完成；未启用子习惯时返回 null */
export function areSubHabitsCompleteForDay(extraData: string | null, logicalYmd: string): boolean | null {
  const extra = parseExtraObject(extraData);
  if (extra.subHabitsEnabled !== true && extra.subHabitsEnabled !== 1 && extra.subHabitsEnabled !== 'true') {
    return null;
  }
  const ids = parseSubHabitIds(extraData);
  if (ids.length === 0) return null;
  return ids.every((id) => isSubHabitCheckedOnDay(extra.subHabitCheckIns, id, logicalYmd));
}

function isCalendarHabitGoalMet(habit: TasksCalendarHabitItem): boolean {
  if (habit.kind === 'break' && habit.hasDayRecord !== true) return false;
  return isHabitDayGoalMet({
    kind: habit.kind,
    todayCount: habit.todayCount,
    dailyGoal: habit.dailyGoal,
  });
}

export function emptyGridDay(ymd: string): TasksCalendarGridDay {
  return {
    ymd,
    level: 0,
    frogs: 0,
    openTodos: 0,
    habits: 0,
    projectsDue: 0,
    frogDone: false,
    habitChecked: false,
    dueCount: 0,
  };
}

export function getTasksCalendarCellLevel(
  summary: TasksCalendarDaySummary | undefined,
  logicalTodayYmd?: string,
): 0 | 1 | 2 | 3 | 4 {
  if (!summary) return 0;
  const openTasks =
    summary.frogs.filter((t) => isTaskActiveStatus(t.status)).length +
    summary.standaloneTodos.filter((t) => isTaskActiveStatus(t.status)).length +
    summary.matrixTasks.filter((t) => isTaskActiveStatus(t.status)).length;
  const dueOpen = summary.dueTasks.filter((t) => isTaskActiveStatus(t.status)).length;
  const habitDue = summary.habits.length;
  const habitDone = summary.habits.filter((h) => isCalendarHabitGoalMet(h)).length;
  const frogDone = summary.frogs.filter((t) => t.status === 'done').length;
  const score = openTasks + dueOpen + habitDue + frogDone + habitDone + summary.projectsDue.length;
  if (score <= 0) return 0;
  if (score === 1) return 1;
  if (score <= 3) return 2;
  if (score <= 6) return 3;
  return 4;
}

export function daySummaryToGridDay(
  summary: TasksCalendarDaySummary,
  logicalTodayYmd?: string,
): TasksCalendarGridDay {
  return {
    ymd: summary.ymd,
    level: getTasksCalendarCellLevel(summary, logicalTodayYmd),
    frogs: summary.frogs.length,
    openTodos:
      summary.standaloneTodos.filter((t) => isTaskActiveStatus(t.status)).length +
      summary.matrixTasks.filter((t) => isTaskActiveStatus(t.status)).length,
    habits: summary.habits.length,
    projectsDue: summary.projectsDue.length,
    frogDone: summary.frogs.some((f) => f.status === 'done'),
    habitChecked: summary.habits.some((h) => h.todayCount > 0),
    dueCount: summary.dueTasks.length,
  };
}

export function projectCalendarDaysToGrid(
  days: Record<string, TasksCalendarDaySummary>,
  logicalTodayYmd?: string,
): Record<string, TasksCalendarGridDay> {
  const out: Record<string, TasksCalendarGridDay> = {};
  for (const [ymd, summary] of Object.entries(days)) {
    out[ymd] = daySummaryToGridDay(summary, logicalTodayYmd);
  }
  return out;
}

export function buildTasksCalendarSummaries(params: {
  startYmd: string;
  endYmd: string;
  tasks: CalendarTaskRow[];
  habits: CalendarHabitRow[];
  projects: CalendarProjectRow[];
  habitCheckInsByDay: Map<string, Map<string, number>>;
  dayBoundary: TasksDayBoundary;
  logicalTodayYmd: string;
  frogCompletedTaskIdsByDay: Map<string, Set<string>>;
  standaloneCompletedTaskIdsByDay: Map<string, Set<string>>;
}): Record<string, TasksCalendarDaySummary> {
  const {
    startYmd,
    endYmd,
    tasks,
    habits,
    projects,
    habitCheckInsByDay,
    dayBoundary,
    logicalTodayYmd,
    frogCompletedTaskIdsByDay,
    standaloneCompletedTaskIdsByDay,
  } = params;
  const days: Record<string, TasksCalendarDaySummary> = {};

  let cursor = startYmd;
  while (cursor <= endYmd) {
    days[cursor] = emptyDay(cursor);
    cursor = addDaysToYmd(cursor, 1);
  }

  for (const task of tasks) {
    const due = dueDateYmd(task.due_date);
    if (due && due >= startYmd && due <= endYmd) {
      const day = days[due]!;
      const item = toTaskItem(task, 'due');
      if (!day.dueTasks.some((x) => x.id === item.id)) day.dueTasks.push(item);
      if (isMatrixTask(task) && !day.matrixTasks.some((x) => x.id === item.id)) {
        day.matrixTasks.push({ ...item, kind: 'matrix' });
      }
    }

    for (const frogOn of getFrogAssignedDates(task)) {
      if (frogOn < startYmd || frogOn > endYmd) continue;
      const day = days[frogOn]!;
      const item: TasksCalendarTaskItem = {
        ...toTaskItem(task, 'frog'),
        frogDayStatus: resolveFrogCalendarDayStatus({
          taskStatus: task.status,
          viewYmd: frogOn,
          logicalTodayYmd,
          hasCompletionEvent: frogCompletedTaskIdsByDay.get(frogOn)?.has(task.id) === true,
          frogSessionCompletedOn: getFrogSessionCompletedOn(task.extra_data),
        }),
      };
      if (!day.frogs.some((x) => x.id === item.id)) day.frogs.push(item);
    }
  }

  const habitCheckInsByHabit = new Map<string, Record<string, number>>();
  for (const [dayYmd, dayMap] of habitCheckInsByDay) {
    for (const [habitId, count] of dayMap) {
      const prev = habitCheckInsByHabit.get(habitId) ?? {};
      prev[dayYmd] = count;
      habitCheckInsByHabit.set(habitId, prev);
    }
  }

  const standaloneTasks = tasks.filter(isStandaloneCalendarTask);

  for (let ymd = startYmd; ymd <= endYmd; ymd = addDaysToYmd(ymd, 1)) {
    const day = days[ymd]!;
    const checkMap = habitCheckInsByDay.get(ymd) ?? new Map<string, number>();
    const frogIds = new Set(day.frogs.map((f) => f.id));
    const completedIds = standaloneCompletedTaskIdsByDay.get(ymd) ?? new Set<string>();

    for (const habit of habits) {
      const kind = parseHabitKind(habit.extra_data);
      if (kind === 'break' && isBreakHabitSucceeded(habit.extra_data)) continue;
      if (kind === 'build' && isBuildHabitSucceeded(habit.extra_data)) continue;
      if (!isHabitVisibleOnCalendarDay(habit.created_at, ymd, dayBoundary)) continue;
      const checkIns = habitCheckInsByHabit.get(habit.id) ?? {};
      const taskViewState =
        kind === 'task'
          ? getTaskHabitTasksViewState({ extraData: habit.extra_data, checkIns, logicalYmd: ymd })
          : null;
      if (taskViewState?.hiddenOnViewDay) continue;
      if (!isHabitScheduledOnLogicalYmd(habit.extra_data, ymd)) continue;
      const hasDayRecord = checkMap.has(habit.id);
      const count = hasDayRecord ? (checkMap.get(habit.id) ?? 0) : 0;
      const dailyGoal = parseHabitDailyGoal(habit.extra_data, kind);
      const habitItem: TasksCalendarHabitItem = {
        id: habit.id,
        name: habit.name,
        icon: habit.icon,
        todayCount: count,
        dailyGoal,
        kind,
        periodProgress: taskViewState?.periodProgress ?? null,
        periodGoal: taskViewState?.periodGoal ?? null,
        taskShowPeriodCheck: taskViewState?.showPeriodCheckOnViewDay ?? false,
        ...(kind === 'break' ? { hasDayRecord } : {}),
      };
      day.habits.push(habitItem);
    }

    const standaloneItems: TasksCalendarTaskItem[] = [];
    for (const task of standaloneTasks) {
      if (frogIds.has(task.id)) continue;
      const dueOnDay = dueDateYmd(task.due_date) === ymd;
      const completedOnDay =
        completedIds.has(task.id) || taskCompletedOnLogicalDay(task, ymd, dayBoundary);
      if (!completedOnDay && !dueOnDay) continue;
      let todoDayReason: TodoCalendarDayReason;
      if (completedOnDay && dueOnDay) todoDayReason = 'completed-and-due';
      else if (completedOnDay) todoDayReason = 'completed';
      else todoDayReason = 'due';
      standaloneItems.push({ ...toTaskItem(task, 'standalone'), todoDayReason });
    }
    standaloneItems.sort((a, b) => {
      const rankDiff = todoCalendarSortRank(a.todoDayReason) - todoCalendarSortRank(b.todoDayReason);
      if (rankDiff !== 0) return rankDiff;
      return b.priority - a.priority;
    });
    day.standaloneTodos = standaloneItems;

    for (const task of tasks) {
      if (isMatrixTask(task) && task.status !== 'done' && task.status !== 'cancelled') {
        const due = dueDateYmd(task.due_date);
        if (due === ymd) continue;
        const schedule = parseProjectSchedule(task.extra_data);
        let onDay = false;
        if (schedule?.mode === 'time' && schedule.range?.start && schedule.range?.end) {
          const start = formatScheduleDateToYMD(schedule.range.start);
          const end = formatScheduleDateToYMD(schedule.range.end);
          onDay = isLogicalDayInYmdRange(ymd, start, end);
        } else if (schedule?.date) {
          onDay = ymd === formatScheduleDateToYMD(schedule.date);
        }
        if (onDay) {
          const item = toTaskItem(task, 'matrix');
          if (!day.matrixTasks.some((x) => x.id === item.id)) day.matrixTasks.push(item);
        }
      }
    }

    for (const project of projects) {
      const due = dueDateYmd(project.due_date);
      if (due === ymd && project.status !== 'archived') {
        day.projectsDue.push({ id: project.id, name: project.name, status: project.status });
      }
    }
  }

  return days;
}

export type HabitsGridItem = {
  id: string;
  name: string;
  icon: string;
  note: string;
  kind: HabitKind;
  rewardPoints: number;
  todayCount: number;
  dailyGoal: number | null;
  displayCompleted: boolean;
  hiddenOnViewDay: boolean;
  periodProgress: number | null;
  periodGoal: number | null;
  extra_data: string | null;
  context: string | null;
};

export function buildHabitsGridItemsForDay(params: {
  logicalYmd: string;
  habits: (CalendarHabitRow & { context?: string | null })[];
  habitCheckInsByHabit: Map<string, Record<string, number>>;
  todayCheckIns: Map<string, number>;
  dayBoundary?: TasksDayBoundary;
}): HabitsGridItem[] {
  const { logicalYmd, habits, habitCheckInsByHabit, todayCheckIns } = params;
  const boundary = params.dayBoundary ?? DEFAULT_TASKS_DAY_BOUNDARY;
  const items: HabitsGridItem[] = [];

  for (const habit of habits) {
    const kind = parseHabitKind(habit.extra_data);
    const extraData = extraDataToString(habit.extra_data);
    if (kind === 'break' && isBreakHabitSucceeded(extraData)) continue;
    if (kind === 'build' && isBuildHabitSucceeded(extraData)) continue;
    const checkIns = habitCheckInsByHabit.get(habit.id) ?? {};
    const taskViewState =
      kind === 'task'
        ? getTaskHabitTasksViewState({ extraData, checkIns, logicalYmd })
        : null;
    const createdLater = !isHabitVisibleOnCalendarDay(habit.created_at, logicalYmd, boundary);
    // 周期已在查看日前达标：不进格子。创建日之后才显示的习惯仍返回，供 APP upsert extra_data
    if (taskViewState?.hiddenOnViewDay && !createdLater) continue;
    if (!createdLater && !isHabitScheduledOnLogicalYmd(extraData, logicalYmd)) continue;

    const count = todayCheckIns.get(habit.id) ?? 0;
    const dailyGoal = parseHabitDailyGoal(extraData, kind);
    // 任务型：打勾只看周期目标，不用「今日有 1 次打卡」当完成
    let displayCompleted =
      kind === 'task'
        ? Boolean(taskViewState?.showPeriodCheckOnViewDay)
        : isHabitDayGoalMet({ kind, todayCount: count, dailyGoal });
    if (createdLater) displayCompleted = false;
    const subHabitsComplete = areSubHabitsCompleteForDay(extraData, logicalYmd);
    if (subHabitsComplete === false) displayCompleted = false;

    items.push({
      id: habit.id,
      name: habit.name,
      icon: habit.icon,
      note: habit.note == null ? '' : String(habit.note),
      kind,
      rewardPoints: parseHabitRewardPoints(extraData),
      todayCount: count,
      dailyGoal,
      displayCompleted,
      hiddenOnViewDay: createdLater,
      periodProgress: taskViewState?.periodProgress ?? null,
      periodGoal: taskViewState?.periodGoal ?? null,
      extra_data: extraData,
      context: habit.context == null || habit.context === '' ? null : String(habit.context),
    });
  }

  return items;
}
