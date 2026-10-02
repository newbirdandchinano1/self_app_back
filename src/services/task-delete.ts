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
  executor: SqlExecutor,
  events: ChangeLogEvent[],
  deviceId?: string | null,
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
    const [existing] = await executor.query<RowDataPacket[]>(
      `SELECT ${quoteIdent(meta.primaryKey)} AS pk FROM ${quoteIdent(table)}
       WHERE task_id IN (${chunk.map(() => '?').join(', ')})`,
      chunk,
    );
    for (const row of existing) {
      events.push({
        tableName: table,
        recordPk: String(row.pk),
        op: 'delete',
        deviceId,
      });
    }
    if (existing.length === 0) continue;
    await executor.query<ResultSetHeader>(
      `DELETE FROM ${quoteIdent(table)} WHERE task_id IN (${chunk.map(() => '?').join(', ')})`,
      chunk,
    );
  }
}

async function deleteTasksInTreeOrder(
  taskIds: string[],
  executor: SqlExecutor,
): Promise<void> {
  if (taskIds.length === 0) return;

  const idSet = new Set(taskIds);
  const [rows] = await executor.query<RowDataPacket[]>(
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
  while (remaining.size > 0) {
    const leaves = [...remaining].filter((id) => {
      const children = childrenByParent.get(id) ?? [];
      return !children.some((childId) => remaining.has(childId));
    });

    if (leaves.length === 0) {
      const fallback = [...remaining];
      await executor.query<ResultSetHeader>(
        `DELETE FROM tasks WHERE id IN (${fallback.map(() => '?').join(', ')})`,
        fallback,
      );
      return;
    }

    await executor.query<ResultSetHeader>(
      `DELETE FROM tasks WHERE id IN (${leaves.map(() => '?').join(', ')})`,
      leaves,
    );
    for (const id of leaves) remaining.delete(id);
  }
}

/**
 * 递归删除任务及其所有子孙任务，并清理关联的 task_items / 事件记录。
 * 若根任务不存在返回 false（幂等：子任务已被级联删除时同样返回 false）。
 * 与 Change Log 同事务：回滚时无脏 log。
 */
export async function deleteTaskCascade(
  taskId: string,
  options: DeleteTaskCascadeOptions = {},
): Promise<boolean> {
  return withSyncTransaction(async (conn) => {
    const [rootRows] = await conn.query<RowDataPacket[]>(
      'SELECT id FROM tasks WHERE id = ? LIMIT 1',
      [taskId],
    );
    if (rootRows.length === 0) return false;

    const taskIds = await collectTaskSubtreeIds(taskId, conn);
    const events: ChangeLogEvent[] = [];

    for (const table of TASK_RELATED_TABLES) {
      await deleteRelatedRowsByTaskIds(table, taskIds, conn, events, options.deviceId);
    }
    await deleteTasksInTreeOrder(taskIds, conn);

    for (const id of taskIds) {
      events.push({
        tableName: 'tasks',
        recordPk: id,
        op: 'delete',
        deviceId: options.deviceId,
      });
    }

    await appendChangeLog(conn, events);
    return true;
  });
}
