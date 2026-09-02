import { CircuitOpenError } from '../utils/errors';
import { type Clock, systemClock } from '../utils/time';
import type { ILogger } from '../utils/logger';

export const CircuitState = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
} as const;

export type CircuitState = (typeof CircuitState)[keyof typeof CircuitState];

export interface ICircuitBreaker {
  /** Run `operation` if the circuit allows it, otherwise fail fast. */
  execute<T>(operation: () => Promise<T>): Promise<T>;
  readonly state: CircuitState;
  readonly failureCount: number;
  reset(): void;
}

export interface CircuitBreakerOptions {
  /** Consecutive failures required to trip the breaker. */
  failureThreshold: number;
  /** How long the circuit stays OPEN before a probe is allowed. */
  openTimeoutMs: number;
  clock?: Clock;
  logger?: ILogger;
  name?: string;
  /**
   * Decides whether an error counts towards the failure threshold. Cancellation
   * (e.g. the worker being stopped) must not trip the breaker.
   */
  isFailure?: (error: unknown) => boolean;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

/**
 * Classic three-state circuit breaker.
 *
 *   CLOSED ──(failureThreshold consecutive failures)──▶ OPEN
 *   OPEN ──(openTimeoutMs elapsed)──▶ HALF_OPEN
 *   HALF_OPEN ──(probe succeeds)──▶ CLOSED
 *   HALF_OPEN ──(probe fails)──▶ OPEN (timer restarts)
 *
 * One instance exists per polling worker, so a single dead match can never take
 * the whole service down, and a healthy match keeps polling while a broken one
 * backs off.
 */
export class CircuitBreaker implements ICircuitBreaker {
  private currentState: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  private readonly failureThreshold: number;
  private readonly openTimeoutMs: number;
  private readonly clock: Clock;
  private readonly logger?: ILogger;
  private readonly name: string;
  private readonly isFailure: (error: unknown) => boolean;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;

  constructor(options: CircuitBreakerOptions) {
    this.failureThreshold = Math.max(1, options.failureThreshold);
    this.openTimeoutMs = Math.max(1, options.openTimeoutMs);
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger;
    this.name = options.name ?? 'circuit-breaker';
    this.isFailure = options.isFailure ?? ((): boolean => true);
    this.onStateChange = options.onStateChange;
  }

  get state(): CircuitState {
    return this.evaluateState();
  }

  get failureCount(): number {
    return this.failures;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const state = this.evaluateState();

    if (state === CircuitState.OPEN) {
      const remainingMs = Math.max(0, this.openedAt + this.openTimeoutMs - this.clock.now());
      throw new CircuitOpenError(
        `Circuit "${this.name}" is OPEN; retry in ${Math.ceil(remainingMs / 1000)}s`,
      );
    }

    // In HALF_OPEN exactly one probe request is allowed through.
    if (state === CircuitState.HALF_OPEN) {
      if (this.probeInFlight) {
        throw new CircuitOpenError(`Circuit "${this.name}" is HALF_OPEN; probe already in flight`);
      }
      this.probeInFlight = true;
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      if (this.isFailure(error)) {
        this.onFailure();
      }
      throw error;
    } finally {
      if (state === CircuitState.HALF_OPEN) {
        this.probeInFlight = false;
      }
    }
  }

  reset(): void {
    this.failures = 0;
    this.probeInFlight = false;
    this.transitionTo(CircuitState.CLOSED);
  }

  /** Lazily promote OPEN → HALF_OPEN once the backoff window has elapsed. */
  private evaluateState(): CircuitState {
    if (
      this.currentState === CircuitState.OPEN &&
      this.clock.now() - this.openedAt >= this.openTimeoutMs
    ) {
      this.transitionTo(CircuitState.HALF_OPEN);
    }
    return this.currentState;
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.currentState !== CircuitState.CLOSED) {
      this.transitionTo(CircuitState.CLOSED);
    }
  }

  private onFailure(): void {
    if (this.currentState === CircuitState.HALF_OPEN) {
      // The probe failed – straight back to OPEN and restart the timer.
      this.openedAt = this.clock.now();
      this.transitionTo(CircuitState.OPEN);
      return;
    }

    this.failures += 1;

    if (this.failures >= this.failureThreshold) {
      this.openedAt = this.clock.now();
      this.transitionTo(CircuitState.OPEN);
    }
  }

  private transitionTo(next: CircuitState): void {
    if (this.currentState === next) {
      return;
    }

    const previous = this.currentState;
    this.currentState = next;

    this.logger?.warn('Circuit breaker state changed', {
      circuit: this.name,
      from: previous,
      to: next,
      failures: this.failures,
    });

    this.onStateChange?.(previous, next);
  }
}
