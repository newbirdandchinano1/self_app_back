/** 独立待办（Overview Scope）过滤条件，与 APP `TASK_OVERVIEW_SCOPE_WHERE` 一致 */
export const OVERVIEW_SCOPE_TASK_WHERE = `(project_id IS NULL OR TRIM(project_id) = '')
  AND (parent_task_id IS NULL OR TRIM(parent_task_id) = '')`;

export function overviewScopeTaskSql(alias = ''): string {
  const p = alias ? `${alias}.project_id` : 'project_id';
  const pt = alias ? `${alias}.parent_task_id` : 'parent_task_id';
  return `(${p} IS NULL OR TRIM(${p}) = '') AND (${pt} IS NULL OR TRIM(${pt}) = '')`;
}

/** 事件是否属于 overview scope（含已删独立待办的事件快照） */
export function isOverviewScopeEvent(
  taskId: string,
  scopeTaskIds: Set<string>,
  allTaskIds: Set<string>,
): boolean {
  const id = taskId.trim();
  if (!id) return false;
  if (scopeTaskIds.has(id)) return true;
  return !allTaskIds.has(id);
}

export function overviewScopeEventSql(teeAlias = 'tee'): string {
  const tScope = overviewScopeTaskSql('t');
  return `(
    EXISTS (
      SELECT 1 FROM tasks t
      WHERE t.id = ${teeAlias}.task_id
      AND ${tScope}
    )
    OR (
      ${teeAlias}.task_id IS NOT NULL AND TRIM(${teeAlias}.task_id) != ''
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = ${teeAlias}.task_id)
    )
  )`;
}
