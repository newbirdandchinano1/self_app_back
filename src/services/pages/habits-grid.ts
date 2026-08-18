import { listAllRecords } from '../crud.js';
import {
  buildHabitsGridItemsForDay,
  type HabitsGridItem,
} from '../calendar/aggregation.js';
import { addDaysToLogicalYmd } from '../calendar/logical-day.js';
import {
  resolveTasksBootstrapContext,
  TASKS_PAGE_FILTERS_VERSION,
  type TasksBootstrapParams,
} from './tasks-bootstrap.js';

export interface HabitsGridSection {
  id: string;
  title: string;
  items: HabitsGridItem[];
}

export interface HabitsGridResult {
  logicalToday: string;
  items: HabitsGridItem[];
  sections: HabitsGridSection[];
  meta: {
    serverFiltered: true;
    filtersVersion: string;
    serverTime: string;
  };
}

function extraDataForApi(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function resolveContextRef(
  raw: string | null | undefined,
  contexts: Record<string, unknown>[],
): { id: string; name: string } | null {
  const value = raw?.trim() || '';
  if (!value) return null;
  for (const ctx of contexts) {
    const id = String(ctx.id ?? '').trim();
    const name = String(ctx.name ?? '').trim();
    if (value === id || value === name) {
      return { id: id || name, name: name || id };
    }
  }
  return { id: value, name: value };
}

function buildCheckInsByHabit(
  rows: Record<string, unknown>[],
): Map<string, Record<string, number>> {
  const byHabit = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const habitId = String(row.habit_id ?? '');
    const recordDate = String(row.record_date ?? '');
    if (!habitId || !recordDate) continue;
    const count = Math.max(0, Math.floor(Number(row.count ?? 0)));
    const prev = byHabit.get(habitId) ?? {};
    prev[recordDate] = (prev[recordDate] ?? 0) + count;
    byHabit.set(habitId, prev);
  }
  return byHabit;
}

function buildTodayCheckIns(
  rows: Record<string, unknown>[],
  logicalToday: string,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    if (String(row.record_date ?? '') !== logicalToday) continue;
    const habitId = String(row.habit_id ?? '');
    if (!habitId) continue;
    const count = Math.max(0, Math.floor(Number(row.count ?? 0)));
    map.set(habitId, (map.get(habitId) ?? 0) + count);
  }
  return map;
}

export async function getHabitsGrid(params: TasksBootstrapParams): Promise<HabitsGridResult> {
  const context = resolveTasksBootstrapContext(params);
  const logicalToday = context.logicalToday;

  const [habits, contexts, checkInRows] = await Promise.all([
    listAllRecords('habits'),
    listAllRecords('habit_contexts'),
    listAllRecords('habit_check_ins', {
      startDate: addDaysToLogicalYmd(logicalToday, -400),
      endDate: logicalToday,
    }),
  ]);

  const habitCheckInsByHabit = buildCheckInsByHabit(checkInRows);
  const todayCheckIns = buildTodayCheckIns(checkInRows, logicalToday);

  const habitRows = habits.map((row) => ({
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    icon: String(row.icon ?? ''),
    note: row.note == null ? null : String(row.note),
    extra_data: extraDataForApi(row.extra_data),
    context: row.context == null ? null : String(row.context),
    created_at: row.created_at == null ? undefined : String(row.created_at),
  }));

  const allItems = buildHabitsGridItemsForDay({
    logicalYmd: logicalToday,
    habits: habitRows,
    habitCheckInsByHabit,
    todayCheckIns,
    dayBoundary: context.dayBoundary,
  }).map((item) => {
    const resolved = resolveContextRef(item.context, contexts);
    return {
      ...item,
      context: resolved?.id ?? item.context,
    };
  });

  const itemsByContext = new Map<string, HabitsGridItem[]>();
  for (const item of allItems) {
    const resolved = resolveContextRef(item.context, contexts);
    const bucketKey = resolved?.name ?? '';
    const bucket = itemsByContext.get(bucketKey) ?? [];
    bucket.push(item);
    itemsByContext.set(bucketKey, bucket);
  }

  const sortedContexts = [...contexts].sort(
    (a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0),
  );

  const sections: HabitsGridSection[] = [];
  const usedContexts = new Set<string>();

  for (const ctx of sortedContexts) {
    const name = String(ctx.name ?? '').trim();
    if (!name) continue;
    const items = itemsByContext.get(name);
    if (!items || items.length === 0) continue;
    usedContexts.add(name);
    sections.push({
      id: String(ctx.id ?? name),
      title: name,
      items,
    });
  }

  for (const [ctxName, items] of itemsByContext) {
    if (!ctxName || usedContexts.has(ctxName)) continue;
    sections.push({
      id: ctxName,
      title: ctxName,
      items,
    });
  }

  const orphanItems = itemsByContext.get('') ?? [];
  if (orphanItems.length > 0) {
    sections.push({
      id: '__uncategorized__',
      title: '未分类',
      items: orphanItems,
    });
  }

  return {
    logicalToday,
    items: allItems,
    sections,
    meta: {
      serverFiltered: true,
      filtersVersion: TASKS_PAGE_FILTERS_VERSION,
      serverTime: new Date().toISOString(),
    },
  };
}
