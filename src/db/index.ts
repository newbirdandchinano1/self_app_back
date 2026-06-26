import mysql, { type RowDataPacket } from 'mysql2/promise';
import { dbConfig } from '../config/index.js';
import { APP_MYSQL_TIMEZONE } from '../config/timezone.js';

export const db = mysql.createPool({
  host: dbConfig.host,
  port: dbConfig.port,
  user: dbConfig.user,
  password: dbConfig.password,
  database: dbConfig.database,
  connectionLimit: dbConfig.connectionLimit,
  waitForConnections: true,
  queueLimit: 0,
  idleTimeout: 60000,
  /** DATETIME 按东八区读写；返回字符串避免 mysql2→Date 再丢时区 */
  timezone: APP_MYSQL_TIMEZONE,
  dateStrings: true,
});

export async function testConnection(): Promise<void> {
  const conn = await db.getConnection();
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT @@session.time_zone AS tz, NOW() AS now_local",
    );
    const row = rows[0];
    console.log(`[DB] session.time_zone=${row?.tz ?? '?'} NOW()=${row?.now_local ?? '?'}`);
  } finally {
    conn.release();
  }
}
