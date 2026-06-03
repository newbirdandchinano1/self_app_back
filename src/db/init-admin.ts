import { randomUUID } from 'crypto';
import { db } from './index.js';
import { hashPassword } from '../utils/password.js';

const DEFAULT_ADMIN = {
  username: 'admin',
  password: 'zhen8907146',
  phone: '18081654196',
};

export async function initAdminTable(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id varchar(36) NOT NULL,
      username varchar(64) NOT NULL,
      password_hash varchar(255) NOT NULL,
      phone varchar(20) NOT NULL,
      created_at datetime NOT NULL,
      updated_at datetime NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uk_admin_users_username (username),
      UNIQUE KEY uk_admin_users_phone (phone)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [rows] = await db.query<{ id: string }[]>(
    'SELECT id FROM admin_users WHERE username = ? LIMIT 1',
    [DEFAULT_ADMIN.username],
  );

  if (rows.length > 0) {
    return;
  }

  const now = new Date();
  const passwordHash = await hashPassword(DEFAULT_ADMIN.password);

  await db.query(
    `INSERT INTO admin_users (id, username, password_hash, phone, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [randomUUID(), DEFAULT_ADMIN.username, passwordHash, DEFAULT_ADMIN.phone, now, now],
  );

  console.log('[DB] 默认管理员账号已创建');
}
