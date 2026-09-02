import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IEventBroadcaster } from '../../engine/EventBroadcaster';
import type { IPollingManager } from '../../engine/PollingManager';

export interface HealthStatus {
  status: 'ok';
  uptimeSeconds: number;
  watching: number;
  sseClients: number;
}

/**
 * Liveness/readiness probe. Intentionally dependency-light: it must answer even
 * while the upstream provider is down, otherwise Docker would restart a service
 * that is perfectly healthy from the client's point of view.
 */
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly pollingManager: IPollingManager,
    private readonly broadcaster: IEventBroadcaster,
  ) {}

  handle = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body: HealthStatus = {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      watching: this.pollingManager.workerCount,
      sseClients: this.broadcaster.clientCount,
    };

    await reply.code(200).type('application/json').send(body);
  };
}
