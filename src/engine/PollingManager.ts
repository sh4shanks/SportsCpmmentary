import type { ISportsApiClient } from '../clients/SportsApiClient';
import type { IChangeDetector } from './ChangeDetector';
import { CircuitBreaker, CircuitState } from './CircuitBreaker';
import type { IEventBroadcaster } from './EventBroadcaster';
import { PollingWorker, type IPollingWorker } from './PollingWorker';
import type { IRateLimiter } from './RateLimiter';
import type { IMatchStateRepository } from './StateManager';
import { isAbortError, toErrorMessage } from '../utils/errors';
import type { ILogger } from '../utils/logger';
import { secondsToMs } from '../utils/time';
import type { AppConfig } from '../config/env';

export interface WatchlistChange {
  /** Ids for which a new worker was started. */
  accepted: string[];
  /** Ids that already had a running worker (no duplicate is created). */
  alreadyWatching: string[];
}

export interface IPollingManager {
  addMatches(matchIds: string[]): WatchlistChange;
  removeMatches(matchIds: string[]): { removed: string[]; notWatching: string[] };
  list(): string[];
  isWatching(matchId: string): boolean;
  circuitStateOf(matchId: string): CircuitState | undefined;
  readonly workerCount: number;
  stopAll(): Promise<void>;
}

/** Factory type – injectable so tests can substitute fake workers. */
export type PollingWorkerFactory = (matchId: string) => IPollingWorker;

export interface PollingManagerOptions {
  workerFactory: PollingWorkerFactory;
  logger: ILogger;
  /**
   * Optional state repository. When provided, the cached snapshot of a match is
   * dropped as soon as the match leaves the watchlist, so re-adding it later
   * starts from a fresh baseline instead of replaying historic incidents.
   */
  stateRepository?: IMatchStateRepository;
}

/**
 * Owns the watchlist and guarantees a 1:1 mapping between watched match ids and
 * running workers: adding the same id twice never spawns a second loop, and
 * removing an id both cancels the loop and drops its cached state.
 */
export class PollingManager implements IPollingManager {
  private readonly workers = new Map<string, IPollingWorker>();
  private readonly workerFactory: PollingWorkerFactory;
  private readonly logger: ILogger;
  private readonly stateRepository: IMatchStateRepository | undefined;

  constructor(options: PollingManagerOptions) {
    this.workerFactory = options.workerFactory;
    this.stateRepository = options.stateRepository;
    this.logger = options.logger.child({ component: 'PollingManager' });
  }

  get workerCount(): number {
    return this.workers.size;
  }

  addMatches(matchIds: string[]): WatchlistChange {
    const accepted: string[] = [];
    const alreadyWatching: string[] = [];

    for (const matchId of dedupe(matchIds)) {
      if (this.workers.has(matchId)) {
        alreadyWatching.push(matchId);
        continue;
      }

      const worker = this.workerFactory(matchId);
      this.workers.set(matchId, worker);
      worker.start();
      accepted.push(matchId);
    }

    this.logger.info('Watchlist updated', {
      added: accepted.length,
      duplicates: alreadyWatching.length,
      watching: this.workers.size,
    });

    return { accepted, alreadyWatching };
  }

  removeMatches(matchIds: string[]): { removed: string[]; notWatching: string[] } {
    const removed: string[] = [];
    const notWatching: string[] = [];

    for (const matchId of dedupe(matchIds)) {
      const worker = this.workers.get(matchId);

      if (!worker) {
        notWatching.push(matchId);
        continue;
      }

      this.workers.delete(matchId);
      this.stateRepository?.delete(matchId);
      removed.push(matchId);

      // Cancellation is cooperative: signal now, unwind in the background so
      // the HTTP response is not blocked by an in-flight poll.
      void worker.stop().catch((error: unknown) => {
        if (!isAbortError(error)) {
          this.logger.warn('Error while stopping worker', {
            matchId,
            error: toErrorMessage(error),
          });
        }
      });
    }

    this.logger.info('Watchlist updated', {
      removed: removed.length,
      unknown: notWatching.length,
      watching: this.workers.size,
    });

    return { removed, notWatching };
  }

  list(): string[] {
    return [...this.workers.keys()];
  }

  isWatching(matchId: string): boolean {
    return this.workers.has(matchId);
  }

  circuitStateOf(matchId: string): CircuitState | undefined {
    return this.workers.get(matchId)?.circuitState;
  }

  async stopAll(): Promise<void> {
    const workers = [...this.workers.values()];
    this.workers.clear();

    await Promise.all(
      workers.map((worker) =>
        worker.stop().catch((error: unknown) => {
          this.logger.warn('Error while stopping worker', {
            matchId: worker.matchId,
            error: toErrorMessage(error),
          });
        }),
      ),
    );

    this.logger.info('All polling workers stopped', { count: workers.length });
  }
}

export interface DefaultWorkerFactoryDependencies {
  config: AppConfig;
  apiClient: ISportsApiClient;
  rateLimiter: IRateLimiter;
  stateRepository: IMatchStateRepository;
  changeDetector: IChangeDetector;
  broadcaster: IEventBroadcaster;
  logger: ILogger;
}

/**
 * Default factory: builds a real `PollingWorker` with its own circuit breaker
 * instance (breaker state is per match) while sharing the global rate limiter,
 * state repository and broadcaster.
 */
export function createDefaultWorkerFactory(
  deps: DefaultWorkerFactoryDependencies,
): PollingWorkerFactory {
  return (matchId: string): IPollingWorker => {
    const circuitBreaker = new CircuitBreaker({
      name: `match:${matchId}`,
      failureThreshold: deps.config.circuitBreakerFailureThreshold,
      openTimeoutMs: secondsToMs(deps.config.circuitBreakerOpenSeconds),
      logger: deps.logger,
      // Worker cancellation must never be counted as an upstream failure.
      isFailure: (error: unknown): boolean => !isAbortError(error),
    });

    return new PollingWorker(
      {
        matchId,
        pollingIntervalMs: secondsToMs(deps.config.pollingIntervalSeconds),
      },
      {
        apiClient: deps.apiClient,
        rateLimiter: deps.rateLimiter,
        circuitBreaker,
        stateRepository: deps.stateRepository,
        changeDetector: deps.changeDetector,
        broadcaster: deps.broadcaster,
        logger: deps.logger,
      },
    );
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
