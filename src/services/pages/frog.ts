import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import { isValidYmd } from '../../utils/ymd.js';
import { collectFrogAssignedDates } from '../calendar/aggregation.js';
import { getTableMeta } from '../crud.js';
import {
  resolveTasksBootstrapContext,
  TASKS_PAGE_FILTERS_VERSION,
  type TasksBootstrapParams,
} from './tasks-bootstrap.js';
import { INBOX_PROJECT_CATEGORY_ID } from './tasks-catalog.js';

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
  const meta = await getTableMeta('tasks');
  const frogSelect = meta.columns.includes('frog_assigned_on') ? ', frog_assigned_on' : '';
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, project_id, parent_task_id, title, description, note, status, priority, due_date, extra_data${frogSelect}
     FROM tasks WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

async function loadProjectRow(id: string): Promise<RowDataPacket | null> {
  const meta = await getTableMeta('projects');
  const frogSelect = meta.columns.includes('frog_assigned_on') ? ', frog_assigned_on' : '';
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, category_id, name, status, priority, note, due_date, extra_data${frogSelect}
     FROM projects WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

async function assertTaskAssignable(row: RowDataPacket, _assignYmd: string): Promise<void> {
  const status = String(row.status ?? '');
  if (status === 'done' || status === 'cancelled') {
    throw new FrogAssignError('任务已完成或已取消，无法指派青蛙');
  }
  // 允许同一任务指派到当日多个格子；同格重复由日程占用层拦截。已指派日 merge 幂等。
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

async function assertProjectAssignable(row: RowDataPacket, _assignYmd: string): Promise<void> {
  const status = String(row.status ?? '');
  if (status !== 'active') {
    throw new FrogAssignError('仅活跃且无子任务的项目可指派为青蛙');
  }
  const categoryId = row.category_id == null ? '' : String(row.category_id);
  if (!categoryId || categoryId === INBOX_PROJECT_CATEGORY_ID) {
    throw new FrogAssignError('收集箱项目不可指派为青蛙');
  }
  // 允许同一项目指派到当日多个格子；同格重复由日程占用层拦截。已指派日 merge 幂等。
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

export type FrogCandidateItem = {
  kind: 'task' | 'project';
  id: string;
  title: string;
  priority: number;
  dueDate: string | null;
  acceptanceCriteria: string;
  rewardPoints: number;
  projectId: string | null;
  projectName: string | null;
  /** @deprecated 兼容旧客户端；优先用 tags */
  tagNames: string[];
  tags: { name: string; color: string }[];
  /** 相对逻辑今日是否已过期（截止/日程结束日） */
  isOverdue: boolean;
  alreadyAssigned: boolean;
  /** 有未完成子任务时不可指派 */
  blockedReason: string | null;
};

export type FrogCandidatesResult = {
  assignYmd: string;
  logicalToday: string;
  items: FrogCandidateItem[];
  meta: {
    filtersVersion: string;
    count: number;
  };
};

function parseExtra(extraData: unknown): Record<string, unknown> {
  if (extraData == null || extraData === '') return {};
  try {
    const parsed =
      typeof extraData === 'string' ? (JSON.parse(extraData) as unknown) : extraData;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function rewardPointsFromExtra(extraData: unknown): number {
  const raw = parseExtra(extraData).reward_points;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function acceptanceFromRow(description: unknown, note: unknown): string {
  const d = description == null ? '' : String(description).trim();
  if (d) return d;
  return note == null ? '' : String(note).trim();
}

function dueYmd(value: unknown): string | null {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (YMD_RE.test(s.slice(0, 10))) return s.slice(0, 10);
  return null;
}

const DEFAULT_TAG_COLOR = '#64748B';

function normalizeTagColor(color: unknown): string {
  const raw = String(color ?? '').trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(raw)) return raw.toUpperCase();
  return DEFAULT_TAG_COLOR;
}

/** 项目/任务日程结束日：优先 schedule.range.end / schedule.date，再回退 due_date */
function scheduleEndYmd(dueDate: unknown, extraData: unknown): string | null {
  const extra = parseExtra(extraData);
  const schedule = extra.schedule;
  if (schedule && typeof schedule === 'object' && !Array.isArray(schedule)) {
    const s = schedule as { date?: unknown; range?: { start?: unknown; end?: unknown } };
    if (s.range?.end != null && String(s.range.end).trim()) {
      return dueYmd(s.range.end);
    }
    if (s.date != null && String(s.date).trim()) {
      return dueYmd(s.date);
    }
  }
  return dueYmd(dueDate);
}

function isYmdBefore(a: string | null, b: string): boolean {
  return !!a && YMD_RE.test(a) && YMD_RE.test(b) && a < b;
}

  /**
   * 轻量候选列表：供周课程表「放置青蛙」挑选。
   * 含任务（含无项目待办）与无子任务活跃项目；已指派项标记 alreadyAssigned（仍可选入其他格子）。
   * 锁定（前置/日程）由客户端用本地 lockMap 再过滤。
   */
export async function getFrogCandidates(
  params: TasksBootstrapParams & { assignYmd?: string },
): Promise<FrogCandidatesResult> {
  const context = await resolveTasksBootstrapContext(params);
  const assignYmd = (params.assignYmd ?? context.logicalToday).trim();
  if (!isValidYmd(assignYmd)) {
    throw new FrogAssignError('assignYmd 必须为 YYYY-MM-DD');
  }

  // 列可能尚未迁移：与 frog-assign 一致，按表元数据条件选取
  const [taskMeta, projectMeta] = await Promise.all([
    getTableMeta('tasks'),
    getTableMeta('projects'),
  ]);
  const taskFrogSelect = taskMeta.columns.includes('frog_assigned_on')
    ? ', t.frog_assigned_on'
    : '';
  const projectFrogSelect = projectMeta.columns.includes('frog_assigned_on')
    ? ', frog_assigned_on'
    : '';

  const [taskRows] = await db.query<RowDataPacket[]>(
    `SELECT t.id, t.project_id, t.parent_task_id, t.title, t.description, t.note,
            t.status, t.priority, t.due_date, t.extra_data${taskFrogSelect},
            p.name AS project_name
     FROM tasks t
     LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.status NOT IN ('done', 'cancelled', 'shelved')
     ORDER BY t.priority DESC, t.updated_at DESC
     LIMIT 500`,
  );

  const [projectRows] = await db.query<RowDataPacket[]>(
    `SELECT id, category_id, name, status, priority, note, due_date, extra_data${projectFrogSelect}
     FROM projects
     WHERE status = 'active'
     ORDER BY priority DESC, updated_at DESC
     LIMIT 300`,
  );

  const [childParentRows] = await db.query<RowDataPacket[]>(
    `SELECT DISTINCT parent_task_id AS id
     FROM tasks
     WHERE parent_task_id IS NOT NULL
       AND parent_task_id != ''
       AND status NOT IN ('done', 'cancelled')`,
  );
  const parentsWithOpenChildren = new Set(
    childParentRows.map((r) => String(r.id)).filter(Boolean),
  );

  const [projectTaskCountRows] = await db.query<RowDataPacket[]>(
    `SELECT project_id AS id, COUNT(*) AS cnt
     FROM tasks
     WHERE project_id IS NOT NULL AND project_id != ''
     GROUP BY project_id`,
  );
  const taskCountByProject = new Map<string, number>();
  for (const row of projectTaskCountRows) {
    taskCountByProject.set(String(row.id), Number(row.cnt ?? 0));
  }

  const projectIds = [
    ...new Set([
      ...taskRows.map((r) => (r.project_id == null ? '' : String(r.project_id))).filter(Boolean),
      ...projectRows.map((r) => String(r.id)),
    ]),
  ];
  const tagMetaByProject = new Map<string, { name: string; color: string }[]>();
  if (projectIds.length > 0) {
    try {
      const [tagRows] = await db.query<RowDataPacket[]>(
        `SELECT tl.entity_id AS project_id, tg.name, tg.color, tg.weight
         FROM tag_links tl
         INNER JOIN tags tg ON tg.id = tl.tag_id
         WHERE tl.entity_type = 'project'
           AND tl.entity_id IN (${projectIds.map(() => '?').join(',')})
           AND (tl.sync_status IS NULL OR tl.sync_status != 'pending_delete')
           AND (tg.sync_status IS NULL OR tg.sync_status != 'pending_delete')
         ORDER BY tg.weight DESC, tg.name ASC`,
        projectIds,
      );
      for (const row of tagRows) {
        const pid = String(row.project_id);
        const name = String(row.name ?? '').trim();
        if (!name) continue;
        const list = tagMetaByProject.get(pid) ?? [];
        list.push({ name, color: normalizeTagColor(row.color) });
        tagMetaByProject.set(pid, list);
      }
    } catch {
      // 标签表可能尚未迁移：忽略
    }
  }

  const items: FrogCandidateItem[] = [];
  const logicalToday = context.logicalToday;

  for (const row of taskRows) {
    const id = String(row.id);
    const assigned = collectFrogAssignedDates(row.extra_data, row.frog_assigned_on).includes(
      assignYmd,
    );
    const blocked = parentsWithOpenChildren.has(id)
      ? '存在未完成子任务'
      : null;
    const projectId = row.project_id == null ? null : String(row.project_id);
    const tags = projectId ? tagMetaByProject.get(projectId) ?? [] : [];
    const dueDate = dueYmd(row.due_date);
    const endYmd = scheduleEndYmd(row.due_date, row.extra_data) ?? dueDate;
    items.push({
      kind: 'task',
      id,
      title: String(row.title ?? ''),
      priority: Number(row.priority ?? 0),
      dueDate,
      acceptanceCriteria: acceptanceFromRow(row.description, row.note),
      rewardPoints: rewardPointsFromExtra(row.extra_data),
      projectId,
      projectName: row.project_name == null ? null : String(row.project_name),
      tagNames: tags.map((t) => t.name),
      tags,
      isOverdue: isYmdBefore(endYmd, logicalToday),
      alreadyAssigned: assigned,
      blockedReason: blocked,
    });
  }

  for (const row of projectRows) {
    const id = String(row.id);
    const categoryId = row.category_id == null ? '' : String(row.category_id);
    if (!categoryId || categoryId === INBOX_PROJECT_CATEGORY_ID) continue;
    if ((taskCountByProject.get(id) ?? 0) > 0) continue;
    const assigned = collectFrogAssignedDates(row.extra_data, row.frog_assigned_on).includes(
      assignYmd,
    );
    const tags = tagMetaByProject.get(id) ?? [];
    const dueDate = dueYmd(row.due_date);
    const endYmd = scheduleEndYmd(row.due_date, row.extra_data) ?? dueDate;
    items.push({
      kind: 'project',
      id,
      title: String(row.name ?? ''),
      priority: Number(row.priority ?? 0),
      dueDate,
      acceptanceCriteria: acceptanceFromRow(null, row.note),
      rewardPoints: rewardPointsFromExtra(row.extra_data),
      projectId: id,
      projectName: String(row.name ?? ''),
      tagNames: tags.map((t) => t.name),
      tags,
      isOverdue: isYmdBefore(endYmd, logicalToday),
      alreadyAssigned: assigned,
      blockedReason: null,
    });
  }

  items.sort((a, b) => {
    if (a.alreadyAssigned !== b.alreadyAssigned) return a.alreadyAssigned ? 1 : -1;
    if (a.blockedReason && !b.blockedReason) return 1;
    if (!a.blockedReason && b.blockedReason) return -1;
    if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.title.localeCompare(b.title, 'zh');
  });

  return {
    assignYmd,
    logicalToday,
    items,
    meta: {
      filtersVersion: TASKS_PAGE_FILTERS_VERSION,
      count: items.length,
    },
  };
}

const AXIS_SETTING_KEY = '@selfapp/frog_schedule_axis_v1';

export class FrogScheduleError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'FrogScheduleError';
    this.status = status;
  }
}

type ScheduleBreak = {
  startMinutes: number;
  endMinutes: number;
  label: string;
};

type AxisRow = {
  startMinutes: number;
  endMinutes: number;
  slotHours: number;
  breaks: ScheduleBreak[];
  updatedAt?: string;
};

function snapHourMinutes(n: number, allow24: boolean): number {
  const max = allow24 ? 24 * 60 : 23 * 60;
  const clamped = Math.min(max, Math.max(0, Math.round(n)));
  if (allow24 && clamped >= 24 * 60) return 24 * 60;
  return Math.floor(clamped / 60) * 60;
}

function normalizeBreaks(
  raw: unknown,
  dayStartMinutes: number,
  dayEndMinutes: number,
): ScheduleBreak[] {
  if (!Array.isArray(raw)) return [];
  const dayStart = snapHourMinutes(dayStartMinutes, false);
  const dayEnd = snapHourMinutes(dayEndMinutes, true);
  const parsed: ScheduleBreak[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const start = snapHourMinutes(Number(o.startMinutes), false);
    const end = snapHourMinutes(Number(o.endMinutes), true);
    if (!(end > start)) continue;
    const clippedStart = Math.max(start, dayStart);
    const clippedEnd = Math.min(end, dayEnd);
    if (!(clippedEnd > clippedStart)) continue;
    const labelRaw = typeof o.label === 'string' ? o.label.replace(/\s+/g, '').slice(0, 6) : '';
    parsed.push({
      startMinutes: clippedStart,
      endMinutes: clippedEnd,
      label: labelRaw || '休息',
    });
  }
  parsed.sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);
  const merged: ScheduleBreak[] = [];
  for (const b of parsed) {
    const last = merged[merged.length - 1];
    if (last && b.startMinutes <= last.endMinutes) {
      last.endMinutes = Math.max(last.endMinutes, b.endMinutes);
    } else {
      merged.push({ ...b });
    }
  }
  return merged.slice(0, 8);
}

function parseAxisJson(raw: unknown): AxisRow {
  const defaults = { startMinutes: 8 * 60, endMinutes: 22 * 60, slotHours: 2, breaks: [] as ScheduleBreak[] };
  if (raw == null) return defaults;
  try {
    const o = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
    const startMinutes = Number(o.startMinutes ?? defaults.startMinutes);
    const endMinutes = Number(o.endMinutes ?? defaults.endMinutes);
    const slotHours = Number(o.slotHours ?? defaults.slotHours);
    const start = Number.isFinite(startMinutes)
      ? snapHourMinutes(startMinutes, false)
      : defaults.startMinutes;
    const end = Number.isFinite(endMinutes)
      ? snapHourMinutes(endMinutes, true)
      : defaults.endMinutes;
    return {
      startMinutes: start,
      endMinutes: end,
      slotHours: slotHours === 1 || slotHours === 2 || slotHours === 3 || slotHours === 4 ? slotHours : 2,
      breaks: normalizeBreaks(o.breaks, start, end),
      updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : undefined,
    };
  } catch {
    return defaults;
  }
}

async function getGlobalAxis(): Promise<AxisRow> {
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT value_json FROM app_settings WHERE `key` = ? LIMIT 1',
    [AXIS_SETTING_KEY],
  );
  return parseAxisJson(rows[0]?.value_json);
}

async function getWeekSnapshot(weekStartYmd: string): Promise<AxisRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT start_minutes, end_minutes, slot_hours, breaks_json FROM schedule_week_axis_snapshot
     WHERE week_start_ymd = ? LIMIT 1`,
    [weekStartYmd],
  );
  const r = rows[0];
  if (!r) return null;
  const startMinutes = Number(r.start_minutes);
  const endMinutes = Number(r.end_minutes);
  let breaks: ScheduleBreak[] = [];
  try {
    breaks = normalizeBreaks(
      r.breaks_json ? JSON.parse(String(r.breaks_json)) : [],
      startMinutes,
      endMinutes,
    );
  } catch {
    breaks = [];
  }
  return {
    startMinutes,
    endMinutes,
    slotHours: Number(r.slot_hours),
    breaks,
  };
}

function mondayOf(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y!, m! - 1, d!, 12, 0, 0);
  const day = dt.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  dt.setDate(dt.getDate() + diff);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export async function getFrogScheduleWeek(params: {
  weekStartYmd: string;
  logicalTodayYmd?: string;
}) {
  const weekStartYmd = params.weekStartYmd?.trim();
  if (!YMD_RE.test(weekStartYmd)) {
    throw new FrogScheduleError('weekStartYmd 无效');
  }

  const logicalToday = params.logicalTodayYmd && YMD_RE.test(params.logicalTodayYmd)
    ? params.logicalTodayYmd
    : new Date().toISOString().slice(0, 10);
  const thisMonday = mondayOf(logicalToday);
  const isHistorical = weekStartYmd < thisMonday;

  let axis = await getGlobalAxis();
  let fromSnapshot = false;
  if (isHistorical) {
    const snap = await getWeekSnapshot(weekStartYmd);
    if (snap) {
      axis = snap;
      fromSnapshot = true;
    } else {
      const now = new Date().toISOString();
      await db.query<ResultSetHeader>(
        `INSERT IGNORE INTO schedule_week_axis_snapshot
          (week_start_ymd, start_minutes, end_minutes, slot_hours, breaks_json, created_at, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, 'synced')`,
        [
          weekStartYmd,
          axis.startMinutes,
          axis.endMinutes,
          axis.slotHours,
          JSON.stringify(axis.breaks ?? []),
          now,
        ],
      );
      fromSnapshot = true;
    }
  }

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, week_start_ymd, weekday, start_slot_index, span_slots,
            subject_kind, subject_id, orphaned, created_at, updated_at, sync_status
     FROM schedule_placements
     WHERE week_start_ymd = ? AND sync_status != 'pending_delete'
     ORDER BY weekday ASC, orphaned ASC, start_slot_index ASC`,
    [weekStartYmd],
  );

  return {
    weekStartYmd,
    axis: {
      startMinutes: axis.startMinutes,
      endMinutes: axis.endMinutes,
      slotHours: axis.slotHours,
      breaks: axis.breaks ?? [],
      fromSnapshot,
    },
    placements: rows.map((r) => ({
      id: String(r.id),
      weekStartYmd: String(r.week_start_ymd),
      weekday: Number(r.weekday),
      startSlotIndex: r.start_slot_index == null ? null : Number(r.start_slot_index),
      spanSlots: Number(r.span_slots) || 1,
      subjectKind: r.subject_kind === 'project' ? 'project' : 'task',
      subjectId: String(r.subject_id),
      orphaned: Number(r.orphaned) ? 1 : 0,
    })),
  };
}

export async function saveFrogScheduleAxis(body: {
  startMinutes: number;
  endMinutes: number;
  slotHours: number;
  breaks?: ScheduleBreak[];
  updatedAt?: string;
}) {
  const snapHour = (n: number, allow24: boolean) => snapHourMinutes(Number(n), allow24);
  const startMinutes = snapHour(body.startMinutes, false);
  const endMinutes = snapHour(body.endMinutes, true);
  const slotHours = Number(body.slotHours);
  if (![1, 2, 3, 4].includes(slotHours)) {
    throw new FrogScheduleError('格宽仅允许 1–4 小时');
  }
  if (!(endMinutes > startMinutes)) {
    throw new FrogScheduleError('日结束时间必须晚于日开始时间');
  }
  if (endMinutes - startMinutes < slotHours * 60) {
    throw new FrogScheduleError(`日时间范围至少需要容纳 1 个 ${slotHours} 小时格子`);
  }
  const breaks = normalizeBreaks(body.breaks, startMinutes, endMinutes);
  const payload = JSON.stringify({
    startMinutes,
    endMinutes,
    slotHours,
    breaks,
    updatedAt: body.updatedAt || new Date().toISOString(),
  });
  const now = new Date().toISOString();
  await db.query<ResultSetHeader>(
    `INSERT INTO app_settings (\`key\`, value_json, updated_at, sync_status)
     VALUES (?, ?, ?, 'synced')
     ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = VALUES(updated_at), sync_status = 'synced'`,
    [AXIS_SETTING_KEY, payload, now],
  );
  return { startMinutes, endMinutes, slotHours, breaks, updatedAt: now };
}

export async function upsertFrogSchedulePlacement(body: {
  id: string;
  weekStartYmd: string;
  weekday: number;
  startSlotIndex: number | null;
  spanSlots: number;
  subjectKind: 'task' | 'project';
  subjectId: string;
  orphaned?: number;
  createdAt?: string;
  updatedAt?: string;
}) {
  if (!body.id || !YMD_RE.test(body.weekStartYmd)) {
    throw new FrogScheduleError('placement 参数无效');
  }
  const now = new Date().toISOString();
  await db.query<ResultSetHeader>(
    `INSERT INTO schedule_placements (
      id, week_start_ymd, weekday, start_slot_index, span_slots,
      subject_kind, subject_id, orphaned, created_at, updated_at, sync_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
    ON DUPLICATE KEY UPDATE
      week_start_ymd = VALUES(week_start_ymd),
      weekday = VALUES(weekday),
      start_slot_index = VALUES(start_slot_index),
      span_slots = VALUES(span_slots),
      subject_kind = VALUES(subject_kind),
      subject_id = VALUES(subject_id),
      orphaned = VALUES(orphaned),
      updated_at = VALUES(updated_at),
      sync_status = 'synced'`,
    [
      body.id,
      body.weekStartYmd,
      body.weekday,
      body.startSlotIndex,
      Math.max(1, body.spanSlots || 1),
      body.subjectKind,
      body.subjectId,
      body.orphaned ? 1 : 0,
      body.createdAt || now,
      body.updatedAt || now,
    ],
  );
  return { id: body.id };
}

export async function deleteFrogSchedulePlacement(id: string) {
  if (!id) throw new FrogScheduleError('id 无效');
  await db.query<ResultSetHeader>(`DELETE FROM schedule_placements WHERE id = ?`, [id]);
  return { id };
}
