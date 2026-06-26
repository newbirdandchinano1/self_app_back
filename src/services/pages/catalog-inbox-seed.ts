import { createRecord, getRecord } from '../crud.js';

export const INBOX_PROJECT_CATEGORY_ID = 'project_category_inbox';
export const INBOX_PROJECT_CATEGORY_NAME = '收集箱';

const INBOX_SEED_TIMESTAMP = '2026-01-01 00:00:00';

const INBOX_TABLES = ['project_categories', 'task_categories'] as const;

async function ensureInboxRow(table: (typeof INBOX_TABLES)[number]): Promise<void> {
  const existing = await getRecord(table, INBOX_PROJECT_CATEGORY_ID);
  if (existing) return;

  try {
    await createRecord(
      table,
      {
        id: INBOX_PROJECT_CATEGORY_ID,
        name: INBOX_PROJECT_CATEGORY_NAME,
        sort_order: 0,
        created_at: INBOX_SEED_TIMESTAMP,
        updated_at: INBOX_SEED_TIMESTAMP,
        extra_data: null,
      },
      { adminPanel: true },
    );
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') return;
    throw err;
  }
}

/** 确保收集箱分类在 project_categories / task_categories 中持久存在 */
export async function ensureInboxCatalogSeed(): Promise<void> {
  for (const table of INBOX_TABLES) {
    await ensureInboxRow(table);
  }
}
