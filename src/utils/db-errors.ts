/** 连接池队列已满（queueLimit） */
export class DbQueueFullError extends Error {
  readonly code = 'DB_QUEUE_FULL';
  readonly status = 503;
  readonly retryAfterSec = 1;

  constructor(message = '数据库连接繁忙，请稍后重试') {
    super(message);
    this.name = 'DbQueueFullError';
  }
}

/** 获取连接超时（acquireTimeout） */
export class DbAcquireTimeoutError extends Error {
  readonly code = 'DB_ACQUIRE_TIMEOUT';
  readonly status = 503;
  readonly retryAfterSec = 1;

  constructor(message = '数据库连接等待超时，请稍后重试') {
    super(message);
    this.name = 'DbAcquireTimeoutError';
  }
}

export function isDbCapacityError(
  err: unknown,
): err is DbQueueFullError | DbAcquireTimeoutError {
  return err instanceof DbQueueFullError || err instanceof DbAcquireTimeoutError;
}

/** mysql2 队列满等原始错误 → 容量错误 */
export function mapMysqlPoolError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (/queue limit reached/i.test(msg)) {
    throw new DbQueueFullError();
  }
  throw err;
}
