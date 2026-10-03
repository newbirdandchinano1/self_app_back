import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { type AllowedTable } from '../config/tables.js';
import { db } from '../db/index.js';
import { getTableMeta } from './crud.js';
import {
  appendChangeLog,
  withSyncTransaction,
  type ChangeLogEvent,
} from './sync-change-log.js';
import { deleteLiveWithRevision, readLiveServerRev, SyncOccConflictError } from './sync-revision.js';

/**
 * 任务删除时清理的从表。
 * 故意不含 `frog_completion_events`：热力图/日历依赖事件行 + `task_title` 快照，
 * 主体（任务/项目）删除后仍须保留「已完成青蛙」记录；项目青蛙的 task_id 存的是 project id。
 */
const TASK_RELATED_TABLES: AllowedTable[] = [
  'task_items',
  'task_execution_events',
];

export type DeleteTaskCascadeOptions = {
  deviceId?: string | null;
  mutationId?: string | null;
  expectedRev?: number | null;
};

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

type SqlExecutor = {
  query: PoolConnection['query'];
};

async function collectTaskSubtreeIds(
  rootId: string,
  executor: SqlExecutor = db,
): Promise<string[]> {
  const ids = new Set<string>([rootId]);
  const queue = [rootId];

  while (queue.length > 0) {
    const batch = queue.splice(0, 200);
    const [rows] = await executor.query<RowDataPacket[]>(
      `SELECT id FROM tasks WHERE parent_task_id IN (${batch.map(() => '?').join(', ')})`,
      batch,
    );
    for (const row of rows) {
      const id = String(row.id);
      if (!ids.has(id)) {
        ids.add(id);
        queue.push(id);
      }
    }
  }

  return [...ids];
}

async function deleteRelatedRowsByTaskIds(
  table: AllowedTable,
  taskIds: string[],
  conn: PoolConnection,
  events: ChangeLogEvent[],
): Promise<void> {
  if (taskIds.length === 0) return;

  let meta;
  try {
    meta = await getTableMeta(table);
  } catch {
    return;
  }
  if (!meta.columns.includes('task_id')) return;

  const chunkSize = 200;
  for (let i = 0; i < taskIds.length; i += chunkSize) {
    const chunk = taskIds.slice(i, i + chunkSize);
    const [existing] = await conn.query<RowDataPacket[]>(
      `SELECT ${quoteIdent(meta.primaryKey)} AS pk FROM ${quoteIdent(table)}
       WHERE task_id IN (${chunk.map(() => '?').join(', ')})`,
      chunk,
    );
    for (const row of existing) {
      const pk = String(row.pk);
      const del = await deleteLiveWithRevision(conn, table, pk, { skipOcc: true });
      if (del.kind === 'deleted') {
        events.push({
          tableName: table,
          recordPk: pk,
          op: 'delete',
          serverRev: del.serverRev,
          mutationId: del.mutationId,
        });
      }
    }
  }
}

async function deleteTasksInTreeOrder(
  taskIds: string[],
  rootId: string,
  conn: PoolConnection,
  events: ChangeLogEvent[],
  rootMutationId: string | null,
): Promise<void> {
  if (taskIds.length === 0) return;

  const idSet = new Set(taskIds);
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT id, parent_task_id FROM tasks WHERE id IN (${taskIds.map(() => '?').join(', ')})`,
    taskIds,
  );

  const childrenByParent = new Map<string, string[]>();
  for (const row of rows) {
    const id = String(row.id);
    const parentId = String(row.parent_task_id ?? '');
    if (parentId && idSet.has(parentId)) {
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId)!.push(id);
    }
  }

  const remaining = new Set(taskIds);
  const deleteOne = async (id: string) => {
    const del = await deleteLiveWithRevision(conn, 'tasks', id, {
      skipOcc: true,
      mutationId: id === rootId ? rootMutationId : null,
    });
    if (del.kind === 'deleted') {
      events.push({
        tableName: 'tasks',
        recordPk: id,
        op: 'delete',
        serverRev: del.serverRev,
        mutationId: del.mutationId,
      });
    }
  };

  while (remaining.size > 0) {
    const leaves = [...remaining].filter((id) => {
      const children = childrenByParent.get(id) ?? [];
      return !children.some((childId) => remaining.has(childId));
    });

    if (leaves.length === 0) {
      for (const id of remaining) await deleteOne(id);
      return;
    }

    for (const id of leaves) {
      await deleteOne(id);
      remaining.delete(id);
    }
  }
}

/**
 * 递归删除任务及其所有子孙任务，并清理关联的 task_items / 事件记录。
 * 根任务已不存在：幂等成功。
 */
export async function deleteTaskCascade(
  taskId: string,
  options: DeleteTaskCascadeOptions = {},
): Promise<boolean> {
  return withSyncTransaction(async (conn) => {
    const live = await readLiveServerRev(conn, 'tasks', taskId);
    if (live == null) return true;
    if (options.expectedRev != null && options.expectedRev !== live) {
      const [rows] = await conn.query<RowDataPacket[]>(
        'SELECT * FROM tasks WHERE id = ? LIMIT 1',
        [taskId],
      );
      const row = rows[0] ? { ...(rows[0] as Record<string, unknown>) } : null;
      throw new SyncOccConflictError({
        kind: 'row',
        table: 'tasks',
        pk: taskId,
        serverRev: live,
        mutationId:
          row && row.mutation_id != null ? String(row.mutation_id).slice(0, 36) : null,
        row,
      });
    }

    const taskIds = await collectTaskSubtreeIds(taskId, conn);
    const events: ChangeLogEvent[] = [];

    for (const table of TASK_RELATED_TABLES) {
      await deleteRelatedRowsByTaskIds(table, taskIds, conn, events);
    }
    await deleteTasksInTreeOrder(
      taskIds,
      taskId,
      conn,
      events,
      options.mutationId ?? null,
    );

    if (events.length > 0) {
      for (const ev of events) {
        ev.deviceId = options.deviceId;
      }
      await appendChangeLog(conn, events);
    }
    return true;
  });
}
