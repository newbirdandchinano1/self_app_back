/** 允许通过 API 操作的表白名单 */
export const ALLOWED_TABLES = [
  'account_transactions',
  'accounts',
  'admin_users',
  'app_meta',
  'app_settings',
  'cash_flow_expense_lines',
  'cash_flow_holdings',
  'cash_flow_incomes',
  'cash_flow_profile',
  'daily_review_journal',
  'earned_rewards',
  'finance_account_types',
  'finance_accounts',
  'finance_flow_categories',
  'finance_transactions',
  'frog_completion_events',
  'goal_dimensions',
  'habit_check_ins',
  'habit_contexts',
  'habits',
  'health_records',
  'memo_dimensions',
  'memos',
  'project_categories',
  'projects',
  'recipe_categories',
  'recipe_items',
  'review_columns',
  'review_dimensions',
  'savings_plan_deposits',
  'savings_plans',
  'task_categories',
  'task_execution_events',
  'task_items',
  'tasks',
  'user_weaknesses',
  'users',
  'visions',
  'weekly_review_journal',
  'wish_items',
] as const;

export type AllowedTable = (typeof ALLOWED_TABLES)[number];

/** 非 id 主键的表 */
export const TABLE_PRIMARY_KEYS: Partial<Record<AllowedTable, string>> = {
  app_meta: 'key',
  app_settings: 'key',
};

/** 创建时必须由客户端提供 id，服务端不自动生成（用于多端同步） */
export const CLIENT_ID_TABLES: readonly AllowedTable[] = [
  'project_categories',
  'projects',
  'task_categories',
];

/** 外键字段 -> 引用表（用于写入校验与 /api/tables 元数据） */
export const TABLE_FOREIGN_KEYS: Partial<
  Record<AllowedTable, Partial<Record<string, AllowedTable>>>
> = {
  tasks: {
    category_id: 'task_categories',
    project_id: 'projects',
    parent_task_id: 'tasks',
  },
  projects: {
    category_id: 'project_categories',
  },
  task_items: {
    task_id: 'tasks',
  },
  memos: {
    dimension_id: 'memo_dimensions',
  },
};

/** 同步上传时的前置依赖表（需先完成 POST，再上传当前表） */
export const TABLE_SYNC_DEPENDS_ON: Partial<Record<AllowedTable, AllowedTable[]>> = {
  tasks: ['task_categories', 'project_categories', 'projects'],
  task_items: ['tasks'],
  projects: ['project_categories'],
  memos: ['memo_dimensions'],
};

/** 响应中隐藏的字段 */
export const HIDDEN_COLUMNS: Partial<Record<AllowedTable, string[]>> = {
  admin_users: ['password_hash'],
};

/** Admin 数据面板写入时自动管理、无需手填的字段 */
export const ADMIN_AUTO_MANAGED_COLUMNS = [
  'created_at',
  'updated_at',
  'sync_status',
] as const;

/** Admin 新增记录时的默认同步状态（已同步，非 pending_*） */
export const ADMIN_DEFAULT_SYNC_STATUS = 'synced';

/** 写入时明文字段 -> 哈希字段 */
export const PASSWORD_FIELDS: Partial<Record<AllowedTable, { plain: string; hash: string }>> = {
  admin_users: { plain: 'password', hash: 'password_hash' },
};

export function isAllowedTable(name: string): name is AllowedTable {
  return (ALLOWED_TABLES as readonly string[]).includes(name);
}

export function getPrimaryKey(table: AllowedTable): string {
  return TABLE_PRIMARY_KEYS[table] ?? 'id';
}

export function requiresClientId(table: AllowedTable): boolean {
  return (CLIENT_ID_TABLES as readonly string[]).includes(table);
}
