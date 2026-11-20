/**
 * 复盘「今日事实」聚合：健康摄入/体重、青蛙/待办/习惯、财务汇总。
 * 对齐 App `loadReviewDayFacts` 口径，供 Agent 只读与 fill-empty 写入。
 */
import type { RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import {
  collectFrogAssignedDates,
  isStandaloneTodoVisibleOnDay,
} from './calendar/aggregation.js';
import { getLogicalYmdFromCreatedAt } from './calendar/logical-day.js';
import {
  DEFAULT_TASKS_DAY_BOUNDARY,
  type CalendarTaskRow,
  type TasksDayBoundary,
} from './calendar/types.js';
import { getDayHealthMetrics } from './health.js';
import { getTableMeta } from './crud.js';
import { logicalDaySql } from './pages/finance.js';
import { ReviewPageError, resolveReviewLogicalToday } from './pages/review.js';
import { getDayBoundarySettings } from './pages/day-boundary-settings.js';
import { addDaysToYmd, isValidYmd } from '../utils/ymd.js';
import { parseExtraObject } from '../utils/schedule-meta.js';

export { ReviewPageError as ReviewFactsError };

const REVIEW_BODY_VERSION = 2;

export type ReviewFactsScope = 'daily' | 'weekly' | 'monthly';

export type ReviewDayFactItem = {
  kind: 'frog' | 'todo' | 'habit';
  id: string;
  title: string;
  done: boolean;
  count?: number;
};

export type ReviewDayFacts = {
  frogs: ReviewDayFactItem[];
  todos: ReviewDayFactItem[];
  habits: ReviewDayFactItem[];
  health: {
    hydration: number;
    protein: number;
    carbohydrate: number;
    calories: number;
    targetHydration: number;
    targetProtein: number;
    targetCarbohydrate: number;
    targetCalories: number;
    weightKg: number | null;
  };
  finance: {
    income: number;
    expense: number;
    net: number;
    txns: {
      id: string;
      name: string;
      typeLabel: string;
      amount: number;
      category: string;
      note: string;
    }[];
  };
};

const BUILTIN_COLUMN_IDS: Record<
  ReviewFactsScope,
  { health: string; tasks: string; finance: string; routine: string; defects: string; ideas: string }
> = {
  daily: {
    health: 'rc_daily_health',
    tasks: 'rc_daily_tasks',
    finance: 'rc_daily_finance',
    routine: 'rc_daily_routine',
    defects: 'rc_daily_defects',
    ideas: 'rc_daily_ideas',
  },
  weekly: {
    health: 'rc_weekly_health',
    tasks: 'rc_weekly_tasks',
    finance: 'rc_weekly_finance',
    routine: 'rc_weekly_routine',
    defects: 'rc_weekly_defects',
    ideas: 'rc_weekly_ideas',
  },
  monthly: {
    health: 'rc_monthly_health',
    tasks: 'rc_monthly_tasks',
    finance: 'rc_monthly_finance',
    routine: 'rc_monthly_routine',
    defects: 'rc_monthly_defects',
    ideas: 'rc_monthly_ideas',
  },
};

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'] as const;

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function activeWhereSql(columns: Set<string>, alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  const parts: string[] = [];
  if (columns.has('deleted_at')) parts.push(`${prefix}deleted_at IS NULL`);
  if (columns.has('sync_status')) {
    parts.push(`(${prefix}sync_status IS NULL OR ${prefix}sync_status != 'pending_delete')`);
  }
  return parts.length > 0 ? parts.join(' AND ') : '1=1';
}

function requireYmd(value: string | undefined, field = 'ymd'): string {
  const raw = value?.trim() ?? '';
  if (!raw || !isValidYmd(raw)) {
    throw new ReviewPageError(`${field} 须为 YYYY-MM-DD`);
  }
  return raw;
}

function formatMoney(n: number): string {
  const abs = Math.abs(n);
  const rounded = Math.round(abs * 100) / 100;
  const body = Number.isInteger(rounded) ? String(Math.round(rounded)) : rounded.toFixed(2);
  return `¥${body}`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function txnTypeLabel(type: string): string {
  if (type === 'income') return '收入';
  if (type === 'expense') return '支出';
  if (type === 'transfer') return '转账';
  return type || '流水';
}

function emptyFacts(): ReviewDayFacts {
  return {
    frogs: [],
    todos: [],
    habits: [],
    health: {
      hydration: 0,
      protein: 0,
      carbohydrate: 0,
      calories: 0,
      targetHydration: 2500,
      targetProtein: 80,
      targetCarbohydrate: 250,
      targetCalories: 2000,
      weightKg: null,
    },
    finance: { income: 0, expense: 0, net: 0, txns: [] },
  };
}

function isHabitScheduledOnLogicalYmd(extraData: string | null, logicalYmd: string): boolean {
  const schedule = parseExtraObject(extraData).schedule as
    | { activeTab?: string; selectedDays?: unknown; monthlySpecificDays?: unknown }
    | undefined;
  const tab = schedule?.activeTab;
  if (!tab || typeof tab !== 'string') return true;
  if (tab === '每天' || tab === '每周N天' || tab === '每月N天') return true;
  const parts = logicalYmd.split('-').map(Number);
  const d = new Date(parts[0]!, parts[1]! - 1, parts[2]!);
  const cnLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;
  if (tab === '每周定期') {
    const selected = Array.isArray(schedule?.selectedDays)
      ? schedule.selectedDays.filter((x): x is string => typeof x === 'string')
      : [];
    if (selected.length === 0) return false;
    return selected.includes(cnLabels[d.getDay()]);
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

function parseHabitKind(extraData: string | null): 'build' | 'break' | 'task' {
  const kind = parseExtraObject(extraData).habitKind;
  if (kind === 'break') return 'break';
  if (kind === 'task') return 'task';
  return 'build';
}

function parseHabitDailyGoal(extraData: string | null, kind: 'build' | 'break' | 'task'): number | null {
  const q = parseExtraObject(extraData).quantify as { dailyGoal?: unknown } | undefined;
  const g = q?.dailyGoal;
  if (g === null || g === undefined) return kind === 'break' ? 0 : null;
  let numeric: number | null = null;
  if (typeof g === 'number' && Number.isFinite(g)) numeric = g;
  else if (typeof g === 'string' && g.trim() !== '') {
    const n = Number(g);
    if (Number.isFinite(n)) numeric = n;
  }
  if (numeric == null) return kind === 'break' ? 0 : null;
  const rounded = Math.min(99, Math.max(0, Math.round(numeric)));
  if ((kind === 'build' || kind === 'task') && rounded <= 0) return null;
  return rounded;
}

function isHabitDayDone(params: {
  kind: 'build' | 'break' | 'task';
  todayCount: number;
  dailyGoal: number | null;
  hasDayRecord: boolean;
}): boolean {
  const count = Math.max(0, Math.floor(params.todayCount));
  const dailyGoal = params.dailyGoal ?? (params.kind === 'break' ? 0 : null);
  if (params.kind === 'break') {
    const threshold = dailyGoal ?? 0;
    if (threshold <= 0) return count === 0;
    return count < threshold;
  }
  if (dailyGoal != null) return count >= dailyGoal;
  return params.hasDayRecord && count > 0;
}

async function resolveTasksBoundary(): Promise<TasksDayBoundary> {
  try {
    const settings = await getDayBoundarySettings();
    return settings.tasksEffective ?? DEFAULT_TASKS_DAY_BOUNDARY;
  } catch {
    return DEFAULT_TASKS_DAY_BOUNDARY;
  }
}

export async function loadReviewDayFacts(ymd: string): Promise<ReviewDayFacts> {
  const day = requireYmd(ymd);
  const boundary = await resolveTasksBoundary();
  const out = emptyFacts();

  const [healthMetrics, weightRows, taskMeta, habitMeta, hciMeta, txnMeta, catMeta] =
    await Promise.all([
      getDayHealthMetrics({ date: day }).catch(() => null),
      db
        .query<RowDataPacket[]>(
          `SELECT weight_kg FROM weight_logs
           WHERE recorded_ymd = ?
             AND (sync_status IS NULL OR sync_status != 'pending_delete')
           LIMIT 1`,
          [day],
        )
        .then(([rows]) => rows)
        .catch(() => [] as RowDataPacket[]),
      getTableMeta('tasks'),
      getTableMeta('habits'),
      getTableMeta('habit_check_ins'),
      getTableMeta('finance_transactions'),
      getTableMeta('finance_flow_categories'),
    ]);

  if (healthMetrics) {
    out.health.hydration = Number(healthMetrics.intake.hydration ?? 0);
    out.health.protein = Number(healthMetrics.intake.protein ?? 0);
    out.health.carbohydrate = Number(healthMetrics.intake.carbohydrate ?? 0);
    out.health.calories = Number(healthMetrics.intake.calories ?? 0);
    out.health.targetHydration = Number(healthMetrics.targets.target_hydration ?? 2500);
    out.health.targetProtein = Number(healthMetrics.targets.target_protein ?? 80);
    out.health.targetCarbohydrate = Number(healthMetrics.targets.target_carbohydrate ?? 250);
    out.health.targetCalories = Number(healthMetrics.targets.target_calories ?? 2000);
  }
  const weight = Number(weightRows[0]?.weight_kg ?? 0);
  out.health.weightKg = Number.isFinite(weight) && weight > 0 ? weight : null;

  const taskCols = new Set(taskMeta.columns);
  const frogSelect = taskCols.has('frog_assigned_on') ? ', frog_assigned_on' : '';
  const [taskRows] = await db.query<RowDataPacket[]>(
    `SELECT id, project_id, parent_task_id, title, status, priority, completed_at, due_date,
            created_at, updated_at, extra_data${frogSelect}
     FROM ${quoteIdent('tasks')}
     WHERE ${activeWhereSql(taskCols)}`,
  );

  const frogs: ReviewDayFactItem[] = [];
  const todos: ReviewDayFactItem[] = [];
  const seenFrog = new Set<string>();
  const seenTodo = new Set<string>();

  for (const row of taskRows) {
    const id = String(row.id ?? '');
    if (!id) continue;
    const title = String(row.title ?? '').trim() || '未命名';
    const status = String(row.status ?? '');
    const done = status === 'done';
    const frogCol = row.frog_assigned_on == null ? null : String(row.frog_assigned_on);
    if (collectFrogAssignedDates(row.extra_data, frogCol).includes(day)) {
      if (!seenFrog.has(id)) {
        seenFrog.add(id);
        frogs.push({ kind: 'frog', id, title, done });
      }
    }
  }

  for (const row of taskRows) {
    const id = String(row.id ?? '');
    if (!id || seenFrog.has(id) || seenTodo.has(id)) continue;
    const task: CalendarTaskRow = {
      id,
      project_id: row.project_id == null ? null : String(row.project_id),
      parent_task_id: row.parent_task_id == null ? null : String(row.parent_task_id),
      title: String(row.title ?? ''),
      status: String(row.status ?? ''),
      priority: Number(row.priority ?? 0),
      completed_at: row.completed_at == null ? null : String(row.completed_at),
      due_date: row.due_date == null ? null : String(row.due_date),
      created_at: row.created_at == null ? '' : String(row.created_at),
      updated_at: row.updated_at == null ? '' : String(row.updated_at),
      extra_data: row.extra_data == null ? null : String(row.extra_data),
      frog_assigned_on: row.frog_assigned_on == null ? null : String(row.frog_assigned_on),
    };
    if (!isStandaloneTodoVisibleOnDay(task, day, boundary)) continue;
    seenTodo.add(id);
    todos.push({
      kind: 'todo',
      id,
      title: task.title.trim() || '未命名',
      done: task.status === 'done',
    });
  }

  // 当日完成但未进青蛙/待办的项目子任务
  for (const row of taskRows) {
    const id = String(row.id ?? '');
    if (!id || seenFrog.has(id) || seenTodo.has(id)) continue;
    if (String(row.status ?? '') !== 'done') continue;
    const completedAt = row.completed_at == null ? '' : String(row.completed_at).trim();
    if (!completedAt) continue;
    const doneDay =
      getLogicalYmdFromCreatedAt(completedAt, boundary) ??
      completedAt.slice(0, 10);
    if (doneDay !== day) continue;
    if (row.project_id == null && row.parent_task_id == null) continue;
    seenFrog.add(id);
    frogs.push({
      kind: 'frog',
      id,
      title: String(row.title ?? '').trim() || '未命名',
      done: true,
    });
  }

  out.frogs = frogs;
  out.todos = todos;

  const habitCols = new Set(habitMeta.columns);
  const hciCols = new Set(hciMeta.columns);
  const [[habitRows], [checkInRows]] = await Promise.all([
    db.query<RowDataPacket[]>(
      `SELECT id, name, extra_data FROM ${quoteIdent('habits')}
       WHERE ${activeWhereSql(habitCols)}`,
    ),
    db.query<RowDataPacket[]>(
      `SELECT habit_id, count FROM ${quoteIdent('habit_check_ins')}
       WHERE ${activeWhereSql(hciCols)}
         AND record_date = ?`,
      [day],
    ),
  ]);
  const checkInByHabit = new Map<string, number>();
  for (const row of checkInRows) {
    const hid = String(row.habit_id ?? '');
    if (!hid) continue;
    checkInByHabit.set(hid, Math.max(0, Math.floor(Number(row.count ?? 0))));
  }
  const habits: ReviewDayFactItem[] = [];
  for (const h of habitRows) {
    const id = String(h.id ?? '');
    if (!id) continue;
    const extra = h.extra_data == null ? null : String(h.extra_data);
    if (!isHabitScheduledOnLogicalYmd(extra, day)) continue;
    const kind = parseHabitKind(extra);
    const hasDayRecord = checkInByHabit.has(id);
    const todayCount = checkInByHabit.get(id) ?? 0;
    const dailyGoal = parseHabitDailyGoal(extra, kind);
    habits.push({
      kind: 'habit',
      id,
      title: String(h.name ?? '').trim() || '未命名习惯',
      done: isHabitDayDone({ kind, todayCount, dailyGoal, hasDayRecord }),
      count: todayCount > 0 ? todayCount : undefined,
    });
  }
  out.habits = habits;

  const txnCols = new Set(txnMeta.columns);
  const catCols = new Set(catMeta.columns);
  const dayExpr = logicalDaySql(boundary);
  const [[txnRows], [catRows]] = await Promise.all([
    db.query<RowDataPacket[]>(
      `SELECT id, name, amount, transaction_type, note, flow_category_id
       FROM ${quoteIdent('finance_transactions')}
       WHERE ${activeWhereSql(txnCols)}
         AND ${dayExpr} = ?
       ORDER BY happened_at DESC, id DESC
       LIMIT 80`,
      [day],
    ),
    db.query<RowDataPacket[]>(
      `SELECT id, name FROM ${quoteIdent('finance_flow_categories')}
       WHERE ${activeWhereSql(catCols)}`,
    ),
  ]);
  const catMap = new Map(
    catRows.map((c) => [String(c.id), String(c.name ?? '').trim()]),
  );
  let income = 0;
  let expense = 0;
  for (const t of txnRows) {
    const type = String(t.transaction_type ?? '').trim();
    const amount = Number(t.amount ?? 0);
    if (type === 'income') income += Math.abs(amount);
    else if (type === 'expense') expense += Math.abs(amount);
    const catId = t.flow_category_id == null ? '' : String(t.flow_category_id);
    out.finance.txns.push({
      id: String(t.id ?? ''),
      name: String(t.name ?? '').trim() || '未命名',
      typeLabel: txnTypeLabel(type),
      amount,
      category: catId ? catMap.get(catId) ?? '' : '',
      note: String(t.note ?? '').trim(),
    });
  }
  out.finance.income = income;
  out.finance.expense = expense;
  out.finance.net = income - expense;

  return out;
}

function hasHealthFacts(facts: ReviewDayFacts): boolean {
  const h = facts.health;
  return (
    h.weightKg != null ||
    h.hydration > 0 ||
    h.protein > 0 ||
    h.carbohydrate > 0 ||
    h.calories > 0
  );
}

function hasTaskFacts(facts: ReviewDayFacts): boolean {
  return facts.frogs.length > 0 || facts.todos.length > 0 || facts.habits.length > 0;
}

function hasFinanceFacts(facts: ReviewDayFacts): boolean {
  const f = facts.finance;
  return f.txns.length > 0 || f.income > 0 || f.expense > 0;
}

export function reviewDayFactsIsEmpty(facts: ReviewDayFacts): boolean {
  return !hasHealthFacts(facts) && !hasTaskFacts(facts) && !hasFinanceFacts(facts);
}

function scopeIntakeTitle(scope: ReviewFactsScope): string {
  if (scope === 'weekly') return '本周摄入汇总';
  if (scope === 'monthly') return '本月摄入汇总';
  return '摄入汇总';
}

function scopeFinanceTitle(scope: ReviewFactsScope): string {
  if (scope === 'weekly') return '本周汇总';
  if (scope === 'monthly') return '本月汇总';
  return '当日汇总';
}

function scopeEmptyIntake(scope: ReviewFactsScope): string {
  if (scope === 'weekly') return '本周暂无摄入数据';
  if (scope === 'monthly') return '本月暂无摄入数据';
  return '今日暂无摄入数据';
}

function formatDoneSection(
  title: string,
  items: ReviewDayFactItem[],
  labelDone: string,
  labelTodo: string,
): string[] {
  const done = items.filter((i) => i.done);
  const pending = items.filter((i) => !i.done);
  const lines: string[] = [`【${title}】`];
  lines.push(`${labelDone}（${done.length}）`);
  if (done.length === 0) lines.push('· （无）');
  else {
    for (const i of done) {
      const count = i.count != null && i.count > 1 ? ` ×${i.count}` : '';
      lines.push(`· ${i.title}${count}`);
    }
  }
  lines.push(`${labelTodo}（${pending.length}）`);
  if (pending.length === 0) lines.push('· （无）');
  else {
    for (const i of pending) {
      const count = i.count != null && i.count > 1 ? ` ×${i.count}` : '';
      lines.push(`· ${i.title}${count}`);
    }
  }
  return lines;
}

export function formatHealthFactsText(
  facts: ReviewDayFacts,
  scope: ReviewFactsScope = 'daily',
): string {
  const h = facts.health;
  const lines: string[] = [`【${scopeIntakeTitle(scope)}】`];
  const hasIntake = h.hydration > 0 || h.protein > 0 || h.carbohydrate > 0 || h.calories > 0;
  if (hasIntake) {
    if (scope === 'daily') {
      lines.push(
        `水分 ${round1(h.hydration)}/${h.targetHydration}ml · 蛋白 ${round1(h.protein)}/${h.targetProtein}g · 碳水 ${round1(h.carbohydrate)}/${h.targetCarbohydrate}g · 热量 ${Math.round(h.calories)}/${h.targetCalories}kcal`,
      );
    } else {
      lines.push(
        `水分 ${round1(h.hydration)}ml · 蛋白 ${round1(h.protein)}g · 碳水 ${round1(h.carbohydrate)}g · 热量 ${Math.round(h.calories)}kcal`,
      );
    }
  } else {
    lines.push(scopeEmptyIntake(scope));
  }
  if (h.weightKg != null) lines.push(`体重：${h.weightKg}kg`);
  return lines.join('\n').trim();
}

export function formatTasksFactsText(
  facts: ReviewDayFacts,
  scope: ReviewFactsScope = 'daily',
): string {
  const habitDoneLabel = scope === 'daily' ? '已打卡' : '有打卡';
  const habitTodoLabel = scope === 'daily' ? '未打卡' : '零打卡';
  const blocks = [
    formatDoneSection('任务（青蛙）', facts.frogs, '已完成', '未完成'),
    formatDoneSection('待办', facts.todos, '已完成', '未完成'),
    formatDoneSection('小习惯', facts.habits, habitDoneLabel, habitTodoLabel),
  ];
  return blocks.map((b) => b.join('\n')).join('\n\n').trim();
}

export function formatFinanceFactsText(
  facts: ReviewDayFacts,
  scope: ReviewFactsScope = 'daily',
): string {
  const f = facts.finance;
  const lines: string[] = ['【财务】'];
  lines.push(
    `${scopeFinanceTitle(scope)}：收入 ${formatMoney(f.income)} · 支出 ${formatMoney(f.expense)} · 净额 ${formatMoney(f.net)}`,
  );
  if (f.txns.length > 0) {
    lines.push('');
    lines.push('流水：');
    for (const t of f.txns) {
      const cat = t.category ? ` ${t.category}` : '';
      const note = t.note ? ` · ${t.note}` : '';
      lines.push(`· ${t.typeLabel}${cat} ${t.name} ${formatMoney(t.amount)}${note}`);
    }
  } else {
    lines.push('流水：· （无）');
  }
  return lines.join('\n').trim();
}

export function builtinReviewFactsFieldPatch(
  scope: ReviewFactsScope,
  facts: ReviewDayFacts,
): Record<string, string> {
  const ids = BUILTIN_COLUMN_IDS[scope];
  const patch: Record<string, string> = {};
  if (hasHealthFacts(facts)) patch[ids.health] = formatHealthFactsText(facts, scope);
  if (hasTaskFacts(facts)) patch[ids.tasks] = formatTasksFactsText(facts, scope);
  if (hasFinanceFacts(facts)) patch[ids.finance] = formatFinanceFactsText(facts, scope);
  return patch;
}

export function reviewFactsTextForColumn(
  facts: ReviewDayFacts,
  scope: ReviewFactsScope,
  columnId: string,
): string | null {
  const ids = BUILTIN_COLUMN_IDS[scope];
  if (columnId === ids.health) {
    return hasHealthFacts(facts) ? formatHealthFactsText(facts, scope) : null;
  }
  if (columnId === ids.tasks) {
    return hasTaskFacts(facts) ? formatTasksFactsText(facts, scope) : null;
  }
  if (columnId === ids.finance) {
    return hasFinanceFacts(facts) ? formatFinanceFactsText(facts, scope) : null;
  }
  return null;
}

export function reviewDayFactsPreviewLines(facts: ReviewDayFacts): string[] {
  const out: string[] = [];
  const h = facts.health;
  if (h.calories > 0 || h.hydration > 0 || h.protein > 0) {
    out.push(`健康 · 热量 ${Math.round(h.calories)}kcal`);
  } else if (h.weightKg != null) {
    out.push(`健康 · 体重 ${h.weightKg}kg`);
  }
  if (facts.frogs.length > 0) {
    const done = facts.frogs.filter((f) => f.done).length;
    out.push(`任务 · 完成 ${done} · 未完成 ${facts.frogs.length - done}`);
  }
  if (facts.todos.length > 0) {
    const done = facts.todos.filter((t) => t.done).length;
    out.push(`待办 · 完成 ${done} · 未完成 ${facts.todos.length - done}`);
  }
  if (facts.habits.length > 0) {
    const done = facts.habits.filter((hb) => hb.done).length;
    out.push(`习惯 · 已打卡 ${done} · 未打卡 ${facts.habits.length - done}`);
  }
  if (facts.finance.txns.length > 0 || facts.finance.income > 0 || facts.finance.expense > 0) {
    out.push(
      `财务 · 收入 ${formatMoney(facts.finance.income)} · 支出 ${formatMoney(facts.finance.expense)}`,
    );
  }
  return out;
}

function mergeFacts(parts: ReviewDayFacts[]): ReviewDayFacts {
  const out = emptyFacts();
  if (parts.length === 0) return out;
  const frogMap = new Map<string, ReviewDayFactItem>();
  const todoMap = new Map<string, ReviewDayFactItem>();
  const habitMap = new Map<string, ReviewDayFactItem>();
  const txnSeen = new Set<string>();
  for (const part of parts) {
    out.health.hydration += part.health.hydration;
    out.health.protein += part.health.protein;
    out.health.carbohydrate += part.health.carbohydrate;
    out.health.calories += part.health.calories;
    out.health.targetHydration = part.health.targetHydration;
    out.health.targetProtein = part.health.targetProtein;
    out.health.targetCarbohydrate = part.health.targetCarbohydrate;
    out.health.targetCalories = part.health.targetCalories;
    if (part.health.weightKg != null) out.health.weightKg = part.health.weightKg;
    for (const f of part.frogs) frogMap.set(f.id, f);
    for (const t of part.todos) todoMap.set(t.id, t);
    for (const h of part.habits) habitMap.set(h.id, h);
    out.finance.income += part.finance.income;
    out.finance.expense += part.finance.expense;
    for (const txn of part.finance.txns) {
      if (txnSeen.has(txn.id)) continue;
      txnSeen.add(txn.id);
      out.finance.txns.push(txn);
    }
  }
  out.finance.net = out.finance.income - out.finance.expense;
  out.frogs = [...frogMap.values()];
  out.todos = [...todoMap.values()];
  out.habits = [...habitMap.values()];
  return out;
}

function listYmdsInclusive(startYmd: string, endYmd: string): string[] {
  if (startYmd > endYmd) return [];
  const out: string[] = [];
  let cur = startYmd;
  for (let i = 0; i < 400; i++) {
    out.push(cur);
    if (cur === endYmd) break;
    cur = addDaysToYmd(cur, 1);
  }
  return out;
}

export async function loadReviewPeriodFacts(
  startYmd: string,
  endYmd: string,
  opts?: { skipYmds?: ReadonlySet<string> },
): Promise<ReviewDayFacts> {
  const start = requireYmd(startYmd, 'start');
  const end = requireYmd(endYmd, 'end');
  const skip = opts?.skipYmds;
  const days = listYmdsInclusive(start, end).filter((d) => !skip?.has(d));
  if (days.length === 0) return emptyFacts();
  if (days.length === 1) return loadReviewDayFacts(days[0]!);
  const parts = await Promise.all(days.map((d) => loadReviewDayFacts(d)));
  return mergeFacts(parts);
}

export async function getReviewDayFactsSummary(params: {
  ymd?: string;
  logicalToday?: string;
}) {
  const ymd =
    params.ymd?.trim() && isValidYmd(params.ymd.trim())
      ? params.ymd.trim()
      : resolveReviewLogicalToday(params.logicalToday);
  const facts = await loadReviewDayFacts(ymd);
  const field_patch = builtinReviewFactsFieldPatch('daily', facts);
  return {
    domain: 'review_day_facts',
    ymd,
    empty: reviewDayFactsIsEmpty(facts),
    preview_lines: reviewDayFactsPreviewLines(facts),
    facts,
    field_patch,
    builtin_column_ids: BUILTIN_COLUMN_IDS.daily,
    note: '当日健康/任务/财务事实；一键写入请用 POST /review/fill-empty（仅填空栏）。',
  };
}

export { BUILTIN_COLUMN_IDS, REVIEW_BODY_VERSION, WEEKDAY_LABELS };
