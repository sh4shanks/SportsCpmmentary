import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IPollingManager } from '../../engine/PollingManager';
import {
  WatchMatchesRequestSchema,
  type WatchAcceptedResponse,
  type WatchListResponse,
  type WatchMatchesRequest,
} from '../../models/WatchMatch';
import { ValidationError } from '../../utils/errors';
import type { ILogger } from '../../utils/logger';

/**
 * `/watch/matches` – add, list and remove the matches this service follows.
 * The controller only validates and delegates; worker lifecycle is entirely the
 * polling manager's responsibility (single responsibility principle).
 */
export class WatchController {
  constructor(
    private readonly pollingManager: IPollingManager,
    private readonly logger: ILogger,
  ) {}

  add = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { matchIds } = this.parseBody(request.body);
    const { accepted, alreadyWatching } = this.pollingManager.addMatches(matchIds);

    this.logger.debug('POST /watch/matches', { accepted, alreadyWatching });

    const body: WatchAcceptedResponse = {
      accepted,
      alreadyWatching,
      watching: this.pollingManager.list(),
    };

    // 202: workers are started asynchronously, the first poll has not happened.
    await reply.code(202).type('application/json').send(body);
  };

  list = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body: WatchListResponse = { watching: this.pollingManager.list() };
    await reply.code(200).type('application/json').send(body);
  };

  remove = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { matchIds } = this.parseBody(request.body);
    const { removed, notWatching } = this.pollingManager.removeMatches(matchIds);

    this.logger.debug('DELETE /watch/matches', { removed, notWatching });

    await reply.code(204).send();
  };

  private parseBody(body: unknown): WatchMatchesRequest {
    const result = WatchMatchesRequestSchema.safeParse(body);

    if (!result.success) {
      throw new ValidationError(
        'Invalid request body',
        result.error.issues.map((issue) => ({
          path: issue.path.join('.') || 'body',
          message: issue.message,
        })),
      );
    }

    return result.data;
  }
}
