import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { RootController } from '../controllers/RootController';

/**
 * GET / -> Service overview dashboard and metadata
 */
export const rootRoutes: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  const controller = new RootController(
    app.deps.config,
    app.deps.pollingManager,
    app.deps.broadcaster,
    app.deps.rateLimiter,
    app.deps.stateRepository,
    app.deps.metrics,
    app.deps.commentaryEngine,
  );

  app.get('/', controller.handle);
};

export default rootRoutes;
