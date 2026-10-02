/**
 * 简易滑动窗口限流（进程内）。
 * 适合单实例；多实例需换 Redis 等共享存储。
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly maxHits: number,
    private readonly windowMs: number,
  ) {
    if (maxHits < 1) throw new Error('SlidingWindowRateLimiter maxHits must be >= 1');
    if (windowMs < 1) throw new Error('SlidingWindowRateLimiter windowMs must be >= 1');
  }

  /** @returns true 表示允许通过 */
  tryConsume(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.hits.get(key);
    if (!timestamps) {
      timestamps = [];
      this.hits.set(key, timestamps);
    }
    // 丢弃窗口外
    while (timestamps.length > 0 && timestamps[0]! < cutoff) {
      timestamps.shift();
    }
    if (timestamps.length >= this.maxHits) {
      return false;
    }
    timestamps.push(now);
    return true;
  }

  /** 距可再请求的秒数（向上取整）；未超限返回 0 */
  retryAfterSec(key: string): number {
    const timestamps = this.hits.get(key);
    if (!timestamps || timestamps.length === 0) return 0;
    const oldest = timestamps[0]!;
    const waitMs = oldest + this.windowMs - Date.now();
    if (waitMs <= 0) return 0;
    return Math.ceil(waitMs / 1000);
  }

  /** 测试用 */
  reset(key?: string): void {
    if (key == null) {
      this.hits.clear();
      return;
    }
    this.hits.delete(key);
  }

  get size(): number {
    return this.hits.size;
  }
}
