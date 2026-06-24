export class ConcurrencyLimiter {
  private active = 0;

  constructor(private readonly max: number) {
    if (max < 1) {
      throw new Error('ConcurrencyLimiter max must be at least 1');
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get maxConcurrent(): number {
    return this.max;
  }

  tryAcquire(): boolean {
    if (this.active >= this.max) {
      return false;
    }
    this.active += 1;
    return true;
  }

  release(): void {
    if (this.active > 0) {
      this.active -= 1;
    }
  }
}
