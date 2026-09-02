import type { FastifyInstance } from 'fastify';
import type { ILogger } from '../../utils/logger';

/**
 * Lightweight request/response logging hook.
 *
 * The SSE endpoint is skipped on response because that reply is hijacked and
 * never "completes" in the normal Fastify sense.
 */
export function registerRequestLogging(app: FastifyInstance, logger: ILogger): void {
  const httpLogger = logger.child({ component: 'http' });

  app.addHook('onRequest', async (request) => {
    httpLogger.debug('Incoming request', {
      method: request.method,
      url: request.url,
    });
  });

  app.addHook('onResponse', async (request, reply) => {
    httpLogger.info('Request completed', {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
  });
}
