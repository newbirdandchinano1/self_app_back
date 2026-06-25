import { listAllRecords } from '../crud.js';
import { resolveTasksBootstrapContext, type TasksBootstrapParams } from './tasks-bootstrap.js';

function parseExtraData(extraData: unknown): {
  frogAssignedOn?: string;
  frogSessionCompletedOn?: string;
} {
  if (extraData == null || extraData === '') return {};
  try {
    return typeof extraData === 'string'
      ? (JSON.parse(extraData) as { frogAssignedOn?: string; frogSessionCompletedOn?: string })
      : (extraData as { frogAssignedOn?: string; frogSessionCompletedOn?: string });
  } catch {
    return {};
  }
}

export function isFrogDoneForToday(
  task: Record<string, unknown>,
  logicalToday: string,
): boolean {
  const status = String(task.status ?? '');
  if (status === 'done' || status === 'cancelled') return true;
  const extra = parseExtraData(task.extra_data);
  if (extra.frogSessionCompletedOn === logicalToday) return true;
  return false;
}

export function sortTodayFrogTasks(
  tasks: Record<string, unknown>[],
  logicalToday: string,
): Record<string, unknown>[] {
  return [...tasks].sort((a, b) => {
    const aDone = isFrogDoneForToday(a, logicalToday);
    const bDone = isFrogDoneForToday(b, logicalToday);
    if (aDone !== bDone) return aDone ? 1 : -1;

    const aPri = Number(a.priority ?? 0);
    const bPri = Number(b.priority ?? 0);
    if (aPri !== bPri) return bPri - aPri;

    return String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''));
  });
}

export interface TodayFrogsResult {
  logicalToday: string;
  tasks: Record<string, unknown>[];
  count: number;
}

export async function getTodayFrogTasks(params: TasksBootstrapParams): Promise<TodayFrogsResult> {
  const context = resolveTasksBootstrapContext(params);
  const logicalToday = context.logicalToday;

  const rows = await listAllRecords('tasks', {
    frogAssignedOnGte: logicalToday,
    frogAssignedOnLte: logicalToday,
  });

  const tasks = sortTodayFrogTasks(rows, logicalToday);

  return {
    logicalToday,
    tasks,
    count: tasks.length,
  };
}
