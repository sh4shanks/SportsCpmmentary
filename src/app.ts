import Fastify, { type FastifyInstance } from 'fastify';

import { createConfig, type AppConfig } from './config/env';
import { HttpSportsApiClient, type ISportsApiClient } from './clients/SportsApiClient';
import { ChangeDetector, type IChangeDetector } from './engine/ChangeDetector';
import { EventBroadcaster, type IEventBroadcaster } from './engine/EventBroadcaster';
import {
  PollingManager,
  createDefaultWorkerFactory,
  type IPollingManager,
} from './engine/PollingManager';
import { TokenBucketRateLimiter, type IRateLimiter } from './engine/RateLimiter';
import { InMemoryStateManager, type IMatchStateRepository } from './engine/StateManager';
import { registerErrorHandlers } from './api/middleware/errorHandler';
import { registerRequestLogging } from './api/middleware/requestLogger';
import { eventsRoutes } from './api/routes/events';
import { healthRoutes } from './api/routes/health';
import { watchRoutes } from './api/routes/watch';
import { createLogger, type ILogger } from './utils/logger';
import { secondsToMs } from './utils/time';

/** Everything the HTTP layer needs, resolved once at start-up. */
export interface AppDependencies {
  config: AppConfig;
  logger: ILogger;
  apiClient: ISportsApiClient;
  rateLimiter: IRateLimiter;
  stateRepository: IMatchStateRepository;
  changeDetector: IChangeDetector;
  broadcaster: IEventBroadcaster;
  pollingManager: IPollingManager;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDependencies;
  }
}

export interface BuildAppOptions {
  /** Partial config overrides applied on top of the environment. */
  config?: Partial<AppConfig>;
  /** Partial dependency overrides – the seam used by the test suite. */
  dependencies?: Partial<AppDependencies>;
}

/**
 * Composition root.
 *
 * Constructor injection everywhere means no module reaches for a singleton, and
 * any collaborator can be replaced in tests by passing it in here.
 */
export function createDependencies(options: BuildAppOptions = {}): AppDependencies {
  const config = options.dependencies?.config ?? createConfig(options.config ?? {});
  const logger = options.dependencies?.logger ?? createLogger(config.logLevel);

  const apiClient =
    options.dependencies?.apiClient ??
    new HttpSportsApiClient({
      baseUrl: config.externalApiUrl,
      apiKey: config.apiKey,
      timeoutMs: config.httpTimeoutMs,
      logger: logger.child({ component: 'SportsApiClient' }),
    });

  const rateLimiter =
    options.dependencies?.rateLimiter ??
    new TokenBucketRateLimiter({
      capacity: config.rateLimitMaxRequests,
      windowMs: secondsToMs(config.rateLimitWindowSeconds),
    });

  const stateRepository = options.dependencies?.stateRepository ?? new InMemoryStateManager();
  const changeDetector = options.dependencies?.changeDetector ?? new ChangeDetector();

  const broadcaster =
    options.dependencies?.broadcaster ??
    new EventBroadcaster({
      keepAliveMs: secondsToMs(config.sseKeepAliveSeconds),
      logger: logger.child({ component: 'EventBroadcaster' }),
    });

  const pollingManager =
    options.dependencies?.pollingManager ??
    new PollingManager({
      logger,
      stateRepository,
      workerFactory: createDefaultWorkerFactory({
        config,
        apiClient,
        rateLimiter,
        stateRepository,
        changeDetector,
        broadcaster,
        logger,
      }),
    });

  return {
    config,
    logger,
    apiClient,
    rateLimiter,
    stateRepository,
    changeDetector,
    broadcaster,
    pollingManager,
  };
}

/** Build a fully wired, ready-to-listen Fastify instance. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const deps = createDependencies(options);

  const app = Fastify({
    // Our own structured logger is used instead of Fastify's built-in pino.
    logger: false,
    disableRequestLogging: true,
    trustProxy: true,
    // SSE responses are streamed manually; never let Fastify time them out.
    connectionTimeout: 0,
    keepAliveTimeout: 72_000,
    bodyLimit: 1_048_576,
  });

  app.decorate('deps', deps);

  registerRequestLogging(app, deps.logger);
  registerErrorHandlers(app, deps.logger);

  await app.register(healthRoutes);
  await app.register(eventsRoutes);
  await app.register(watchRoutes);

  app.addHook('onClose', async () => {
    deps.logger.info('Shutting down application');
    await deps.pollingManager.stopAll();
    deps.broadcaster.closeAll();
  });

  await app.ready();

  deps.logger.info('Application ready', {
    externalApiUrl: deps.config.externalApiUrl,
    pollingIntervalSeconds: deps.config.pollingIntervalSeconds,
    rateLimit: `${deps.config.rateLimitMaxRequests}/${deps.config.rateLimitWindowSeconds}s`,
    circuitBreaker: `${deps.config.circuitBreakerFailureThreshold} failures / ${deps.config.circuitBreakerOpenSeconds}s open`,
  });

  return app;
}
