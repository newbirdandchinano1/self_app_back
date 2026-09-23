import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import { isValidYmd } from '../../utils/ymd.js';
import { collectFrogAssignedDates } from '../calendar/aggregation.js';
import { getTableMeta } from '../crud.js';
import { INBOX_PROJECT_CATEGORY_ID } from './catalog-inbox-seed.js';

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export class FrogAssignError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'FrogAssignError';
    this.status = status;
  }
}

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function parseExtraObject(extraData: unknown): Record<string, unknown> {
  if (extraData == null || extraData === '') return {};
  try {
    const parsed =
      typeof extraData === 'string' ? (JSON.parse(extraData) as unknown) : extraData;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
    return {};
  } catch {
    return {};
  }
}

function writeFrogAssignedDates(extraData: unknown, dates: string[]): string | null {
  const current = parseExtraObject(extraData);
  const { frogAssignedOn: _a, frogAssignedDates: _b, ...rest } = current;
  const sorted = [...new Set(dates.map((d) => d.trim()).filter((d) => YMD_RE.test(d)))].sort();
  if (sorted.length === 0) {
    return Object.keys(rest).length === 0 ? null : JSON.stringify(rest);
  }
  const payload: Record<string, unknown> = {
    ...rest,
    frogAssignedOn: sorted[sorted.length - 1],
  };
  if (sorted.length > 1) {
    payload.frogAssignedDates = sorted;
  }
  return JSON.stringify(payload);
}

function mergeFrogAssignedOn(extraData: unknown, assignYmd: string): string {
  const dates = collectFrogAssignedDates(extraData);
  if (!dates.includes(assignYmd)) dates.push(assignYmd);
  return writeFrogAssignedDates(extraData, dates) ?? JSON.stringify({ frogAssignedOn: assignYmd });
}

function removeFrogAssignedOn(extraData: unknown, assignYmd: string): string | null {
  const next = collectFrogAssignedDates(extraData).filter((d) => d !== assignYmd);
  return writeFrogAssignedDates(extraData, next);
}

async function syncFrogAssignedOnColumn(
  table: 'tasks' | 'projects',
  id: string,
  extraData: string | null,
): Promise<void> {
  const meta = await getTableMeta(table);
  if (!meta.columns.includes('frog_assigned_on')) return;
  const dates = collectFrogAssignedDates(extraData);
  const latest = dates.length > 0 ? dates[dates.length - 1]! : null;
  await db.query<ResultSetHeader>(
    `UPDATE ${quoteIdent(table)} SET frog_assigned_on = ? WHERE id = ?`,
    [latest, id],
  );
}

export type FrogSubjectKind = 'task' | 'project';

export type FrogAssignInput = {
  kind: FrogSubjectKind;
  id: string;
  assignYmd: string;
  action?: 'assign' | 'unassign';
};

export type FrogAssignResult = {
  kind: FrogSubjectKind;
  id: string;
  assignYmd: string;
  action: 'assign' | 'unassign';
  extra_data: string | null;
  assignedDates: string[];
};

async function loadTaskRow(id: string): Promise<RowDataPacket | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, project_id, parent_task_id, title, description, note, status, priority, due_date, extra_data, frog_assigned_on
     FROM tasks WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

async function loadProjectRow(id: string): Promise<RowDataPacket | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, category_id, name, status, priority, note, due_date, extra_data, frog_assigned_on
     FROM projects WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

async function assertTaskAssignable(row: RowDataPacket, assignYmd: string): Promise<void> {
  const status = String(row.status ?? '');
  if (status === 'done' || status === 'cancelled') {
    throw new FrogAssignError('任务已完成或已取消，无法指派青蛙');
  }
  const dates = collectFrogAssignedDates(row.extra_data, row.frog_assigned_on);
  if (dates.includes(assignYmd)) {
    throw new FrogAssignError('该日已指派为青蛙');
  }
  const [childRows] = await db.query<RowDataPacket[]>(
    `SELECT id FROM tasks
     WHERE parent_task_id = ?
       AND status NOT IN ('done', 'cancelled')
     LIMIT 1`,
    [row.id],
  );
  if (childRows.length > 0) {
    throw new FrogAssignError('请先完成或指派叶子任务，父任务不可直接作为青蛙');
  }
}

async function assertProjectAssignable(row: RowDataPacket, assignYmd: string): Promise<void> {
  const status = String(row.status ?? '');
  if (status !== 'active') {
    throw new FrogAssignError('仅活跃且无子任务的项目可指派为青蛙');
  }
  const categoryId = row.category_id == null ? '' : String(row.category_id);
  if (!categoryId || categoryId === INBOX_PROJECT_CATEGORY_ID) {
    throw new FrogAssignError('收集箱项目不可指派为青蛙');
  }
  const dates = collectFrogAssignedDates(row.extra_data, row.frog_assigned_on);
  if (dates.includes(assignYmd)) {
    throw new FrogAssignError('该日已指派为青蛙');
  }
  const [taskRows] = await db.query<RowDataPacket[]>(
    `SELECT id FROM tasks WHERE project_id = ? LIMIT 1`,
    [row.id],
  );
  if (taskRows.length > 0) {
    throw new FrogAssignError('有子任务的项目不可直接指派为青蛙，请指派具体任务');
  }
}

export async function assignOrUnassignFrog(input: FrogAssignInput): Promise<FrogAssignResult> {
  const assignYmd = String(input.assignYmd ?? '').trim();
  if (!isValidYmd(assignYmd)) {
    throw new FrogAssignError('assignYmd 必须为 YYYY-MM-DD');
  }
  const kind = input.kind;
  if (kind !== 'task' && kind !== 'project') {
    throw new FrogAssignError('kind 仅支持 task / project');
  }
  const id = String(input.id ?? '').trim();
  if (!id) throw new FrogAssignError('id 必填');
  const action = input.action === 'unassign' ? 'unassign' : 'assign';

  if (kind === 'task') {
    const row = await loadTaskRow(id);
    if (!row) throw new FrogAssignError('任务不存在', 404);
    if (action === 'assign') await assertTaskAssignable(row, assignYmd);
    const nextExtra =
      action === 'assign'
        ? mergeFrogAssignedOn(row.extra_data, assignYmd)
        : removeFrogAssignedOn(row.extra_data, assignYmd);
    await db.query<ResultSetHeader>(`UPDATE tasks SET extra_data = ? WHERE id = ?`, [nextExtra, id]);
    await syncFrogAssignedOnColumn('tasks', id, nextExtra);
    return {
      kind,
      id,
      assignYmd,
      action,
      extra_data: nextExtra,
      assignedDates: collectFrogAssignedDates(nextExtra),
    };
  }

  const row = await loadProjectRow(id);
  if (!row) throw new FrogAssignError('项目不存在', 404);
  if (action === 'assign') await assertProjectAssignable(row, assignYmd);
  const nextExtra =
    action === 'assign'
      ? mergeFrogAssignedOn(row.extra_data, assignYmd)
      : removeFrogAssignedOn(row.extra_data, assignYmd);
  await db.query<ResultSetHeader>(`UPDATE projects SET extra_data = ? WHERE id = ?`, [nextExtra, id]);
  await syncFrogAssignedOnColumn('projects', id, nextExtra);
  return {
    kind,
    id,
    assignYmd,
    action,
    extra_data: nextExtra,
    assignedDates: collectFrogAssignedDates(nextExtra),
  };
}
