import { compareTaskAuditDatetime } from '../calendar/logical-day.js';

/**
 * 待办净完成口径（与 APP `filterNetCompletedTaskEvents` 对齐）：
 * - 非重复：同一 task_id 全局只保留最新一条；最新为 reopened 则任何一天都不计
 * - 重复：同一 task_id + 逻辑日只保留最新一次；各执行日可分别计一次
 */
export function filterNetCompletedEvents<
  T extends { task_id: string; action: string; created_at: string; logicalYmd: string },
>(events: T[], repeatingTaskIds: Set<string>): T[] {
  const latestByKey = new Map<string, T>();
  for (const event of events) {
    const taskId = event.task_id.trim();
    if (!taskId) continue;
    const groupKey = repeatingTaskIds.has(taskId) ? `${taskId}\0${event.logicalYmd}` : taskId;
    const prev = latestByKey.get(groupKey);
    if (!prev || compareTaskAuditDatetime(event.created_at, prev.created_at) > 0) {
      latestByKey.set(groupKey, event);
    }
  }
  return [...latestByKey.values()].filter((event) => event.action === 'completed');
}

/** 某日已在青蛙完成里出现的 task_id，待办区计数和明细都扣掉 */
export function excludeTodosAlreadyCountedAsFrogs<T extends { task_id: string }>(
  todos: T[],
  frogTaskIds: Set<string>,
): T[] {
  if (frogTaskIds.size === 0) return todos;
  return todos.filter((todo) => !frogTaskIds.has(todo.task_id));
}
