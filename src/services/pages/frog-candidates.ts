import type { RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import { isValidYmd } from '../../utils/ymd.js';
import { collectFrogAssignedDates } from '../calendar/aggregation.js';
import { getTableMeta } from '../crud.js';
import {
  resolveTasksBootstrapContext,
  TASKS_PAGE_FILTERS_VERSION,
  type TasksBootstrapParams,
} from './tasks-bootstrap.js';
import { INBOX_PROJECT_CATEGORY_ID } from './catalog-inbox-seed.js';
import { FrogAssignError } from './frog-assign.js';

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

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
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
 * 含任务（含无项目待办）与无子任务活跃项目；已指派项标记 alreadyAssigned。
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
