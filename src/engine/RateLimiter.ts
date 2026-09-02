import { OperationAbortedError } from '../utils/errors';
import { type Clock, delay, systemClock } from '../utils/time';

/**
 * Contract every caller depends on. A worker asks for permission to perform one
 * upstream request and is suspended until the global budget allows it.
 */
export interface IRateLimiter {
  /** Resolves once a token has been consumed. Rejects if `signal` aborts. */
  acquire(signal?: AbortSignal): Promise<void>;
  /** Tokens currently available (diagnostics / tests). */
  readonly availableTokens: number;
  /** Number of callers currently queued behind the bucket. */
  readonly queueLength: number;
}

export interface RateLimiterOptions {
  /** Bucket size, i.e. maximum requests per window. */
  capacity: number;
  /** Window length in milliseconds. */
  windowMs: number;
  clock?: Clock;
}

/**
 * Token bucket with sliding-window regeneration.
 *
 * A token consumed at time `t` is returned to the bucket at exactly
 * `t + windowMs`. This is stricter than the classic "refill the whole bucket
 * every window" variant, which allows a double burst across a window boundary
 * (10 calls at the end of window N plus 10 at the start of window N+1 = 20
 * calls inside a 60 second sliding window). With regeneration tied to each
 * individual consumption, **no** 60 second sliding window can ever contain more
 * than `capacity` requests — which is what the assignment requires.
 *
 * Waiters are served strictly FIFO through a promise chain, so a worker can
 * never be starved by later arrivals.
 */
export class TokenBucketRateLimiter implements IRateLimiter {
  private readonly capacity: number;
  private readonly windowMs: number;
  private readonly clock: Clock;

  /** Timestamps of the tokens currently "in flight" (ascending order). */
  private readonly consumedAt: number[] = [];

  /** Tail of the FIFO chain; awaiting it serialises acquisition. */
  private tail: Promise<void> = Promise.resolve();

  private waiting = 0;

  constructor(options: RateLimiterOptions) {
    if (options.capacity <= 0) {
      throw new Error('RateLimiter capacity must be greater than zero');
    }
    if (options.windowMs <= 0) {
      throw new Error('RateLimiter windowMs must be greater than zero');
    }

    this.capacity = options.capacity;
    this.windowMs = options.windowMs;
    this.clock = options.clock ?? systemClock;
  }

  get availableTokens(): number {
    this.prune();
    return Math.max(0, this.capacity - this.consumedAt.length);
  }

  get queueLength(): number {
    return this.waiting;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);

    // Enqueue: wait for the previous caller to finish, then become the tail.
    const predecessor = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.waiting += 1;

    try {
      await predecessor;

      for (;;) {
        this.throwIfAborted(signal);
        this.prune();

        if (this.consumedAt.length < this.capacity) {
          this.consumedAt.push(this.clock.now());
          return;
        }

        const oldest = this.consumedAt[0] as number;
        const waitMs = Math.max(1, oldest + this.windowMs - this.clock.now());
        await delay(waitMs, signal);
      }
    } finally {
      this.waiting -= 1;
      release();
    }
  }

  /** Drop tokens whose window has elapsed – they are available again. */
  private prune(): void {
    const cutoff = this.clock.now() - this.windowMs;
    while (this.consumedAt.length > 0 && (this.consumedAt[0] as number) <= cutoff) {
      this.consumedAt.shift();
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new OperationAbortedError('Rate limiter acquisition aborted');
    }
  }
}
