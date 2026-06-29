import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { type AllowedTable } from '../config/tables.js';
import { db } from '../db/index.js';
import { getTableMeta } from './crud.js';

const TASK_RELATED_TABLES: AllowedTable[] = [
  'task_items',
  'task_execution_events',
  'frog_completion_events',
];

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

async function collectTaskSubtreeIds(rootId: string): Promise<string[]> {
  const ids = new Set<string>([rootId]);
  const queue = [rootId];

  while (queue.length > 0) {
    const batch = queue.splice(0, 200);
    const [rows] = await db.query<RowDataPacket[]>(
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

async function deleteRelatedRowsByTaskIds(table: AllowedTable, taskIds: string[]): Promise<void> {
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
    await db.query<ResultSetHeader>(
      `DELETE FROM ${quoteIdent(table)} WHERE task_id IN (${chunk.map(() => '?').join(', ')})`,
      chunk,
    );
  }
}

async function deleteTasksInTreeOrder(taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;

  const idSet = new Set(taskIds);
  const [rows] = await db.query<RowDataPacket[]>(
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
      await db.query<ResultSetHeader>(
        `DELETE FROM tasks WHERE id IN (${fallback.map(() => '?').join(', ')})`,
        fallback,
      );
      return;
    }

    await db.query<ResultSetHeader>(
      `DELETE FROM tasks WHERE id IN (${leaves.map(() => '?').join(', ')})`,
      leaves,
    );
    for (const id of leaves) remaining.delete(id);
  }
}

/**
 * 递归删除任务及其所有子孙任务，并清理关联的 task_items / 事件记录。
 * 若根任务不存在返回 false（幂等：子任务已被级联删除时同样返回 false）。
 */
export async function deleteTaskCascade(taskId: string): Promise<boolean> {
  const [rootRows] = await db.query<RowDataPacket[]>(
    'SELECT id FROM tasks WHERE id = ? LIMIT 1',
    [taskId],
  );
  if (rootRows.length === 0) return false;

  const taskIds = await collectTaskSubtreeIds(taskId);

  for (const table of TASK_RELATED_TABLES) {
    await deleteRelatedRowsByTaskIds(table, taskIds);
  }
  await deleteTasksInTreeOrder(taskIds);

  return true;
}
