import { db } from './index.js';
import { columnExists, indexExists, tableExists } from './schema-helpers.js';

/**
 * 阶段 B0：任务页热点查询索引（幂等）。
 * 无 user_id 列，禁止照抄带 user_id 的模板。
 * 谓词对齐：project_id / parent_task_id / status / category_id / created_at / assigned_ymd。
 *
 * 列多为 varchar(255)+utf8mb4（单列索引占 1020B）。InnoDB 复合索引上限 3072B，
 * 故对超长 varchar 使用前缀：id/外键 191、status/action 32、时间戳 64。
 */
async function ensureIndex(
  table: string,
  indexName: string,
  createSql: string,
): Promise<boolean> {
  if (!(await tableExists(table))) return false;
  if (await indexExists(table, indexName)) return false;
  try {
    await db.query(createSql);
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_KEYNAME') return false;
    throw err;
  }
  console.log(`[DB] 已创建索引 ${table}.${indexName}`);
  return true;
}

export async function ensureTasksPageHotIndexes(): Promise<void> {
  if (await tableExists('tasks')) {
    await ensureIndex(
      'tasks',
      'idx_tasks_project_status_updated',
      `CREATE INDEX idx_tasks_project_status_updated
       ON tasks (project_id(191), status(32), updated_at(64), id(191))`,
    );
    // parent_task_id 在部分环境为 TEXT，前缀索引足够支撑 BFS IN (...)
    if (await columnExists('tasks', 'parent_task_id')) {
      await ensureIndex(
        'tasks',
        'idx_tasks_parent_task_id',
        `CREATE INDEX idx_tasks_parent_task_id ON tasks (parent_task_id(191))`,
      );
    }
    await ensureIndex(
      'tasks',
      'idx_tasks_status_updated',
      `CREATE INDEX idx_tasks_status_updated
       ON tasks (status(32), updated_at(64), id(191))`,
    );
  }

  if (await tableExists('projects')) {
    await ensureIndex(
      'projects',
      'idx_projects_category_updated',
      `CREATE INDEX idx_projects_category_updated
       ON projects (category_id(191), updated_at(64), id(191))`,
    );
    await ensureIndex(
      'projects',
      'idx_projects_updated_at',
      `CREATE INDEX idx_projects_updated_at ON projects (updated_at(64), id(191))`,
    );
  }

  if (await tableExists('task_execution_events')) {
    await ensureIndex(
      'task_execution_events',
      'idx_tevt_task_created',
      `CREATE INDEX idx_tevt_task_created
       ON task_execution_events (task_id(191), created_at(64))`,
    );
    await ensureIndex(
      'task_execution_events',
      'idx_tevt_action_created',
      `CREATE INDEX idx_tevt_action_created
       ON task_execution_events (action(32), created_at(64))`,
    );
  }

  if (await tableExists('frog_completion_events')) {
    await ensureIndex(
      'frog_completion_events',
      'idx_frog_assigned_created',
      `CREATE INDEX idx_frog_assigned_created
       ON frog_completion_events (assigned_ymd(32), created_at(64))`,
    );
  }
}
