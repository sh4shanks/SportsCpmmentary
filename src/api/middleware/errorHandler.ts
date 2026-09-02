import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../utils/errors';
import type { ILogger } from '../../utils/logger';

interface ErrorResponseBody {
  error: string;
  details?: unknown;
}

/**
 * Central error boundary.
 *
 * Guarantees the contract "never return HTML": every failure — validation,
 * malformed JSON, unknown route, unhandled exception — leaves the service as a
 * JSON document shaped `{ "error": "..." }`.
 */
export function registerErrorHandlers(app: FastifyInstance, logger: ILogger): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = resolveStatusCode(error);
    const body: ErrorResponseBody = { error: resolveMessage(error, statusCode) };

    if (error instanceof AppError && error.details !== undefined) {
      body.details = error.details;
    } else if (error.validation) {
      body.details = error.validation;
    }

    if (statusCode >= 500) {
      logger.error('Unhandled request error', {
        method: request.method,
        url: request.url,
        statusCode,
        error: error.message,
        stack: error.stack,
      });
    } else {
      logger.warn('Request rejected', {
        method: request.method,
        url: request.url,
        statusCode,
        error: error.message,
      });
    }

    void reply.status(statusCode).type('application/json').send(body);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    void reply
      .status(404)
      .type('application/json')
      .send({ error: `Route ${request.method} ${request.url} not found` } satisfies ErrorResponseBody);
  });
}

function resolveStatusCode(error: FastifyError): number {
  if (error instanceof AppError) {
    return error.statusCode;
  }
  if (typeof error.statusCode === 'number' && error.statusCode >= 400) {
    return error.statusCode;
  }
  if (error.validation) {
    return 400;
  }
  return 500;
}

function resolveMessage(error: FastifyError, statusCode: number): string {
  if (statusCode >= 500) {
    // Never leak internals to the client; the details are in the logs.
    return 'Internal Server Error';
  }
  return error.message || 'Request failed';
}
