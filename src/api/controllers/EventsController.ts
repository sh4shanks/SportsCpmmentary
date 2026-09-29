import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IEventBroadcaster, SseClientOptions } from '../../engine/EventBroadcaster';
import type { CommentaryStyle } from '../../models/MatchEvent';
import type { ILogger } from '../../utils/logger';
import { toErrorMessage } from '../../utils/errors';

interface EventsQuery {
  matchId?: string;
  format?: 'commentary' | 'legacy';
  style?: CommentaryStyle;
}

/**
 * `GET /events` – Server-Sent Events stream.
 *
 * Fastify's reply lifecycle is bypassed with `reply.hijack()` so the raw socket
 * stays open for the lifetime of the subscription and the broadcaster can write
 * to it at any time.
 *
 * Supports optional query parameters:
 *   - `matchId`: filter events to a specific match
 *   - `format`: "commentary" for enriched narrative events or "legacy" (default)
 *   - `style`: "standard" | "concise" | "professional"
 */
export class EventsController {
  constructor(
    private readonly broadcaster: IEventBroadcaster,
    private readonly logger: ILogger,
    private readonly retryMs = 3000,
  ) {}

  handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Take manual control of the response before writing anything.
    reply.hijack();

    const raw = reply.raw;

    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Disable proxy buffering (nginx and friends) so events are not batched.
      'X-Accel-Buffering': 'no',
    });

    // Tell the browser's EventSource how quickly to reconnect, then send an
    // immediate comment so proxies flush the response headers right away.
    raw.write(`retry: ${this.retryMs}\n\n`);
    raw.write(': connected\n\n');

    const query = (request.query ?? {}) as EventsQuery;
    const clientOptions: SseClientOptions = {
      matchId: query.matchId,
      format: query.format === 'commentary' ? 'commentary' : 'legacy',
      style: query.style,
    };

    const client = this.broadcaster.register(
      {
        write: (chunk: string): boolean => raw.write(chunk),
        end: (): void => {
          raw.end();
        },
      },
      clientOptions,
    );

    let released = false;
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      this.broadcaster.unregister(client.id);
    };

    request.raw.on('close', release);
    request.raw.on('aborted', release);
    raw.on('close', release);
    raw.on('error', (error: Error) => {
      this.logger.debug('SSE socket error', {
        clientId: client.id,
        error: toErrorMessage(error),
      });
      release();
    });
  };
}
