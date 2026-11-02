import type { ResultSetHeader } from 'mysql2';
import { db } from './index.js';
import { columnExists, ensureColumn, indexExists, tableExists } from './schema-helpers.js';

const REV_SQL = `BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调'`;
const MUTATION_SQL = `VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id'`;

/** 默认衣橱（稳定 id，客户端可对齐） */
export const WARDROBE_DEFAULT_CLOSET_ID = 'wcloset_default';

const BUILTIN_CATEGORIES: ReadonlyArray<{
  id: string;
  name: string;
  sort_order: number;
  tint: string;
  tint2: string;
  tone: string;
}> = [
  { id: 'wcat_uncategorized', name: '未分类', sort_order: 10, tint: '#DCE8E5', tint2: '#C3D6D0', tone: '#36584F' },
  { id: 'wcat_tops', name: '上衣', sort_order: 20, tint: '#E8E8DC', tint2: '#D5D6C6', tone: '#5F684E' },
  { id: 'wcat_bottoms', name: '下装', sort_order: 30, tint: '#E9E3D4', tint2: '#D7CDB9', tone: '#786A4F' },
  { id: 'wcat_dresses', name: '连衣裙', sort_order: 40, tint: '#F0E2D6', tint2: '#DEC9B5', tone: '#936C50' },
  { id: 'wcat_outerwear', name: '外套', sort_order: 50, tint: '#E2E7DD', tint2: '#CBD4C4', tone: '#596750' },
  { id: 'wcat_sports', name: '运动装', sort_order: 60, tint: '#E0E9E9', tint2: '#C9D9D9', tone: '#4E6B71' },
  { id: 'wcat_formal', name: '正装', sort_order: 70, tint: '#E6E3DB', tint2: '#CFCCC1', tone: '#65645C' },
  { id: 'wcat_shoes', name: '鞋履', sort_order: 80, tint: '#EFE7D9', tint2: '#DCCDB8', tone: '#826C4F' },
  { id: 'wcat_accessories', name: '配饰', sort_order: 90, tint: '#F1E4D4', tint2: '#DFC7A8', tone: '#8D6743' },
];

const BUILTIN_OCCASIONS: ReadonlyArray<{ id: string; name: string; sort_order: number }> = [
  { id: 'wocc_work', name: '工作', sort_order: 10 },
  { id: 'wocc_formal', name: '正装', sort_order: 20 },
  { id: 'wocc_casual', name: '休闲', sort_order: 30 },
  { id: 'wocc_sport', name: '运动', sort_order: 40 },
  { id: 'wocc_party', name: '派对', sort_order: 50 },
  { id: 'wocc_home', name: '居家', sort_order: 60 },
  { id: 'wocc_vacation', name: '度假', sort_order: 70 },
];

/**
 * 幂等：文档 §3 全部 9 张衣橱表 + 默认衣橱 / 内置分类 / 内置场合。
 * OCC 列随建表带上（013 不会对后续新表重跑）。
 */
export async function ensureWardrobeTables(): Promise<void> {
  await ensureClosetsTable();
  await ensureCategoriesTable();
  await ensureOccasionsTable();
  await ensureItemsTable();
  await ensureOutfitsTable();
  await ensureOutfitItemsTable();
  await ensureWearLogsTable();
  await ensureOptionValuesTable();
  await ensureBodyProfileTable();
  await seedBuiltinWardrobeRows();
}

async function ensureClosetsTable(): Promise<void> {
  if (!(await tableExists('wardrobe_closets'))) {
    await db.query(`
      CREATE TABLE wardrobe_closets (
        id VARCHAR(36) NOT NULL,
        name VARCHAR(255) NOT NULL COMMENT '衣橱名称',
        sort_order INT NOT NULL DEFAULT 1000,
        is_default TINYINT NOT NULL DEFAULT 0 COMMENT '1=默认衣橱',
        note TEXT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        sync_status VARCHAR(32) NOT NULL DEFAULT 'pending_create',
        extra_data JSON NULL,
        server_rev BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调',
        mutation_id VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id',
        PRIMARY KEY (id),
        KEY idx_wardrobe_closets_sort (sort_order),
        KEY idx_wardrobe_closets_updated_at (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[DB] 已创建表 wardrobe_closets');
    return;
  }
  await ensureOccColumns('wardrobe_closets');
  if (!(await indexExists('wardrobe_closets', 'idx_wardrobe_closets_updated_at'))) {
    await db.query(
      `CREATE INDEX idx_wardrobe_closets_updated_at ON wardrobe_closets (updated_at)`,
    );
    console.log('[DB] 已创建索引 idx_wardrobe_closets_updated_at');
  }
}

async function ensureCategoriesTable(): Promise<void> {
  if (!(await tableExists('wardrobe_categories'))) {
    await db.query(`
      CREATE TABLE wardrobe_categories (
        id VARCHAR(36) NOT NULL,
        closet_id VARCHAR(36) NOT NULL COMMENT '所属衣橱 wardrobe_closets.id',
        name VARCHAR(255) NOT NULL,
        sort_order INT NOT NULL DEFAULT 1000,
        tint VARCHAR(32) NULL,
        tint2 VARCHAR(32) NULL,
        tone VARCHAR(32) NULL,
        is_builtin TINYINT NOT NULL DEFAULT 0 COMMENT '1=系统预置',
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        sync_status VARCHAR(32) NOT NULL DEFAULT 'pending_create',
        extra_data JSON NULL,
        server_rev BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调',
        mutation_id VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id',
        PRIMARY KEY (id),
        KEY idx_wardrobe_categories_closet_sort (closet_id, sort_order),
        KEY idx_wardrobe_categories_updated_at (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[DB] 已创建表 wardrobe_categories');
    return;
  }
  await ensureOccColumns('wardrobe_categories');
  if (!(await indexExists('wardrobe_categories', 'idx_wardrobe_categories_closet_sort'))) {
    await db.query(
      `CREATE INDEX idx_wardrobe_categories_closet_sort ON wardrobe_categories (closet_id, sort_order)`,
    );
    console.log('[DB] 已创建索引 idx_wardrobe_categories_closet_sort');
  }
}

async function ensureOccasionsTable(): Promise<void> {
  if (!(await tableExists('wardrobe_occasions'))) {
    await db.query(`
      CREATE TABLE wardrobe_occasions (
        id VARCHAR(36) NOT NULL,
        name VARCHAR(64) NOT NULL,
        sort_order INT NOT NULL DEFAULT 1000,
        is_builtin TINYINT NOT NULL DEFAULT 0 COMMENT '1=系统预置',
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        sync_status VARCHAR(32) NOT NULL DEFAULT 'pending_create',
        extra_data JSON NULL,
        server_rev BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调',
        mutation_id VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id',
        PRIMARY KEY (id),
        KEY idx_wardrobe_occasions_sort (sort_order),
        KEY idx_wardrobe_occasions_updated_at (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[DB] 已创建表 wardrobe_occasions');
    return;
  }
  await ensureOccColumns('wardrobe_occasions');
  if (!(await indexExists('wardrobe_occasions', 'idx_wardrobe_occasions_updated_at'))) {
    await db.query(
      `CREATE INDEX idx_wardrobe_occasions_updated_at ON wardrobe_occasions (updated_at)`,
    );
    console.log('[DB] 已创建索引 idx_wardrobe_occasions_updated_at');
  }
}

async function ensureItemsTable(): Promise<void> {
  if (!(await tableExists('wardrobe_items'))) {
    await db.query(`
      CREATE TABLE wardrobe_items (
        id VARCHAR(36) NOT NULL,
        closet_id VARCHAR(36) NOT NULL COMMENT '所属衣橱',
        category_id VARCHAR(36) NOT NULL COMMENT '分类 wardrobe_categories.id',
        name VARCHAR(255) NOT NULL,
        brand VARCHAR(255) NULL,
        color VARCHAR(128) NULL,
        season VARCHAR(64) NULL COMMENT '规范化季节串，如 春/秋',
        price_cents INT NULL COMMENT '价格（分）',
        currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
        fit VARCHAR(64) NULL COMMENT '版型/尺码文案',
        warmth VARCHAR(64) NULL COMMENT '适穿温度',
        sku_code VARCHAR(64) NULL COMMENT '如 HOODIE / 001',
        art_key VARCHAR(32) NULL COMMENT '无图时线稿 key',
        tint VARCHAR(32) NULL,
        tint2 VARCHAR(32) NULL,
        line VARCHAR(32) NULL,
        tags_json TEXT NULL COMMENT '单品标签 JSON 数组',
        image_uri VARCHAR(512) NULL COMMENT '原图 stored_images.uri',
        cutout_uri VARCHAR(512) NULL COMMENT '抠图透明 PNG uri',
        purchased_on VARCHAR(32) NULL COMMENT '购入/入库日',
        status VARCHAR(32) NOT NULL DEFAULT 'active' COMMENT 'active | archived | disposed',
        wear_count INT NOT NULL DEFAULT 0 COMMENT '冗余缓存，权威来自 wear_logs',
        last_worn_on CHAR(10) NULL COMMENT 'YYYY-MM-DD',
        note TEXT NULL,
        extra_data TEXT NULL COMMENT '扩展 JSON 文案',
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        sync_status VARCHAR(32) NOT NULL DEFAULT 'pending_create',
        server_rev BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调',
        mutation_id VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id',
        PRIMARY KEY (id),
        KEY idx_wardrobe_items_closet_updated (closet_id, updated_at),
        KEY idx_wardrobe_items_category (category_id),
        KEY idx_wardrobe_items_status (status),
        KEY idx_wardrobe_items_updated_at (updated_at),
        CONSTRAINT chk_wardrobe_items_status CHECK (status IN ('active', 'archived', 'disposed'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[DB] 已创建表 wardrobe_items');
    return;
  }
  await ensureOccColumns('wardrobe_items');
  if (!(await indexExists('wardrobe_items', 'idx_wardrobe_items_closet_updated'))) {
    await db.query(
      `CREATE INDEX idx_wardrobe_items_closet_updated ON wardrobe_items (closet_id, updated_at)`,
    );
    console.log('[DB] 已创建索引 idx_wardrobe_items_closet_updated');
  }
  if (!(await indexExists('wardrobe_items', 'idx_wardrobe_items_category'))) {
    await db.query(
      `CREATE INDEX idx_wardrobe_items_category ON wardrobe_items (category_id)`,
    );
    console.log('[DB] 已创建索引 idx_wardrobe_items_category');
  }
}

async function ensureOutfitsTable(): Promise<void> {
  if (!(await tableExists('wardrobe_outfits'))) {
    await db.query(`
      CREATE TABLE wardrobe_outfits (
        id VARCHAR(36) NOT NULL,
        closet_id VARCHAR(36) NOT NULL,
        name VARCHAR(255) NOT NULL,
        occasion_id VARCHAR(36) NULL COMMENT 'wardrobe_occasions.id',
        note TEXT NULL,
        cover_item_id VARCHAR(36) NULL COMMENT '封面单品',
        wear_count INT NOT NULL DEFAULT 0 COMMENT '冗余缓存',
        last_worn_on CHAR(10) NULL COMMENT 'YYYY-MM-DD',
        status VARCHAR(32) NOT NULL DEFAULT 'active' COMMENT 'active | archived',
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        sync_status VARCHAR(32) NOT NULL DEFAULT 'pending_create',
        extra_data JSON NULL,
        server_rev BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调',
        mutation_id VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id',
        PRIMARY KEY (id),
        KEY idx_wardrobe_outfits_closet_updated (closet_id, updated_at),
        KEY idx_wardrobe_outfits_occasion (occasion_id),
        KEY idx_wardrobe_outfits_status (status),
        KEY idx_wardrobe_outfits_updated_at (updated_at),
        CONSTRAINT chk_wardrobe_outfits_status CHECK (status IN ('active', 'archived'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[DB] 已创建表 wardrobe_outfits');
    return;
  }
  await ensureOccColumns('wardrobe_outfits');
  if (!(await indexExists('wardrobe_outfits', 'idx_wardrobe_outfits_closet_updated'))) {
    await db.query(
      `CREATE INDEX idx_wardrobe_outfits_closet_updated ON wardrobe_outfits (closet_id, updated_at)`,
    );
    console.log('[DB] 已创建索引 idx_wardrobe_outfits_closet_updated');
  }
}

async function ensureOutfitItemsTable(): Promise<void> {
  if (!(await tableExists('wardrobe_outfit_items'))) {
    await db.query(`
      CREATE TABLE wardrobe_outfit_items (
        id VARCHAR(36) NOT NULL,
        outfit_id VARCHAR(36) NOT NULL,
        item_id VARCHAR(36) NOT NULL,
        sort_order INT NOT NULL DEFAULT 1000 COMMENT '拼贴叠放顺序',
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        sync_status VARCHAR(32) NOT NULL DEFAULT 'pending_create',
        extra_data JSON NULL,
        server_rev BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调',
        mutation_id VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id',
        PRIMARY KEY (id),
        UNIQUE KEY uq_wardrobe_outfit_items_pair (outfit_id, item_id),
        KEY idx_wardrobe_outfit_items_item (item_id),
        KEY idx_wardrobe_outfit_items_updated_at (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[DB] 已创建表 wardrobe_outfit_items');
    return;
  }
  await ensureOccColumns('wardrobe_outfit_items');
  if (!(await indexExists('wardrobe_outfit_items', 'uq_wardrobe_outfit_items_pair'))) {
    await db.query(
      `CREATE UNIQUE INDEX uq_wardrobe_outfit_items_pair ON wardrobe_outfit_items (outfit_id, item_id)`,
    );
    console.log('[DB] 已创建索引 uq_wardrobe_outfit_items_pair');
  }
}

async function ensureWearLogsTable(): Promise<void> {
  if (!(await tableExists('wardrobe_wear_logs'))) {
    await db.query(`
      CREATE TABLE wardrobe_wear_logs (
        id VARCHAR(36) NOT NULL,
        closet_id VARCHAR(36) NOT NULL,
        worn_on CHAR(10) NOT NULL COMMENT '逻辑日 YYYY-MM-DD',
        source VARCHAR(32) NOT NULL COMMENT 'item | outfit | manual_day',
        item_id VARCHAR(36) NULL COMMENT '穿单品时必填',
        outfit_id VARCHAR(36) NULL COMMENT '穿搭配时必填',
        note VARCHAR(255) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        sync_status VARCHAR(32) NOT NULL DEFAULT 'pending_create',
        extra_data JSON NULL,
        server_rev BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调',
        mutation_id VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id',
        PRIMARY KEY (id),
        KEY idx_wardrobe_wear_logs_closet_day (closet_id, worn_on),
        KEY idx_wardrobe_wear_logs_item_day (item_id, worn_on),
        KEY idx_wardrobe_wear_logs_outfit_day (outfit_id, worn_on),
        KEY idx_wardrobe_wear_logs_updated_at (updated_at),
        CONSTRAINT chk_wardrobe_wear_logs_source CHECK (source IN ('item', 'outfit', 'manual_day'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[DB] 已创建表 wardrobe_wear_logs');
    return;
  }
  await ensureOccColumns('wardrobe_wear_logs');
  if (!(await indexExists('wardrobe_wear_logs', 'idx_wardrobe_wear_logs_closet_day'))) {
    await db.query(
      `CREATE INDEX idx_wardrobe_wear_logs_closet_day ON wardrobe_wear_logs (closet_id, worn_on)`,
    );
    console.log('[DB] 已创建索引 idx_wardrobe_wear_logs_closet_day');
  }
  if (!(await indexExists('wardrobe_wear_logs', 'idx_wardrobe_wear_logs_item_day'))) {
    await db.query(
      `CREATE INDEX idx_wardrobe_wear_logs_item_day ON wardrobe_wear_logs (item_id, worn_on)`,
    );
    console.log('[DB] 已创建索引 idx_wardrobe_wear_logs_item_day');
  }
}

async function ensureOptionValuesTable(): Promise<void> {
  if (!(await tableExists('wardrobe_option_values'))) {
    await db.query(`
      CREATE TABLE wardrobe_option_values (
        id VARCHAR(36) NOT NULL,
        closet_id VARCHAR(36) NULL COMMENT '可空：全局；有值则按衣橱',
        kind VARCHAR(32) NOT NULL COMMENT 'color | brand | season | fit 等',
        value VARCHAR(255) NOT NULL COMMENT '展示文案',
        sort_order INT NOT NULL DEFAULT 1000,
        is_builtin TINYINT NOT NULL DEFAULT 0 COMMENT '1=系统预置',
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        sync_status VARCHAR(32) NOT NULL DEFAULT 'pending_create',
        extra_data JSON NULL,
        server_rev BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调',
        mutation_id VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id',
        PRIMARY KEY (id),
        KEY idx_wardrobe_option_values_kind_sort (kind, sort_order),
        KEY idx_wardrobe_option_values_closet (closet_id),
        KEY idx_wardrobe_option_values_updated_at (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[DB] 已创建表 wardrobe_option_values');
    return;
  }
  await ensureOccColumns('wardrobe_option_values');
  if (!(await indexExists('wardrobe_option_values', 'idx_wardrobe_option_values_kind_sort'))) {
    await db.query(
      `CREATE INDEX idx_wardrobe_option_values_kind_sort ON wardrobe_option_values (kind, sort_order)`,
    );
    console.log('[DB] 已创建索引 idx_wardrobe_option_values_kind_sort');
  }
}

async function ensureBodyProfileTable(): Promise<void> {
  if (!(await tableExists('wardrobe_body_profile'))) {
    await db.query(`
      CREATE TABLE wardrobe_body_profile (
        id VARCHAR(36) NOT NULL,
        closet_id VARCHAR(36) NULL COMMENT '可空：全局；有值则按衣橱',
        height_cm DECIMAL(6,2) NULL,
        weight_kg DECIMAL(6,2) NULL,
        shoulder_cm DECIMAL(6,2) NULL,
        bust_cm DECIMAL(6,2) NULL,
        waist_cm DECIMAL(6,2) NULL,
        hip_cm DECIMAL(6,2) NULL,
        inseam_cm DECIMAL(6,2) NULL COMMENT '腿长',
        foot_mm DECIMAL(6,2) NULL COMMENT '脚长 mm',
        size_top VARCHAR(32) NULL COMMENT '上装默认尺码',
        size_bottom VARCHAR(32) NULL COMMENT '下装默认尺码',
        size_shoe VARCHAR(32) NULL COMMENT '鞋履默认尺码',
        note TEXT NULL,
        extra_data JSON NULL COMMENT '扩展量体字段',
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        sync_status VARCHAR(32) NOT NULL DEFAULT 'pending_create',
        server_rev BIGINT NOT NULL DEFAULT 1 COMMENT '同步版本，跨删建严格单调',
        mutation_id VARCHAR(36) NULL COMMENT '最近一次 Push 的 mutation_id',
        PRIMARY KEY (id),
        KEY idx_wardrobe_body_profile_closet (closet_id),
        KEY idx_wardrobe_body_profile_updated_at (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[DB] 已创建表 wardrobe_body_profile');
    return;
  }
  await ensureOccColumns('wardrobe_body_profile');
  if (!(await indexExists('wardrobe_body_profile', 'idx_wardrobe_body_profile_updated_at'))) {
    await db.query(
      `CREATE INDEX idx_wardrobe_body_profile_updated_at ON wardrobe_body_profile (updated_at)`,
    );
    console.log('[DB] 已创建索引 idx_wardrobe_body_profile_updated_at');
  }
}

async function ensureOccColumns(table: string): Promise<void> {
  await ensureColumn(table, 'server_rev', REV_SQL, {
    after: (await columnExists(table, 'updated_at')) ? 'updated_at' : undefined,
  });
  await ensureColumn(table, 'mutation_id', MUTATION_SQL, {
    after: (await columnExists(table, 'server_rev')) ? 'server_rev' : undefined,
  });
}

/** 预置默认衣橱、内置分类、内置场合（固定 id，可重复执行） */
async function seedBuiltinWardrobeRows(): Promise<void> {
  const [closetResult] = await db.query<ResultSetHeader>(
    `INSERT INTO wardrobe_closets
       (id, name, sort_order, is_default, note, created_at, updated_at, sync_status, server_rev)
     VALUES (?, '常穿', 10, 1, NULL, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), 'synced', 1)
     ON DUPLICATE KEY UPDATE id = id`,
    [WARDROBE_DEFAULT_CLOSET_ID],
  );
  if (closetResult.affectedRows === 1) {
    console.log('[DB] 已初始化 wardrobe_closets 默认衣橱');
  }

  let catInserted = 0;
  for (const cat of BUILTIN_CATEGORIES) {
    const [r] = await db.query<ResultSetHeader>(
      `INSERT INTO wardrobe_categories
         (id, closet_id, name, sort_order, tint, tint2, tone, is_builtin,
          created_at, updated_at, sync_status, server_rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), 'synced', 1)
       ON DUPLICATE KEY UPDATE id = id`,
      [cat.id, WARDROBE_DEFAULT_CLOSET_ID, cat.name, cat.sort_order, cat.tint, cat.tint2, cat.tone],
    );
    if (r.affectedRows === 1) catInserted += 1;
  }
  if (catInserted > 0) {
    console.log(`[DB] 已初始化 wardrobe_categories 内置分类 ${catInserted} 条`);
  }

  let occInserted = 0;
  for (const occ of BUILTIN_OCCASIONS) {
    const [r] = await db.query<ResultSetHeader>(
      `INSERT INTO wardrobe_occasions
         (id, name, sort_order, is_builtin, created_at, updated_at, sync_status, server_rev)
       VALUES (?, ?, ?, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), 'synced', 1)
       ON DUPLICATE KEY UPDATE id = id`,
      [occ.id, occ.name, occ.sort_order],
    );
    if (r.affectedRows === 1) occInserted += 1;
  }
  if (occInserted > 0) {
    console.log(`[DB] 已初始化 wardrobe_occasions 内置场合 ${occInserted} 条`);
  }
}
