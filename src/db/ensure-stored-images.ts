import { db } from './index.js';
import { checkConstraintExists, indexExists, tableExists } from './schema-helpers.js';

const OWNER_CHECK = 'chk_stored_images_owner';

/**
 * 幂等：统一图片登记表 `stored_images`。
 * 一行对应磁盘上一个文件。不进通用 CRUD 白名单，也不进 APP 同步快照。
 */
export async function ensureStoredImagesTable(): Promise<void> {
  if (!(await tableExists('stored_images'))) {
    await db.query(`
      CREATE TABLE stored_images (
        id VARCHAR(36) NOT NULL,
        uri VARCHAR(512) NOT NULL,
        filename VARCHAR(255) NOT NULL,
        mime VARCHAR(64) NOT NULL,
        byte_size INT UNSIGNED NOT NULL,
        purpose VARCHAR(32) NULL,
        owner_table VARCHAR(64) NULL,
        owner_id VARCHAR(255) NULL,
        owner_field VARCHAR(64) NULL,
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_stored_images_uri (uri),
        KEY ix_stored_images_owner (owner_table, owner_id),
        CONSTRAINT ${OWNER_CHECK} CHECK (
          (owner_table IS NULL AND owner_id IS NULL AND owner_field IS NULL)
          OR (owner_table IS NOT NULL AND owner_id IS NOT NULL AND owner_field IS NOT NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[DB] 已创建表 stored_images');
    return;
  }

  if (!(await indexExists('stored_images', 'uq_stored_images_uri'))) {
    await db.query(`CREATE UNIQUE INDEX uq_stored_images_uri ON stored_images (uri)`);
    console.log('[DB] 已创建索引 uq_stored_images_uri');
  }
  if (!(await indexExists('stored_images', 'ix_stored_images_owner'))) {
    await db.query(
      `CREATE INDEX ix_stored_images_owner ON stored_images (owner_table, owner_id)`,
    );
    console.log('[DB] 已创建索引 ix_stored_images_owner');
  }
  if (!(await checkConstraintExists('stored_images', OWNER_CHECK))) {
    await db.query(`
      ALTER TABLE stored_images
      ADD CONSTRAINT ${OWNER_CHECK} CHECK (
        (owner_table IS NULL AND owner_id IS NULL AND owner_field IS NULL)
        OR (owner_table IS NOT NULL AND owner_id IS NOT NULL AND owner_field IS NOT NULL)
      )
    `);
    console.log('[DB] 已创建约束 chk_stored_images_owner');
  }
}
