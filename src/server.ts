import { buildApp } from './app';
import { loadConfig } from './config/env';
import { createLogger } from './utils/logger';
import { toErrorMessage } from './utils/errors';
import {
  MockSportsApiServer,
  createFixture,
  type MockTimelineEntry,
} from './mock/MockSportsApiServer';

const DEFAULT_TIMELINE: MockTimelineEntry[] = [
  { id: 'e1', type: 'goal', team: 'Arsenal', player: 'Bukayo Saka', minute: 12 },
  { id: 'e2', type: 'card', team: 'Chelsea', player: 'Reece James', minute: 23, cardType: 'yellow' },
  { id: 'e3', type: 'goal', team: 'Chelsea', player: 'Cole Palmer', minute: 38 },
  {
    id: 'e4',
    type: 'substitution',
    team: 'Arsenal',
    playerIn: 'Gabriel Jesus',
    playerOut: 'Kai Havertz',
    minute: 61,
  },
  { id: 'e5', type: 'goal', team: 'Arsenal', player: 'Martin Odegaard', minute: 74 },
  { id: 'e6', type: 'card', team: 'Arsenal', player: 'Declan Rice', minute: 82, cardType: 'red' },
];

/**
 * Process entrypoint: build the app, start listening, and shut down cleanly on
 * SIGINT/SIGTERM so Docker stops the container without a 10 second kill delay.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel).child({ component: 'server' });

  let mockServer: MockSportsApiServer | null = null;
  let mockTimer: NodeJS.Timeout | null = null;

  // In local development or standalone preview, auto-boot the embedded mock provider
  // if EXTERNAL_API_URL targets localhost:4000 and no provider is already responding.
  if (
    process.env.AUTO_START_MOCK !== 'false' &&
    (config.externalApiUrl.includes('localhost:4000') ||
      config.externalApiUrl.includes('127.0.0.1:4000'))
  ) {
    try {
      const isAlreadyRunning = await fetch(`${config.externalApiUrl}/health`, {
        signal: AbortSignal.timeout(600),
      })
        .then((r) => r.ok)
        .catch(() => false);

      if (!isAlreadyRunning) {
        mockServer = new MockSportsApiServer();
        mockServer.setMatch(createFixture('match-123', { homeTeam: 'Arsenal', awayTeam: 'Chelsea' }));
        mockServer.setMatch(
          createFixture('match-456', { homeTeam: 'Liverpool', awayTeam: 'Everton', minute: 15 }),
        );
        mockServer.setMatch(
          createFixture('match-789', { homeTeam: 'Real Madrid', awayTeam: 'Barcelona', minute: 30 }),
        );
        await mockServer.start(4000);
        logger.info('Auto-started embedded mock sports API server on port 4000', {
          fixtures: ['match-123', 'match-456', 'match-789'],
        });

        // Periodically inject incidents into match-123 so live SSE events flow naturally
        let eventIdx = 0;
        mockTimer = setInterval(() => {
          if (!mockServer) return;
          const entry = DEFAULT_TIMELINE[eventIdx % DEFAULT_TIMELINE.length];
          if (!entry) return;

          if (eventIdx > 0 && eventIdx % DEFAULT_TIMELINE.length === 0) {
            mockServer.setMatch(
              createFixture('match-123', { homeTeam: 'Arsenal', awayTeam: 'Chelsea' }),
            );
          }

          mockServer.addEvent('match-123', entry);
          eventIdx++;
        }, 20000);
      }
    } catch (mockErr) {
      logger.warn('Could not auto-start embedded mock sports server', {
        error: toErrorMessage(mockErr),
      });
    }
  }

  const app = await buildApp({ config });

  // Auto-watch match-123 in development if watchlist is currently empty
  if (config.nodeEnv === 'development' && app.deps.pollingManager.workerCount === 0) {
    app.deps.pollingManager.addMatches(['match-123']);
    logger.info('Auto-watched default fixture: match-123');
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Received shutdown signal', { signal });
    if (mockTimer) {
      clearInterval(mockTimer);
      mockTimer = null;
    }
    if (mockServer) {
      try {
        await mockServer.stop();
        logger.info('Embedded mock server stopped');
      } catch (err) {
        logger.error('Error stopping embedded mock server', { error: toErrorMessage(err) });
      }
    }
    try {
      await app.close();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', { error: toErrorMessage(error) });
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { error: toErrorMessage(reason) });
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: toErrorMessage(error) });
  });

  await app.listen({ host: config.host, port: config.port });

  logger.info('HTTP server listening', {
    address: `http://${config.host}:${config.port}`,
    health: `http://${config.host}:${config.port}/health`,
    events: `http://${config.host}:${config.port}/events`,
  });
}

main().catch((error: unknown) => {
  // Nothing is wired up yet at this point, so write directly to stderr.
  process.stderr.write(`Fatal start-up error: ${toErrorMessage(error)}\n`);
  process.exit(1);
});
