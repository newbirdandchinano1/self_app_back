/**
 * 独立待办升为项目：原子新建项目并挂接该待办及其子树。
 * Agent / 桌面 / App 共用语义（对齐 selfApp upgradeStandaloneTodoToProject）。
 */
import { randomBytes } from 'crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import { formatUtcMySQLDateTime } from '../calendar/logical-day.js';
import { getTableMeta } from '../crud.js';
import { appendChangeLog, withSyncTransaction, type SyncWriteOptions } from '../sync-change-log.js';
import { stampLiveUpsert } from '../sync-revision.js';

export class PromoteTodoError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code?: string,
  ) {
    super(message);
    this.name = 'PromoteTodoError';
  }
}

function quoteIdent(name: string): string {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

function makeProjectId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString('hex').slice(0, 8);
  const id = `p_${ts}_${rand}`;
  return id.length <= 36 ? id : id.slice(0, 36);
}

function buildProjectExtraFromTask(extraData: unknown): string | null {
  if (extraData == null || extraData === '') return null;
  try {
    const parsed = typeof extraData === 'string' ? JSON.parse(extraData) : extraData;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const schedule = (parsed as { schedule?: unknown }).schedule;
    if (schedule && typeof schedule === 'object') {
      return JSON.stringify({ schedule });
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function collectSubtreeIds(rootId: string): Promise<string[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `WITH RECURSIVE subtree(id) AS (
        SELECT id FROM tasks WHERE id = ?
        UNION ALL
        SELECT t.id
          FROM tasks t
          JOIN subtree s ON t.parent_task_id = s.id
     )
     SELECT id FROM subtree`,
    [rootId],
  );
  return rows.map((r) => String(r.id)).filter(Boolean);
}

export type PromoteTodoInput = {
  taskId: string;
  /** 可选：指定新项目 id（客户端预生成）；缺省服务端生成 */
  projectId?: string | null;
  /** 可选：项目分类；缺省 null（正式分类外，非收集箱） */
  categoryId?: string | null;
  /** 可选：覆盖项目名；缺省用待办标题 */
  projectName?: string | null;
};

export type PromoteTodoResult = {
  projectId: string;
  projectName: string;
  taskId: string;
  affectedTaskIds: string[];
};

/**
 * 将无项目顶层待办升级为项目：新建项目并挂接该待办及其子任务。
 */
export async function promoteStandaloneTodoToProject(
  input: PromoteTodoInput,
  options: SyncWriteOptions = {},
): Promise<PromoteTodoResult> {
  const taskId = String(input.taskId ?? '').trim();
  if (!taskId) throw new PromoteTodoError('taskId 必填', 400, 'missing_task_id');

  const taskMeta = await getTableMeta('tasks');
  const projectMeta = await getTableMeta('projects');
  const taskCols = new Set(taskMeta.columns);
  const projectCols = new Set(projectMeta.columns);

  const taskSelect = ['id', 'project_id', 'parent_task_id', 'title', 'note', 'due_date', 'extra_data', 'priority', 'status']
    .filter((c) => taskCols.has(c))
    .map(quoteIdent)
    .join(', ');

  const [taskRows] = await db.query<RowDataPacket[]>(
    `SELECT ${taskSelect} FROM tasks WHERE id = ? LIMIT 1`,
    [taskId],
  );
  const task = taskRows[0];
  if (!task) throw new PromoteTodoError('待办不存在或已删除', 404, 'not_found');

  const projectIdExisting = task.project_id == null ? '' : String(task.project_id).trim();
  const parentId = task.parent_task_id == null ? '' : String(task.parent_task_id).trim();
  if (projectIdExisting || parentId) {
    throw new PromoteTodoError('仅支持将未挂项目的顶层待办升级为项目', 400, 'not_standalone');
  }

  const projectName = (String(input.projectName ?? '').trim() || String(task.title ?? '').trim()).slice(
    0,
    120,
  );
  if (!projectName) {
    throw new PromoteTodoError('待办标题为空，无法创建项目', 400, 'empty_title');
  }

  const [dupRows] = await db.query<RowDataPacket[]>(
    `SELECT id FROM projects WHERE name = ? LIMIT 1`,
    [projectName],
  );
  if (dupRows.length > 0) {
    throw new PromoteTodoError('已有同名项目，请修改待办标题后再升级', 409, 'duplicate_name');
  }

  const projectId = String(input.projectId ?? '').trim() || makeProjectId();
  const categoryId =
    input.categoryId == null || String(input.categoryId).trim() === ''
      ? null
      : String(input.categoryId).trim();
  const now = formatUtcMySQLDateTime(new Date());
  const projectExtra = buildProjectExtraFromTask(task.extra_data);
  const priority = Number.isFinite(Number(task.priority)) ? Math.trunc(Number(task.priority)) : 0;
  const note = task.note == null || String(task.note).trim() === '' ? null : String(task.note).trim();
  const dueDate = task.due_date == null || task.due_date === '' ? null : task.due_date;

  const subtreeIds = await collectSubtreeIds(taskId);
  if (subtreeIds.length === 0) {
    throw new PromoteTodoError('待办不存在或已删除', 404, 'not_found');
  }

  await withSyncTransaction(async (conn) => {
    const insertCols: string[] = ['id', 'name', 'status', 'created_at', 'updated_at'];
    const insertVals: unknown[] = [projectId, projectName, 'todo', now, now];

    if (projectCols.has('category_id')) {
      insertCols.push('category_id');
      insertVals.push(categoryId);
    }
    if (projectCols.has('priority')) {
      insertCols.push('priority');
      insertVals.push(priority);
    }
    if (projectCols.has('note')) {
      insertCols.push('note');
      insertVals.push(note);
    }
    if (projectCols.has('due_date')) {
      insertCols.push('due_date');
      insertVals.push(dueDate);
    }
    if (projectCols.has('extra_data')) {
      insertCols.push('extra_data');
      insertVals.push(projectExtra);
    }
    if (projectCols.has('inbox_entered_at')) {
      insertCols.push('inbox_entered_at');
      insertVals.push(null);
    }
    if (projectCols.has('sync_status')) {
      insertCols.push('sync_status');
      insertVals.push('synced');
    }

    try {
      await conn.query<ResultSetHeader>(
        `INSERT INTO projects (${insertCols.map(quoteIdent).join(', ')})
         VALUES (${insertCols.map(() => '?').join(', ')})`,
        insertVals,
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
        throw new PromoteTodoError('项目 id 冲突，请重试', 409, 'duplicate_id');
      }
      throw err;
    }

    const projectStamp = await stampLiveUpsert(conn, 'projects', projectId, {
      mode: 'insert',
      mutationId: options.mutationId,
    });

    await conn.query<ResultSetHeader>(
      `UPDATE tasks
          SET project_id = ?,
              updated_at = ?,
              sync_status = CASE
                WHEN sync_status = 'pending_create' THEN 'pending_create'
                WHEN sync_status = 'pending_delete' THEN 'pending_delete'
                ELSE 'synced'
              END
        WHERE id IN (${subtreeIds.map(() => '?').join(', ')})`,
      [projectId, now, ...subtreeIds],
    );

    const changeEvents = [
      {
        tableName: 'projects',
        recordPk: projectId,
        op: 'upsert' as const,
        updatedAt: now,
        deviceId: options.deviceId,
        hint: { reason: 'promote_todo_to_project', taskId },
        serverRev: projectStamp.serverRev,
        mutationId: projectStamp.mutationId,
      },
    ];

    for (const tid of subtreeIds) {
      const stamp = await stampLiveUpsert(conn, 'tasks', tid, {
        mode: 'update',
        mutationId: options.mutationId,
        skipOcc: true,
      });
      changeEvents.push({
        tableName: 'tasks',
        recordPk: tid,
        op: 'upsert',
        updatedAt: now,
        deviceId: options.deviceId,
        hint: { reason: 'promote_todo_to_project', projectId },
        serverRev: stamp.serverRev,
        mutationId: stamp.mutationId,
      });
    }

    await appendChangeLog(conn, changeEvents);
  });

  return {
    projectId,
    projectName,
    taskId,
    affectedTaskIds: subtreeIds,
  };
}
