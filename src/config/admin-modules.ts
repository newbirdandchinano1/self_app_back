import type { AllowedTable } from './tables.js';

/** 管理后台侧边栏一级模块 */
export type AdminModuleId =
  | 'health'
  | 'tasks'
  | 'finance'
  | 'review'
  | 'profile'
  | 'recipes'
  | 'memos'
  | 'wish'
  | 'system'
  | 'ai';

export type AdminModuleDef = {
  id: AdminModuleId;
  title: string;
  /** 归属本模块的数据表（顺序即侧边栏展示顺序） */
  tables: readonly AllowedTable[];
  /** 无表时可展示的说明（如 AI 模块） */
  emptyHint?: string;
};

/**
 * 管理后台侧边栏：10 个一级模块 → 细分数据表。
 * 未出现在任何模块中的表白名单表会落入「未分类」。
 */
export const ADMIN_MODULES: readonly AdminModuleDef[] = [
  {
    id: 'health',
    title: '健康模块',
    tables: ['health_daily_targets', 'health_records'],
  },
  {
    id: 'tasks',
    title: '任务模块',
    tables: [
      'task_categories',
      'tasks',
      'task_items',
      'task_execution_events',
      'project_categories',
      'projects',
      'frog_completion_events',
      'habits',
      'habit_contexts',
      'habit_check_ins',
    ],
  },
  {
    id: 'finance',
    title: '财务模块',
    tables: [
      'finance_account_types',
      'finance_accounts',
      'finance_flow_categories',
      'finance_transactions',
      'accounts',
      'account_transactions',
      'cash_flow_profile',
      'cash_flow_incomes',
      'cash_flow_expense_lines',
      'cash_flow_holdings',
      'savings_plans',
      'savings_plan_deposits',
    ],
  },
  {
    id: 'review',
    title: '复盘模块',
    tables: [
      'review_dimensions',
      'review_columns',
      'daily_review_journal',
      'weekly_review_journal',
      'monthly_review_journal',
    ],
  },
  {
    id: 'profile',
    title: '个人信息模块',
    tables: ['users'],
  },
  {
    id: 'recipes',
    title: '菜谱模块',
    tables: ['recipe_categories', 'recipe_items'],
  },
  {
    id: 'memos',
    title: '备忘录模块',
    tables: ['memo_dimensions', 'memos'],
  },
  {
    id: 'wish',
    title: '心愿板模块',
    tables: [
      'wish_board_items',
      'wish_items',
      'points_wallet',
      'points_ledger',
      'visions',
      'goal_dimensions',
    ],
  },
  {
    id: 'system',
    title: '系统配置模块',
    tables: ['app_settings', 'app_meta', 'admin_users'],
  },
  {
    id: 'ai',
    title: 'AI模块',
    tables: [],
    emptyHint: '暂无独立数据表。AI 能力通过 /api/app/ai 等接口提供，点评等字段写在各业务表中。',
  },
] as const;

const TABLE_TO_MODULE = new Map<AllowedTable, AdminModuleId>();
for (const mod of ADMIN_MODULES) {
  for (const table of mod.tables) {
    TABLE_TO_MODULE.set(table, mod.id);
  }
}

export function getAdminModuleIdForTable(table: AllowedTable): AdminModuleId | null {
  return TABLE_TO_MODULE.get(table) ?? null;
}

export function getAdminModuleTitle(moduleId: AdminModuleId): string {
  return ADMIN_MODULES.find((m) => m.id === moduleId)?.title ?? moduleId;
}
