import type { RowDataPacket } from 'mysql2';
import { getTableMeta } from '../crud.js';
import { db } from '../../db/index.js';
import { isFrogAssignedOn } from '../calendar/aggregation.js';
import { formatRecordDateTimesForApi, compareTaskAuditDatetime } from '../calendar/logical-day.js';
import { isValidYmd } from '../../utils/ymd.js';
import {
  optionalNotDeleted,
  optionalNotPendingDelete,
} from './task-tree.js';
import {
  resolveTasksBootstrapContext,
  TASKS_PAGE_FILTERS_VERSION,
  type TasksBootstrapParams,
} from './tasks-bootstrap.js';

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function parseExtraData(extraData: unknown): {
  frogAssignedOn?: string;
  frogSessionCompletedOn?: string;
  frogSubjectDeleted?: boolean;
} {
  if (extraData == null || extraData === '') return {};
  try {
    return typeof extraData === 'string'
      ? (JSON.parse(extraData) as {
          frogAssignedOn?: string;
          frogSessionCompletedOn?: string;
          frogSubjectDeleted?: boolean;
        })
      : (extraData as {
          frogAssignedOn?: string;
          frogSessionCompletedOn?: string;
          frogSubjectDeleted?: boolean;
        });
  } catch {
    return {};
  }
}

export function isFrogDoneForToday(
  task: Record<string, unknown>,
  logicalToday: string,
): boolean {
  const status = String(task.status ?? '');
  if (status === 'done' || status === 'cancelled' || status === 'completed' || status === 'archived') {
    return true;
  }
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
  count: number;
  tasks: Record<string, unknown>[];
  projectFrogs: Record<string, unknown>[];
  projectFrogIds: string[];
  meta: {
    serverFiltered: true;
    filtersVersion: string;
    serverTime: string;
  };
}

async function loadFrogCandidates(
  table: 'tasks' | 'projects',
  logicalToday: string,
): Promise<Record<string, unknown>[]> {
  const meta = await getTableMeta(table);
  const columns = new Set(meta.columns);
  const selectCols = meta.columns.map(quoteIdent).join(', ');
  const where = [...optionalNotDeleted(columns), ...optionalNotPendingDelete(columns)];
  const values: unknown[] = [];

  const jsonOn = `JSON_UNQUOTE(JSON_EXTRACT(extra_data, '$.frogAssignedOn'))`;
  const jsonDates = `JSON_EXTRACT(extra_data, '$.frogAssignedDates')`;
  const jsonValid = `(extra_data IS NOT NULL AND extra_data != '' AND JSON_VALID(extra_data))`;
  const parts = [
    `(${jsonValid} AND ${jsonOn} = ?)`,
    `(${jsonValid} AND JSON_CONTAINS(${jsonDates}, JSON_QUOTE(?)))`,
  ];
  values.push(logicalToday, logicalToday);

  if (columns.has('frog_assigned_on')) {
    parts.unshift('frog_assigned_on = ?');
    values.unshift(logicalToday);
  }

  where.push(`(${parts.join(' OR ')})`);

  if (table === 'projects' && columns.has('status')) {
    where.push(`(status IS NULL OR status != 'archived')`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${selectCols} FROM ${quoteIdent(table)} ${whereSql}`,
    values,
  );

  return rows
    .map((row) => formatRecordDateTimesForApi(row as Record<string, unknown>, table))
    .filter((row) =>
      isFrogAssignedOn(
        row.extra_data,
        logicalToday,
        columns.has('frog_assigned_on') ? String(row.frog_assigned_on ?? '') : null,
      ),
    );
}

type FrogEventLatest = {
  id: string;
  task_id: string;
  action: string;
  created_at: string;
  task_title: string;
};

/** 今日净完成的青蛙事件（主体可已删）；按 task_id 取最新 */
async function loadNetCompletedFrogEventsForDay(logicalToday: string): Promise<FrogEventLatest[]> {
  if (!isValidYmd(logicalToday)) return [];
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, task_id, assigned_ymd, action, created_at, task_title
     FROM frog_completion_events
     WHERE LEFT(TRIM(assigned_ymd), 10) = ?`,
    [logicalToday],
  );

  const latestBySubject = new Map<string, FrogEventLatest>();
  for (const row of rows) {
    const assignedYmd = String(row.assigned_ymd ?? '')
      .trim()
      .slice(0, 10);
    if (assignedYmd !== logicalToday) continue;
    const eventId = String(row.id ?? '').trim();
    const taskId = String(row.task_id ?? '').trim() || eventId;
    if (!taskId) continue;
    const candidate: FrogEventLatest = {
      id: eventId,
      task_id: taskId,
      action: String(row.action ?? '').trim(),
      created_at: String(row.created_at ?? ''),
      task_title: String(row.task_title ?? '').trim(),
    };
    const prev = latestBySubject.get(taskId);
    if (!prev) {
      latestBySubject.set(taskId, candidate);
      continue;
    }
    const cmp = compareTaskAuditDatetime(candidate.created_at, prev.created_at);
    if (cmp > 0 || (cmp === 0 && candidate.id > prev.id)) {
      latestBySubject.set(taskId, candidate);
    }
  }

  return [...latestBySubject.values()].filter((e) => e.action === 'completed');
}

function buildDeletedSubjectExtra(logicalToday: string): string {
  return JSON.stringify({
    frogAssignedOn: logicalToday,
    frogAssignedDates: [logicalToday],
    frogSessionCompletedOn: logicalToday,
    frogSubjectDeleted: true,
  });
}

/**
 * 主体已从 tasks/projects 消失时，用事件快照合成今日栏行，
 * 保证「完成并删除」后今日青蛙栏仍有已完成记录。
 */
async function appendDeletedCompletedSnapshots(
  livingTasks: Record<string, unknown>[],
  livingProjects: Record<string, unknown>[],
  logicalToday: string,
): Promise<{ tasks: Record<string, unknown>[]; projectFrogs: Record<string, unknown>[] }> {
  const completed = await loadNetCompletedFrogEventsForDay(logicalToday);
  if (completed.length === 0) {
    return { tasks: livingTasks, projectFrogs: livingProjects };
  }

  const present = new Set<string>();
  for (const row of livingTasks) {
    const id = String(row.id ?? '').trim();
    if (id) present.add(id);
  }
  for (const row of livingProjects) {
    const id = String(row.id ?? '').trim();
    if (id) present.add(id);
  }

  const missing = completed.filter((e) => e.task_id && !present.has(e.task_id));
  if (missing.length === 0) {
    return { tasks: livingTasks, projectFrogs: livingProjects };
  }

  const missingIds = missing.map((e) => e.task_id);
  const ph = missingIds.map(() => '?').join(', ');
  const [stillTasks] = await db.query<RowDataPacket[]>(
    `SELECT id FROM tasks WHERE id IN (${ph})`,
    missingIds,
  );
  const [stillProjects] = await db.query<RowDataPacket[]>(
    `SELECT id FROM projects WHERE id IN (${ph})`,
    missingIds,
  );
  const aliveTaskIds = new Set(stillTasks.map((r) => String(r.id ?? '').trim()).filter(Boolean));
  const aliveProjectIds = new Set(
    stillProjects.map((r) => String(r.id ?? '').trim()).filter(Boolean),
  );

  const extraTasks = [...livingTasks];
  const extraProjects = [...livingProjects];
  const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);

  for (const event of missing) {
    // 主体仍在库但未指派今日（不应出现）则跳过；已删才合成
    if (aliveTaskIds.has(event.task_id) || aliveProjectIds.has(event.task_id)) continue;

    const title = event.task_title || '已删除的青蛙';
    const isProject = event.task_id.startsWith('p_');
    const extra = buildDeletedSubjectExtra(logicalToday);

    if (isProject) {
      extraProjects.push({
        id: event.task_id,
        name: title,
        note: '今日已完成（项目已删除）',
        status: 'completed',
        priority: 0,
        category_id: null,
        due_date: null,
        created_at: nowIso,
        updated_at: nowIso,
        sync_status: 'synced',
        extra_data: extra,
      });
    } else {
      extraTasks.push({
        id: event.task_id,
        title,
        note: '今日已完成（任务已删除）',
        status: 'done',
        priority: 0,
        project_id: null,
        category_id: null,
        parent_task_id: null,
        due_date: null,
        completed_at: nowIso,
        created_at: nowIso,
        updated_at: nowIso,
        sync_status: 'synced',
        extra_data: extra,
      });
    }
  }

  return { tasks: extraTasks, projectFrogs: extraProjects };
}

export async function getTodayFrogTasks(params: TasksBootstrapParams): Promise<TodayFrogsResult> {
  const context = resolveTasksBootstrapContext(params);
  const logicalToday = context.logicalToday;

  const [taskRows, projectRows] = await Promise.all([
    loadFrogCandidates('tasks', logicalToday),
    loadFrogCandidates('projects', logicalToday),
  ]);

  const withSnapshots = await appendDeletedCompletedSnapshots(taskRows, projectRows, logicalToday);

  const projectFrogs = sortTodayFrogTasks(withSnapshots.projectFrogs, logicalToday);
  const projectFrogIds = projectFrogs.map((row) => String(row.id ?? '')).filter(Boolean);
  const projectIdSet = new Set(projectFrogIds);

  // 任务 id 与项目 id 碰撞时，项目青蛙优先
  const tasks = sortTodayFrogTasks(
    withSnapshots.tasks.filter((row) => !projectIdSet.has(String(row.id ?? ''))),
    logicalToday,
  );

  return {
    logicalToday,
    count: tasks.length + projectFrogs.length,
    tasks,
    projectFrogs,
    projectFrogIds,
    meta: {
      serverFiltered: true,
      filtersVersion: TASKS_PAGE_FILTERS_VERSION,
      serverTime: new Date().toISOString(),
    },
  };
}
