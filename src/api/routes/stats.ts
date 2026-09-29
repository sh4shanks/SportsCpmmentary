import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { StatsController } from '../controllers/StatsController';

/**
 * GET /stats -> Safe operational telemetry & resilience statistics
 */
export const statsRoutes: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  const controller = new StatsController(
    app.deps.config,
    app.deps.pollingManager,
    app.deps.broadcaster,
    app.deps.rateLimiter,
    app.deps.stateRepository,
    app.deps.metrics,
    app.deps.commentaryEngine,
  );

  app.get('/stats', controller.handle);
};

export default statsRoutes;
