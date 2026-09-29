import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

const SimulateEventSchema = z.object({
  matchId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  type: z.enum(['goal', 'card', 'substitution']).default('goal'),
  team: z.string().optional(),
  player: z.string().optional(),
  playerIn: z.string().optional(),
  playerOut: z.string().optional(),
  cardType: z.enum(['yellow', 'red']).optional(),
  minute: z.number().int().min(1).max(120).optional(),
});

const SimulateStatusSchema = z.object({
  matchId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  status: z.enum(['IN_PLAY', 'HALF_TIME', 'FINISHED', 'FULL_TIME', 'SUSPENDED']).default('FINISHED'),
});

const SimulateFailureSchema = z.object({
  matchId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  status: z.number().int().min(400).max(599).default(503),
});

/**
 * Control plane routes for driving simulation on the upstream mock provider.
 * Follows the critical rule: simulator modifies upstream mock provider;
 * the polling worker -> rate limiter -> snapshot -> change detector -> commentary
 * pipeline is strictly traversed.
 */
export const simulationRoutes: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  app.post('/simulation/event', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = SimulateEventSchema.safeParse(request.body);
    if (!parseResult.success) {
      await reply.code(400).send({
        error: 'Invalid simulation payload',
        details: parseResult.error.issues,
      });
      return;
    }

    const { matchId, ...eventData } = parseResult.data;
    const url = `${app.deps.config.externalApiUrl}/_control/events/${encodeURIComponent(matchId)}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventData),
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        await reply.code(502).send({
          error: `Upstream mock returned status ${response.status}: ${text}`,
        });
        return;
      }

      const body = await response.json();
      await reply.code(200).send({
        status: 'simulated',
        matchId,
        message: 'Incident injected into upstream mock provider. Polling worker will detect it on next poll.',
        upstream: body,
      });
    } catch (error) {
      await reply.code(503).send({
        error: `Could not reach upstream provider at ${app.deps.config.externalApiUrl}. Ensure mock API is running.`,
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/simulation/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = SimulateStatusSchema.safeParse(request.body);
    if (!parseResult.success) {
      await reply.code(400).send({
        error: 'Invalid status payload',
        details: parseResult.error.issues,
      });
      return;
    }

    const { matchId, status } = parseResult.data;
    const url = `${app.deps.config.externalApiUrl}/_control/status/${encodeURIComponent(matchId)}?status=${encodeURIComponent(status)}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        await reply.code(502).send({
          error: `Upstream mock returned status ${response.status}: ${text}`,
        });
        return;
      }

      const body = await response.json();
      await reply.code(200).send({
        status: 'simulated',
        matchId,
        message: `Match status updated to ${status} on upstream provider.`,
        upstream: body,
      });
    } catch (error) {
      await reply.code(503).send({
        error: `Could not reach upstream provider at ${app.deps.config.externalApiUrl}.`,
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/simulation/failure', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = SimulateFailureSchema.safeParse(request.body);
    if (!parseResult.success) {
      await reply.code(400).send({
        error: 'Invalid failure payload',
        details: parseResult.error.issues,
      });
      return;
    }

    const { matchId, status } = parseResult.data;
    const url = `${app.deps.config.externalApiUrl}/_control/failures/${encodeURIComponent(matchId)}?status=${status}`;

    try {
      const response = await fetch(url, { method: 'PUT', signal: AbortSignal.timeout(3000) });
      if (!response.ok) {
        await reply.code(502).send({ error: 'Failed to set failure on mock' });
        return;
      }
      await reply.code(200).send({ status: 'failure_injected', matchId, httpStatus: status });
    } catch (error) {
      await reply.code(503).send({
        error: 'Could not reach upstream provider',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.delete('/simulation/failure', async (request: FastifyRequest, reply: FastifyReply) => {
    const matchId = (request.query as { matchId?: string }).matchId ?? 'match-123';
    const url = `${app.deps.config.externalApiUrl}/_control/failures/${encodeURIComponent(matchId)}`;

    try {
      const response = await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(3000) });
      if (!response.ok) {
        await reply.code(502).send({ error: 'Failed to clear failure on mock' });
        return;
      }
      await reply.code(200).send({ status: 'failure_cleared', matchId });
    } catch (error) {
      await reply.code(503).send({
        error: 'Could not reach upstream provider',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });
};

export default simulationRoutes;
