import { db } from './index.js';
import { columnExists, ensureColumn, indexExists, tableExists } from './schema-helpers.js';

const REV_SQL = `BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调'`;
const MUTATION_SQL = `VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id'`;

/**
 * 幂等：我的道路 — life_directions / life_bets + projects.life_bet_id。
 * OCC 列随建表带上（013 不会对后续新表重跑）。
 */
export async function ensureLifeRoadTables(): Promise<void> {
  await ensureLifeDirectionsTable();
  await ensureLifeBetsTable();
  await ensureProjectsLifeBetId();
}

async function ensureLifeDirectionsTable(): Promise<void> {
  if (!(await tableExists('life_directions'))) {
    await db.query(`
      CREATE TABLE life_directions (
        id VARCHAR(36) NOT NULL,
        body TEXT NOT NULL COMMENT '总方向，1–200 字',
        year_theme VARCHAR(40) NULL COMMENT '年主题，0–40 字',
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        sync_status VARCHAR(32) NOT NULL DEFAULT 'pending_create',
        extra_data JSON NULL,
        server_rev BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调',
        mutation_id VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id',
        PRIMARY KEY (id),
        KEY idx_life_directions_updated_at (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[DB] 已创建表 life_directions');
    return;
  }

  await ensureColumn('life_directions', 'year_theme', `VARCHAR(40) NULL COMMENT '年主题，0–40 字'`, {
    after: 'body',
  });
  await ensureColumn('life_directions', 'server_rev', REV_SQL, {
    after: (await columnExists('life_directions', 'extra_data')) ? 'extra_data' : undefined,
  });
  await ensureColumn('life_directions', 'mutation_id', MUTATION_SQL, {
    after: (await columnExists('life_directions', 'server_rev')) ? 'server_rev' : undefined,
  });
  if (!(await indexExists('life_directions', 'idx_life_directions_updated_at'))) {
    await db.query(
      `CREATE INDEX idx_life_directions_updated_at ON life_directions (updated_at)`,
    );
    console.log('[DB] 已创建索引 idx_life_directions_updated_at');
  }
}

async function ensureLifeBetsTable(): Promise<void> {
  if (!(await tableExists('life_bets'))) {
    await db.query(`
      CREATE TABLE life_bets (
        id VARCHAR(36) NOT NULL,
        title VARCHAR(40) NOT NULL COMMENT '赌注标题，1–40 字',
        horizon VARCHAR(16) NOT NULL COMMENT 'year | multi | farther',
        year INT NULL COMMENT '公历年；horizon=year 时必填',
        note VARCHAR(200) NULL COMMENT '做成了长什么样，0–200 字',
        status VARCHAR(16) NOT NULL DEFAULT 'on_track' COMMENT 'on_track | paused | arrived | dropped',
        sort_order INT NOT NULL DEFAULT 1000,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        sync_status VARCHAR(32) NOT NULL DEFAULT 'pending_create',
        extra_data JSON NULL,
        server_rev BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调',
        mutation_id VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id',
        PRIMARY KEY (id),
        KEY idx_life_bets_horizon_year_sort (horizon, year, sort_order),
        KEY idx_life_bets_status (status),
        KEY idx_life_bets_updated_at (updated_at),
        CONSTRAINT chk_life_bets_horizon CHECK (horizon IN ('year', 'multi', 'farther')),
        CONSTRAINT chk_life_bets_status CHECK (status IN ('on_track', 'paused', 'arrived', 'dropped'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[DB] 已创建表 life_bets');
    return;
  }

  await ensureColumn('life_bets', 'server_rev', REV_SQL, {
    after: (await columnExists('life_bets', 'extra_data')) ? 'extra_data' : undefined,
  });
  await ensureColumn('life_bets', 'mutation_id', MUTATION_SQL, {
    after: (await columnExists('life_bets', 'server_rev')) ? 'server_rev' : undefined,
  });
  if (!(await indexExists('life_bets', 'idx_life_bets_horizon_year_sort'))) {
    await db.query(
      `CREATE INDEX idx_life_bets_horizon_year_sort ON life_bets (horizon, year, sort_order)`,
    );
    console.log('[DB] 已创建索引 idx_life_bets_horizon_year_sort');
  }
  if (!(await indexExists('life_bets', 'idx_life_bets_status'))) {
    await db.query(`CREATE INDEX idx_life_bets_status ON life_bets (status)`);
    console.log('[DB] 已创建索引 idx_life_bets_status');
  }
  if (!(await indexExists('life_bets', 'idx_life_bets_updated_at'))) {
    await db.query(`CREATE INDEX idx_life_bets_updated_at ON life_bets (updated_at)`);
    console.log('[DB] 已创建索引 idx_life_bets_updated_at');
  }
}

/** projects.life_bet_id 可空；不强制 MySQL FK（与 category_id 同口径） */
async function ensureProjectsLifeBetId(): Promise<void> {
  if (!(await tableExists('projects'))) return;
  const after = (await columnExists('projects', 'category_id'))
    ? 'category_id'
    : (await columnExists('projects', 'status'))
      ? 'status'
      : undefined;
  await ensureColumn(
    'projects',
    'life_bet_id',
    `VARCHAR(36) NULL COMMENT '归属道路赌注 life_bets.id，可空'`,
    { after },
  );
  if (!(await indexExists('projects', 'idx_projects_life_bet_id'))) {
    await db.query(`CREATE INDEX idx_projects_life_bet_id ON projects (life_bet_id)`);
    console.log('[DB] 已创建索引 idx_projects_life_bet_id');
  }
}
