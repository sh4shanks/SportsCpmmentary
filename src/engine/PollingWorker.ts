import type { ISportsApiClient } from '../clients/SportsApiClient';
import type { IChangeDetector } from './ChangeDetector';
import type { ICircuitBreaker } from './CircuitBreaker';
import { CircuitState } from './CircuitBreaker';
import type { ICommentaryEngine } from './CommentaryEngine';
import type { IEventBroadcaster } from './EventBroadcaster';
import type { IRateLimiter } from './RateLimiter';
import type { IMatchStateRepository } from './StateManager';
import type { IMetricsCollector } from './MetricsCollector';
import type { MatchEvent } from '../models/MatchEvent';
import { CircuitOpenError, isAbortError, toErrorMessage } from '../utils/errors';
import type { ILogger } from '../utils/logger';
import { delay } from '../utils/time';

export interface IPollingWorker {
  readonly matchId: string;
  readonly isRunning: boolean;
  readonly circuitState: CircuitState;
  readonly pollCount: number;
  readonly lastPollAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastError: string | null;
  readonly lastEvent: MatchEvent | null;
  readonly failureCount: number;
  start(): void;
  stop(): Promise<void>;
}

export interface PollingWorkerDependencies {
  apiClient: ISportsApiClient;
  rateLimiter: IRateLimiter;
  circuitBreaker: ICircuitBreaker;
  stateRepository: IMatchStateRepository;
  changeDetector: IChangeDetector;
  commentaryEngine?: ICommentaryEngine;
  broadcaster: IEventBroadcaster;
  logger: ILogger;
  metrics?: IMetricsCollector;
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
  private _lastPollAt: number | null = null;
  private _lastSuccessAt: number | null = null;
  private _lastError: string | null = null;
  private _lastEvent: MatchEvent | null = null;

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

  get failureCount(): number {
    return this.deps.circuitBreaker.failureCount;
  }

  get pollCount(): number {
    return this.polls;
  }

  get lastPollAt(): number | null {
    return this._lastPollAt;
  }

  get lastSuccessAt(): number | null {
    return this._lastSuccessAt;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  get lastEvent(): MatchEvent | null {
    return this._lastEvent;
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
      this._lastPollAt = Date.now();
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

      this._lastSuccessAt = Date.now();
      this._lastError = null;
      this.deps.metrics?.recordPoll(true, false);

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
        if (this.deps.commentaryEngine) {
          const res = this.deps.commentaryEngine.generate(event, snapshot);
          event.commentary = res.commentary;
          event.severity = res.severity;
        }

        const icon =
          event.type === 'goal'
            ? '⚽'
            : event.type === 'card'
              ? event.payload.cardType === 'red'
                ? '🟥'
                : '🟨'
              : '🔄';

        const description =
          event.type === 'goal'
            ? `Goal: ${event.payload.player} (${event.payload.score})`
            : event.type === 'card'
              ? `${event.payload.cardType === 'red' ? 'Red Card' : 'Yellow Card'}: ${event.payload.player}`
              : `Sub: ${event.payload.playerIn} on for ${event.payload.playerOut}`;

        this.deps.stateRepository.recordTimelineEvent?.(this.matchId, {
          id: event.id,
          matchId: this.matchId,
          minute: 'minute' in event.payload ? event.payload.minute : snapshot.minute,
          type: event.type,
          team: 'team' in event.payload ? event.payload.team : 'Unknown',
          description,
          commentary: event.commentary ?? description,
          severity: event.severity ?? (event.type === 'goal' ? 'CRITICAL' : event.type === 'card' ? 'HIGH' : 'LOW'),
          detectedAt: event.detectedAt,
          icon,
        });

        this._lastEvent = event;
        this.deps.metrics?.recordEvent(event);
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

    const message = toErrorMessage(error);
    this._lastError = message;

    if (error instanceof CircuitOpenError) {
      this.deps.metrics?.recordPoll(false, true);
      this.logger.debug('Poll skipped: circuit is open', {
        circuitState: this.circuitState,
        reason: error.message,
      });
      return;
    }

    this.deps.metrics?.recordPoll(false, false);
    this.logger.warn('Poll failed', {
      error: message,
      circuitState: this.circuitState,
    });
  }
}
