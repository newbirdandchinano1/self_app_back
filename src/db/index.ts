import mysql from 'mysql2/promise';
import { dbConfig } from '../config/index.js';

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
});

export async function testConnection(): Promise<void> {
  const conn = await db.getConnection();
  conn.release();
}
