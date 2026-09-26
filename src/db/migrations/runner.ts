import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { db } from '../index.js';
import { MIGRATIONS } from './registry.js';

async function ensureMigrationsTable(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(128) NOT NULL,
      applied_at DATETIME(3) NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function loadAppliedIds(): Promise<Set<string>> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id FROM schema_migrations`,
  );
  return new Set(rows.map((r) => String(r.id)));
}

async function markApplied(id: string): Promise<void> {
  await db.query<ResultSetHeader>(
    `INSERT INTO schema_migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))`,
    [id],
  );
}

/**
 * 按 registry 顺序执行未应用迁移。各 migration.up 须幂等（兼容旧库已跑过 ensure-*）。
 */
export async function runPendingMigrations(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await loadAppliedIds();
  let ran = 0;

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    console.log(`[DB] migration ${migration.id} …`);
    await migration.up();
    await markApplied(migration.id);
    console.log(`[DB] migration ${migration.id} done`);
    ran += 1;
  }

  if (ran === 0) {
    console.log(`[DB] schema_migrations：已是最新（${MIGRATIONS.length}）`);
  } else {
    console.log(`[DB] schema_migrations：本次应用 ${ran} 条`);
  }
}
