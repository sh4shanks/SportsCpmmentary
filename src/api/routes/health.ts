import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { HealthController } from '../controllers/HealthController';

/**
 * GET /health -> 200 {"status":"ok", ...}
 * Used by the Docker Compose healthcheck.
 */
export const healthRoutes: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  const controller = new HealthController(app.deps.pollingManager, app.deps.broadcaster);

  app.get('/health', controller.handle);
};

export default healthRoutes;
