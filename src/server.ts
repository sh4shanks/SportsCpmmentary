import { buildApp } from './app';
import { loadConfig } from './config/env';
import { createLogger } from './utils/logger';
import { toErrorMessage } from './utils/errors';

/**
 * Process entrypoint: build the app, start listening, and shut down cleanly on
 * SIGINT/SIGTERM so Docker stops the container without a 10 second kill delay.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel).child({ component: 'server' });

  const app = await buildApp({ config });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Received shutdown signal', { signal });
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
