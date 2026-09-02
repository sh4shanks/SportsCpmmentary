import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { WatchController } from '../controllers/WatchController';

/**
 * POST   /watch/matches -> 202 Accepted
 * GET    /watch/matches -> 200 {"watching":[...]}
 * DELETE /watch/matches -> 204 No Content
 */
export const watchRoutes: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  const controller = new WatchController(app.deps.pollingManager, app.deps.logger);

  app.post('/watch/matches', controller.add);
  app.get('/watch/matches', controller.list);
  app.delete('/watch/matches', controller.remove);
};

export default watchRoutes;
