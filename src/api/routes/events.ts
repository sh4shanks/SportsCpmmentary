import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { EventsController } from '../controllers/EventsController';

/**
 * GET /events -> text/event-stream
 * Long-lived subscription that receives every detected match event.
 */
export const eventsRoutes: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  const controller = new EventsController(app.deps.broadcaster, app.deps.logger);

  app.get('/events', controller.handle);
};

export default eventsRoutes;
