/**
 * Time primitives.
 *
 * The clock is an injectable dependency so that time-sensitive components
 * (circuit breaker, rate limiter) can be unit tested deterministically.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: (): number => Date.now(),
};

/** Deterministic clock used in tests. */
export class FakeClock implements Clock {
  constructor(private current: number = 0) {}

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(ms: number): void {
    this.current = ms;
  }
}

/**
 * Promise-based sleep that resolves early when the supplied signal aborts.
 * Resolving (instead of rejecting) on abort keeps call sites free of noise:
 * callers re-check their own cancellation flag right after awaiting.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const secondsToMs = (seconds: number): number => Math.round(seconds * 1000);
