import mysql, {
  type FieldPacket,
  type Pool,
  type PoolConnection,
  type QueryResult,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';
import { dbConfig } from '../config/index.js';
import { APP_MYSQL_TIMEZONE } from '../config/timezone.js';
import {
  DbAcquireTimeoutError,
  DbQueueFullError,
  mapMysqlPoolError,
} from '../utils/db-errors.js';
import { recordDbAcquireWait, recordDbQuery } from '../utils/request-context.js';

const rawPool: Pool = mysql.createPool({
  host: dbConfig.host,
  port: dbConfig.port,
  user: dbConfig.user,
  password: dbConfig.password,
  database: dbConfig.database,
  connectionLimit: dbConfig.connectionLimit,
  waitForConnections: true,
  /** 0 = 无限排队（旧行为）；阶段 A 默认有限队列，满则快速失败 */
  queueLimit: dbConfig.queueLimit,
  idleTimeout: 60000,
  /** DATETIME 按东八区读写；返回字符串避免 mysql2→Date 再丢时区 */
  timezone: APP_MYSQL_TIMEZONE,
  dateStrings: true,
});

/** 进程内连接池占用计数（与 mysql2 内部队列互补，供指标） */
let trackedActive = 0;
let trackedWaiting = 0;

export type PoolStats = {
  active: number;
  idle: number;
  waiting: number;
  limit: number;
};

export function getPoolStats(): PoolStats {
  const limit = dbConfig.connectionLimit;
  const active = Math.max(0, trackedActive);
  return {
    active,
    idle: Math.max(0, limit - active),
    waiting: Math.max(0, trackedWaiting),
    limit,
  };
}

function wrapConnection(conn: PoolConnection): PoolConnection {
  trackedActive += 1;
  const origRelease = conn.release.bind(conn);
  let released = false;
  conn.release = () => {
    if (released) return;
    released = true;
    trackedActive = Math.max(0, trackedActive - 1);
    return origRelease();
  };
  return conn;
}

async function acquireConnection(): Promise<PoolConnection> {
  const timeoutMs = dbConfig.acquireTimeoutMs;
  const started = Date.now();
  trackedWaiting += 1;

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const conn = await new Promise<PoolConnection>((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new DbAcquireTimeoutError());
      }, timeoutMs);

      rawPool
        .getConnection()
        .then((c) => {
          if (timedOut) {
            try {
              c.release();
            } catch {
              /* ignore */
            }
            return;
          }
          resolve(c);
        })
        .catch((err: unknown) => {
          if (timedOut) return;
          try {
            mapMysqlPoolError(err);
          } catch (mapped) {
            reject(mapped);
          }
        });
    });

    recordDbAcquireWait(Date.now() - started);
    return wrapConnection(conn);
  } catch (err) {
    recordDbAcquireWait(Date.now() - started);
    if (err instanceof DbAcquireTimeoutError || err instanceof DbQueueFullError) {
      throw err;
    }
    mapMysqlPoolError(err);
    throw err;
  } finally {
    trackedWaiting = Math.max(0, trackedWaiting - 1);
    if (timer) clearTimeout(timer);
  }
}

async function queryWithMetrics<T extends QueryResult = RowDataPacket[]>(
  sql: string,
  params?: unknown,
): Promise<[T, FieldPacket[]]> {
  const conn = await acquireConnection();
  const q0 = Date.now();
  try {
    const result = (await conn.query(sql, params as never)) as [T, FieldPacket[]];
    recordDbQuery(Date.now() - q0, sql);
    return result;
  } catch (err) {
    recordDbQuery(Date.now() - q0, sql);
    throw err;
  } finally {
    conn.release();
  }
}

async function executeWithMetrics<T extends QueryResult = ResultSetHeader>(
  sql: string,
  params?: unknown,
): Promise<[T, FieldPacket[]]> {
  const conn = await acquireConnection();
  const q0 = Date.now();
  try {
    const result = (await conn.execute(sql, params as never)) as [T, FieldPacket[]];
    recordDbQuery(Date.now() - q0, sql);
    return result;
  } catch (err) {
    recordDbQuery(Date.now() - q0, sql);
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * 对外 DB 门面：与 mysql2 Pool 常用 API 兼容。
 * - query / execute：带 acquire 超时 + 耗时指标，连接 finally 释放
 * - getConnection：同样超时；调用方必须 release
 */
export const db = {
  query: ((sqlOrOpts: unknown, params?: unknown) => {
    if (typeof sqlOrOpts === 'string') {
      return queryWithMetrics(sqlOrOpts, params);
    }
    return rawPool.query(sqlOrOpts as never, params as never);
  }) as Pool['query'],

  execute: ((sqlOrOpts: unknown, params?: unknown) => {
    if (typeof sqlOrOpts === 'string') {
      return executeWithMetrics(sqlOrOpts, params);
    }
    return rawPool.execute(sqlOrOpts as never, params as never);
  }) as Pool['execute'],

  getConnection: acquireConnection,

  /** 原始池（迁移脚本 / 诊断）；业务路径请用上方封装 */
  raw: rawPool,

  end: () => rawPool.end(),
};

export async function testConnection(): Promise<void> {
  const conn = await db.getConnection();
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT @@session.time_zone AS tz, NOW() AS now_local',
    );
    const row = rows[0];
    console.log(`[DB] session.time_zone=${row?.tz ?? '?'} NOW()=${row?.now_local ?? '?'}`);
    console.log(
      `[DB] pool limit=${dbConfig.connectionLimit} queueLimit=${dbConfig.queueLimit} acquireTimeoutMs=${dbConfig.acquireTimeoutMs}`,
    );
  } finally {
    conn.release();
  }
}
