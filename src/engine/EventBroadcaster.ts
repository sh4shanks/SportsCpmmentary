import { randomUUID } from 'node:crypto';
import {
  formatSseComment,
  formatSseMessage,
  type MatchEvent,
} from '../models/MatchEvent';
import type { ILogger } from '../utils/logger';
import { SilentLogger } from '../utils/logger';
import { toErrorMessage } from '../utils/errors';

/**
 * Minimal writable sink an SSE client must provide. Keeping this narrow (rather
 * than accepting a `ServerResponse`) makes the broadcaster trivial to unit test
 * and independent of the HTTP framework.
 */
export interface SseSink {
  write(chunk: string): boolean;
  end(): void;
}

export interface SseClient {
  readonly id: string;
  readonly connectedAt: number;
  readonly sink: SseSink;
}

export interface IEventBroadcaster {
  register(sink: SseSink): SseClient;
  unregister(clientId: string): void;
  broadcast(event: MatchEvent): number;
  sendComment(comment: string): void;
  closeAll(): void;
  readonly clientCount: number;
}

export interface EventBroadcasterOptions {
  keepAliveMs: number;
  logger?: ILogger;
}

/**
 * Fan-out hub: every detected match event is written to every connected SSE
 * client. Dead sockets are pruned lazily on the first failed write.
 */
export class EventBroadcaster implements IEventBroadcaster {
  private readonly clients = new Map<string, SseClient>();
  private readonly logger: ILogger;
  private readonly keepAliveMs: number;
  private keepAliveTimer: NodeJS.Timeout | null = null;

  constructor(options: EventBroadcasterOptions) {
    this.keepAliveMs = Math.max(1000, options.keepAliveMs);
    this.logger = options.logger ?? new SilentLogger();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  register(sink: SseSink): SseClient {
    const client: SseClient = {
      id: randomUUID(),
      connectedAt: Date.now(),
      sink,
    };

    this.clients.set(client.id, client);
    this.startKeepAlive();

    this.logger.info('SSE client connected', {
      clientId: client.id,
      clients: this.clients.size,
    });

    return client;
  }

  unregister(clientId: string): void {
    if (!this.clients.delete(clientId)) {
      return;
    }

    this.logger.info('SSE client disconnected', { clientId, clients: this.clients.size });

    if (this.clients.size === 0) {
      this.stopKeepAlive();
    }
  }

  /** Writes the event to every client. Returns how many clients received it. */
  broadcast(event: MatchEvent): number {
    const message = formatSseMessage(event);
    const delivered = this.writeToAll(message);

    this.logger.info('Broadcast match event', {
      eventId: event.id,
      matchId: event.matchId,
      type: event.type,
      clients: delivered,
    });

    return delivered;
  }

  sendComment(comment: string): void {
    this.writeToAll(formatSseComment(comment));
  }

  closeAll(): void {
    this.stopKeepAlive();

    for (const client of this.clients.values()) {
      try {
        client.sink.end();
      } catch (error) {
        this.logger.debug('Failed to close SSE client', {
          clientId: client.id,
          error: toErrorMessage(error),
        });
      }
    }

    this.clients.clear();
  }

  private writeToAll(chunk: string): number {
    let delivered = 0;

    for (const client of [...this.clients.values()]) {
      try {
        client.sink.write(chunk);
        delivered += 1;
      } catch (error) {
        this.logger.warn('Dropping unwritable SSE client', {
          clientId: client.id,
          error: toErrorMessage(error),
        });
        this.unregister(client.id);
      }
    }

    return delivered;
  }

  private startKeepAlive(): void {
    if (this.keepAliveTimer) {
      return;
    }

    this.keepAliveTimer = setInterval(() => {
      this.sendComment('keep-alive');
    }, this.keepAliveMs);

    // Never hold the event loop open just for keep-alive frames.
    this.keepAliveTimer.unref?.();
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }
}
