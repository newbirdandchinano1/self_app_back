/**
 * 允许通过 API 操作的表白名单。
 *
 * 财务权威账本：`finance_*`（账户 / 流水 / 分类 / 定时支出）。
 * 卫星能力（非第二套账本）：`cash_flow_*`、`savings_*`。
 * 已下线遗留表：`accounts`、`account_transactions`（勿再加回白名单）。
 */
export const ALLOWED_TABLES = [
  'admin_users',
  'app_meta',
  'app_settings',
  'cash_flow_expense_lines',
  'cash_flow_holdings',
  'cash_flow_incomes',
  'cash_flow_profile',
  'daily_review_journal',
  'finance_account_types',
  'finance_accounts',
  'finance_flow_categories',
  'finance_scheduled_expenses',
  'finance_transactions',
  'frog_completion_events',
  'habit_check_ins',
  'habit_contexts',
  'habits',
  'health_daily_targets',
  'health_records',
  'memo_dimensions',
  'memos',
  'monthly_review_journal',
  'points_ledger',
  'points_wallet',
  'wish_board_items',
  'project_categories',
  'project_completion_logs',
  'projects',
  'tag_links',
  'tags',
  'recipe_categories',
  'recipe_items',
  'review_columns',
  'review_dimensions',
  'savings_plan_deposits',
  'savings_plans',
  'schedule_placements',
  'schedule_week_axis_snapshot',
  'task_categories',
  'task_execution_events',
  'task_items',
  'tasks',
  'users',
  'weekly_review_journal',
] as const;

export type AllowedTable = (typeof ALLOWED_TABLES)[number];

/** 非 id 主键的表 */
export const TABLE_PRIMARY_KEYS: Partial<Record<AllowedTable, string>> = {
  app_meta: 'key',
  app_settings: 'key',
  schedule_week_axis_snapshot: 'week_start_ymd',
};

/** 创建时必须由客户端提供 id，服务端不自动生成（用于多端同步） */
export const CLIENT_ID_TABLES: readonly AllowedTable[] = [
  'points_ledger',
  'wish_board_items',
  'project_categories',
  'projects',
  'schedule_placements',
  'tag_links',
  'tags',
  'task_categories',
];

/**
 * 外键字段 -> 引用表（用于写入校验与 /api/tables 元数据）
 *
 * 注意：`frog_completion_events.task_id` **不得**映射到 `tasks`。
 * 该字段语义是「青蛙主体 id」——任务青蛙存 `tasks.id`，无子任务的项目青蛙存 `projects.id`。
 * 若做成仅引用 tasks 的外键，项目青蛙同步会 INSERT 失败。
 */
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
  tag_links: {
    tag_id: 'tags',
  },
  task_items: {
    task_id: 'tasks',
  },
  recipe_items: {
    category_id: 'recipe_categories',
  },
  finance_scheduled_expenses: {
    account_id: 'finance_accounts',
    flow_category_id: 'finance_flow_categories',
  },
};

/** 同步上传时的前置依赖表（需先完成 POST，再上传当前表） */
export const TABLE_SYNC_DEPENDS_ON: Partial<Record<AllowedTable, AllowedTable[]>> = {
  tasks: ['task_categories', 'project_categories', 'projects'],
  task_items: ['tasks'],
  projects: ['project_categories'],
  tag_links: ['tags'],
  recipe_items: ['recipe_categories'],
  finance_scheduled_expenses: ['finance_accounts', 'finance_flow_categories'],
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
  'deleted_at',
  'version',
] as const;

/** Admin 表单仅可查看、不可改写的业务字段 */
export const ADMIN_READONLY_COLUMNS = ['category_id', 'parent_task_id', 'icon', 'tone'] as const;

/** Admin 新增记录时的默认同步状态（已同步，非 pending_*） */
export const ADMIN_DEFAULT_SYNC_STATUS = 'synced';

export type EnumOption = { value: string; label: string };

/** 任务 status 固定取值（与 App 日历/列表过滤口径一致） */
export const TASK_STATUS_OPTIONS: readonly EnumOption[] = [
  { value: 'todo', label: '待办' },
  { value: 'done', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
  { value: 'shelved', label: '已搁置' },
];

export const TASK_STATUS_VALUES = TASK_STATUS_OPTIONS.map((o) => o.value);

/** 待办事项（task_execution_events）action 固定取值 */
export const TASK_EXECUTION_ACTION_OPTIONS: readonly EnumOption[] = [
  { value: 'completed', label: '完成' },
  { value: 'reopened', label: '重新打开' },
];

export const TASK_EXECUTION_ACTION_VALUES = TASK_EXECUTION_ACTION_OPTIONS.map((o) => o.value);

/** 项目 status 固定取值（与日历/列表 excludeArchived 口径一致） */
export const PROJECT_STATUS_OPTIONS: readonly EnumOption[] = [
  { value: 'active', label: '进行中' },
  { value: 'completed', label: '已完成' },
  { value: 'archived', label: '已归档' },
];

export const PROJECT_STATUS_VALUES = PROJECT_STATUS_OPTIONS.map((o) => o.value);

/** Admin 表单用下拉框的枚举字段 */
export const TABLE_ENUM_COLUMNS: Partial<
  Record<AllowedTable, Partial<Record<string, readonly EnumOption[]>>>
> = {
  tag_links: {
    entity_type: [
      { value: 'project', label: '项目' },
      { value: 'habit', label: '习惯' },
      { value: 'task', label: '任务/待办' },
      { value: 'memo', label: '备忘录' },
    ],
  },
  tasks: {
    status: TASK_STATUS_OPTIONS,
  },
  task_execution_events: {
    action: TASK_EXECUTION_ACTION_OPTIONS,
  },
  frog_completion_events: {
    action: TASK_EXECUTION_ACTION_OPTIONS,
  },
  projects: {
    status: PROJECT_STATUS_OPTIONS,
  },
};

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

/**
 * 高危表：禁止经 `/api/data/:table` 通用 POST/PUT/PATCH/DELETE。
 * 只允许 GET；写入必须走专用业务接口（事务 / 校验 / 级联）。
 * 管理后台 `x-admin-panel` 同样禁止，避免万能钥匙绕过钱包等逻辑。
 */
export const GENERIC_WRITE_FORBIDDEN_TABLES = {
  points_ledger:
    'POST /api/app/points/adjust、DELETE /api/app/points/ledger/:id（勿直接写流水）',
  points_wallet:
    'POST /api/app/points/adjust、GET /api/app/points/balance（禁止直接改余额）',
  wish_board_items:
    'POST/PATCH/DELETE /api/app/wish-board/items、POST /api/app/wish-board/redeem',
  memos: 'POST/PUT/DELETE /api/app/memos',
  /** 维度已下线，仅保留读；写入应走 tags */
  memo_dimensions: '（已下线）分类请用 tags / tag_links',
  health_records: 'POST/PUT/PATCH/DELETE /api/app/health/intakes',
  recipe_categories: 'POST/PATCH/DELETE /api/app/recipes/categories',
  recipe_items: 'POST/PUT/DELETE /api/app/recipes',
  /** 课表仅视图/排课层：写入走 frog-schedule 专用接口 */
  schedule_placements: 'POST /api/app/pages/tasks/frog-schedule/placement',
  schedule_week_axis_snapshot:
    'POST /api/app/pages/tasks/frog-schedule/axis（周轴由服务端随轴设置写入快照）',
  finance_transactions:
    'POST/PUT/PATCH/DELETE /api/app/pages/finance/transactions',
} as const satisfies Partial<Record<AllowedTable, string>>;

export type GenericWriteForbiddenTable = keyof typeof GENERIC_WRITE_FORBIDDEN_TABLES;

export function isGenericWriteForbidden(table: string): table is GenericWriteForbiddenTable {
  return Object.prototype.hasOwnProperty.call(GENERIC_WRITE_FORBIDDEN_TABLES, table);
}

export function getGenericWriteForbiddenHint(table: string): string | null {
  if (!isGenericWriteForbidden(table)) return null;
  return GENERIC_WRITE_FORBIDDEN_TABLES[table];
}

/** 构造 403 文案：表名 + 正确端点提示 */
export function formatGenericWriteForbiddenMessage(table: string): string {
  const hint = getGenericWriteForbiddenHint(table);
  if (!hint) {
    return `表 ${table} 禁止通过通用 CRUD 写入，请使用专用业务接口`;
  }
  return `表 ${table} 禁止通过 /api/data 通用写入，请改用：${hint}`;
}
