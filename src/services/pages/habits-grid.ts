import { listAllRecords } from '../crud.js';
import {
  buildHabitsGridItemsForDay,
  type HabitsGridItem,
} from '../calendar/aggregation.js';
import { resolveTasksBootstrapContext, type TasksBootstrapParams } from './tasks-bootstrap.js';

export interface HabitsGridSection {
  id: string;
  title: string;
  items: HabitsGridItem[];
}

export interface HabitsGridResult {
  logicalToday: string;
  sections: HabitsGridSection[];
  meta: {
    serverFiltered: boolean;
    filtersVersion: string;
    serverTime: string;
  };
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
      startDate: context.habitCheckInStart,
      endDate: logicalToday,
    }),
  ]);

  const habitCheckInsByHabit = buildCheckInsByHabit(checkInRows);
  const todayCheckIns = buildTodayCheckIns(checkInRows, logicalToday);

  const habitRows = habits.map((row) => ({
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    icon: String(row.icon ?? ''),
    extra_data: row.extra_data == null ? null : String(row.extra_data),
    context: row.context == null ? null : String(row.context),
  }));

  const allItems = buildHabitsGridItemsForDay({
    logicalYmd: logicalToday,
    habits: habitRows,
    habitCheckInsByHabit,
    todayCheckIns,
  });

  const itemsByContext = new Map<string, HabitsGridItem[]>();
  for (const item of allItems) {
    const habit = habitRows.find((h) => h.id === item.id);
    const ctx = habit?.context?.trim() || '';
    const bucket = itemsByContext.get(ctx) ?? [];
    bucket.push(item);
    itemsByContext.set(ctx, bucket);
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
    sections,
    meta: {
      serverFiltered: true,
      filtersVersion: 'tasks-page-v1',
      serverTime: new Date().toISOString(),
    },
  };
}
