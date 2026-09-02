import type { ISportsApiClient } from '../clients/SportsApiClient';
import type { IChangeDetector } from './ChangeDetector';
import type { ICircuitBreaker } from './CircuitBreaker';
import { CircuitState } from './CircuitBreaker';
import type { IEventBroadcaster } from './EventBroadcaster';
import type { IRateLimiter } from './RateLimiter';
import type { IMatchStateRepository } from './StateManager';
import { CircuitOpenError, isAbortError, toErrorMessage } from '../utils/errors';
import type { ILogger } from '../utils/logger';
import { delay } from '../utils/time';

export interface IPollingWorker {
  readonly matchId: string;
  readonly isRunning: boolean;
  readonly circuitState: CircuitState;
  readonly pollCount: number;
  start(): void;
  stop(): Promise<void>;
}

export interface PollingWorkerDependencies {
  apiClient: ISportsApiClient;
  rateLimiter: IRateLimiter;
  circuitBreaker: ICircuitBreaker;
  stateRepository: IMatchStateRepository;
  changeDetector: IChangeDetector;
  broadcaster: IEventBroadcaster;
  logger: ILogger;
}

export interface PollingWorkerOptions {
  matchId: string;
  pollingIntervalMs: number;
}

/**
 * One worker == one match.
 *
 * Each iteration of the loop:
 *   1. asks the circuit breaker for permission (fails fast while OPEN),
 *   2. waits for a token from the *global* rate limiter,
 *   3. fetches the match snapshot,
 *   4. diffs it against the stored state and broadcasts any new events,
 *   5. sleeps for the polling interval.
 *
 * The rate limiter is consulted *inside* the breaker so that an open circuit
 * never burns tokens that a healthy match could use.
 */
export class PollingWorker implements IPollingWorker {
  public readonly matchId: string;

  private readonly pollingIntervalMs: number;
  private readonly deps: PollingWorkerDependencies;
  private readonly logger: ILogger;

  private controller = new AbortController();
  private loop: Promise<void> | null = null;
  private running = false;
  private polls = 0;

  constructor(options: PollingWorkerOptions, deps: PollingWorkerDependencies) {
    this.matchId = options.matchId;
    this.pollingIntervalMs = Math.max(1, options.pollingIntervalMs);
    this.deps = deps;
    this.logger = deps.logger.child({ component: 'PollingWorker', matchId: options.matchId });
  }

  get isRunning(): boolean {
    return this.running;
  }

  get circuitState(): CircuitState {
    return this.deps.circuitBreaker.state;
  }

  get pollCount(): number {
    return this.polls;
  }

  /** Starts the loop in the background. Idempotent. */
  start(): void {
    if (this.running) {
      return;
    }

    this.controller = new AbortController();
    this.running = true;
    this.logger.info('Polling worker started', { intervalMs: this.pollingIntervalMs });

    this.loop = this.run().catch((error: unknown) => {
      this.logger.error('Polling worker crashed', { error: toErrorMessage(error) });
    });
  }

  /** Signals cancellation and waits for the current iteration to unwind. */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.controller.abort();

    try {
      await this.loop;
    } finally {
      this.loop = null;
      this.logger.info('Polling worker stopped', { polls: this.polls });
    }
  }

  private async run(): Promise<void> {
    const { signal } = this.controller;

    while (!signal.aborted) {
      await this.tick();

      if (signal.aborted) {
        break;
      }

      await delay(this.pollingIntervalMs, signal);
    }
  }

  /** A single poll cycle. Never throws: failures are logged and retried later. */
  private async tick(): Promise<void> {
    const { signal } = this.controller;

    try {
      const snapshot = await this.deps.circuitBreaker.execute(async () => {
        await this.deps.rateLimiter.acquire(signal);

        if (signal.aborted) {
          const error = new Error('Worker stopped');
          error.name = 'AbortError';
          throw error;
        }

        this.polls += 1;
        return this.deps.apiClient.fetchMatch(this.matchId, signal);
      });

      const previous = this.deps.stateRepository.get(this.matchId);
      const events = this.deps.changeDetector.detect(previous, snapshot);
      this.deps.stateRepository.set(this.matchId, snapshot);

      if (events.length === 0) {
        this.logger.debug('Poll completed with no new events', {
          score: `${snapshot.score.home}-${snapshot.score.away}`,
        });
        return;
      }

      for (const event of events) {
        this.deps.broadcaster.broadcast(event);
      }

      this.logger.info('Detected new match events', { count: events.length });
    } catch (error) {
      this.handleTickError(error);
    }
  }

  private handleTickError(error: unknown): void {
    if (isAbortError(error)) {
      this.logger.debug('Poll aborted because the worker is stopping');
      return;
    }

    if (error instanceof CircuitOpenError) {
      this.logger.debug('Poll skipped: circuit is open', {
        circuitState: this.circuitState,
        reason: error.message,
      });
      return;
    }

    this.logger.warn('Poll failed', {
      error: toErrorMessage(error),
      circuitState: this.circuitState,
    });
  }
}
