import { db } from './index.js';
import { columnExists, ensureColumn, indexExists, tableExists } from './schema-helpers.js';

const REV_SQL = `BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调'`;
const MUTATION_SQL = `VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id'`;

/**
 * 幂等：道路年季月节点 life_road_nodes + projects.life_month_goal_id。
 */
export async function ensureLifeRoadNodesTables(): Promise<void> {
  await ensureLifeRoadNodesTable();
  await ensureProjectsLifeMonthGoalId();
}

async function ensureLifeRoadNodesTable(): Promise<void> {
  if (!(await tableExists('life_road_nodes'))) {
    await db.query(`
      CREATE TABLE life_road_nodes (
        id VARCHAR(36) NOT NULL,
        kind VARCHAR(16) NOT NULL COMMENT 'multi | farther | year | quarter | month',
        title VARCHAR(40) NOT NULL COMMENT '方向短句，1–40 字',
        note VARCHAR(200) NULL COMMENT '说明，0–200 字',
        calendar_year INT NULL COMMENT '公历年；年/季/月必填',
        quarter TINYINT NULL COMMENT '1–4；季/月使用',
        month TINYINT NULL COMMENT '1–12；月目标使用',
        parent_id VARCHAR(36) NULL COMMENT '季→年、月→季；可空',
        status VARCHAR(16) NOT NULL DEFAULT 'on_track'
          COMMENT 'on_track | paused | arrived | dropped',
        sort_order INT NOT NULL DEFAULT 1000,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        sync_status VARCHAR(32) NOT NULL DEFAULT 'pending_create',
        extra_data JSON NULL,
        server_rev BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调',
        mutation_id VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id',
        PRIMARY KEY (id),
        KEY idx_life_road_nodes_kind_year (kind, calendar_year, quarter, month, sort_order),
        KEY idx_life_road_nodes_parent (parent_id),
        KEY idx_life_road_nodes_status (status),
        KEY idx_life_road_nodes_updated_at (updated_at),
        CONSTRAINT chk_life_road_nodes_kind
          CHECK (kind IN ('multi', 'farther', 'year', 'quarter', 'month')),
        CONSTRAINT chk_life_road_nodes_status
          CHECK (status IN ('on_track', 'paused', 'arrived', 'dropped'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[DB] 已创建表 life_road_nodes');
    return;
  }

  await ensureColumn('life_road_nodes', 'server_rev', REV_SQL, {
    after: (await columnExists('life_road_nodes', 'extra_data')) ? 'extra_data' : undefined,
  });
  await ensureColumn('life_road_nodes', 'mutation_id', MUTATION_SQL, {
    after: (await columnExists('life_road_nodes', 'server_rev')) ? 'server_rev' : undefined,
  });
  if (!(await indexExists('life_road_nodes', 'idx_life_road_nodes_kind_year'))) {
    await db.query(
      `CREATE INDEX idx_life_road_nodes_kind_year
       ON life_road_nodes (kind, calendar_year, quarter, month, sort_order)`,
    );
  }
  if (!(await indexExists('life_road_nodes', 'idx_life_road_nodes_parent'))) {
    await db.query(`CREATE INDEX idx_life_road_nodes_parent ON life_road_nodes (parent_id)`);
  }
  if (!(await indexExists('life_road_nodes', 'idx_life_road_nodes_updated_at'))) {
    await db.query(
      `CREATE INDEX idx_life_road_nodes_updated_at ON life_road_nodes (updated_at)`,
    );
  }
}

async function ensureProjectsLifeMonthGoalId(): Promise<void> {
  if (!(await tableExists('projects'))) return;
  const after = (await columnExists('projects', 'life_bet_id'))
    ? 'life_bet_id'
    : (await columnExists('projects', 'category_id'))
      ? 'category_id'
      : undefined;
  await ensureColumn(
    'projects',
    'life_month_goal_id',
    `VARCHAR(36) NULL COMMENT '归属月目标 life_road_nodes.id（kind=month），可空'`,
    { after },
  );
  if (!(await indexExists('projects', 'idx_projects_life_month_goal_id'))) {
    await db.query(
      `CREATE INDEX idx_projects_life_month_goal_id ON projects (life_month_goal_id)`,
    );
    console.log('[DB] 已创建索引 idx_projects_life_month_goal_id');
  }
}
