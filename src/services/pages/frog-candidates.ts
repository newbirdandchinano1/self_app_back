import type { RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import { isValidYmd } from '../../utils/ymd.js';
import { collectFrogAssignedDates } from '../calendar/aggregation.js';
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
  tagNames: string[];
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

/**
 * 轻量候选列表：供「今日青蛙 · 添加」挑选。
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

  const [taskRows] = await db.query<RowDataPacket[]>(
    `SELECT t.id, t.project_id, t.parent_task_id, t.title, t.description, t.note,
            t.status, t.priority, t.due_date, t.extra_data, t.frog_assigned_on,
            p.name AS project_name
     FROM tasks t
     LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.status NOT IN ('done', 'cancelled')
     ORDER BY t.priority DESC, t.updated_at DESC
     LIMIT 500`,
  );

  const [projectRows] = await db.query<RowDataPacket[]>(
    `SELECT id, category_id, name, status, priority, note, due_date, extra_data, frog_assigned_on
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
  const tagNamesByProject = new Map<string, string[]>();
  if (projectIds.length > 0) {
    try {
      const [tagRows] = await db.query<RowDataPacket[]>(
        `SELECT pt.project_id, tg.name
         FROM project_tag_links pt
         INNER JOIN project_tags tg ON tg.id = pt.tag_id
         WHERE pt.project_id IN (${projectIds.map(() => '?').join(',')})
         ORDER BY tg.weight DESC, tg.name ASC`,
        projectIds,
      );
      for (const row of tagRows) {
        const pid = String(row.project_id);
        const name = String(row.name ?? '').trim();
        if (!name) continue;
        const list = tagNamesByProject.get(pid) ?? [];
        list.push(name);
        tagNamesByProject.set(pid, list);
      }
    } catch {
      // 标签表可能尚未迁移：忽略
    }
  }

  const items: FrogCandidateItem[] = [];

  for (const row of taskRows) {
    const id = String(row.id);
    const assigned = collectFrogAssignedDates(row.extra_data, row.frog_assigned_on).includes(
      assignYmd,
    );
    const blocked = parentsWithOpenChildren.has(id)
      ? '存在未完成子任务'
      : null;
    const projectId = row.project_id == null ? null : String(row.project_id);
    items.push({
      kind: 'task',
      id,
      title: String(row.title ?? ''),
      priority: Number(row.priority ?? 0),
      dueDate: dueYmd(row.due_date),
      acceptanceCriteria: acceptanceFromRow(row.description, row.note),
      rewardPoints: rewardPointsFromExtra(row.extra_data),
      projectId,
      projectName: row.project_name == null ? null : String(row.project_name),
      tagNames: projectId ? tagNamesByProject.get(projectId) ?? [] : [],
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
    items.push({
      kind: 'project',
      id,
      title: String(row.name ?? ''),
      priority: Number(row.priority ?? 0),
      dueDate: dueYmd(row.due_date),
      acceptanceCriteria: acceptanceFromRow(null, row.note),
      rewardPoints: rewardPointsFromExtra(row.extra_data),
      projectId: id,
      projectName: String(row.name ?? ''),
      tagNames: tagNamesByProject.get(id) ?? [],
      alreadyAssigned: assigned,
      blockedReason: null,
    });
  }

  items.sort((a, b) => {
    if (a.alreadyAssigned !== b.alreadyAssigned) return a.alreadyAssigned ? 1 : -1;
    if (a.blockedReason && !b.blockedReason) return 1;
    if (!a.blockedReason && b.blockedReason) return -1;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.title.localeCompare(b.title, 'zh');
  });

  return {
    assignYmd,
    logicalToday: context.logicalToday,
    items,
    meta: {
      filtersVersion: TASKS_PAGE_FILTERS_VERSION,
      count: items.length,
    },
  };
}
