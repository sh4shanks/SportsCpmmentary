import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env';
import type { IEventBroadcaster } from '../../engine/EventBroadcaster';
import type { IPollingManager } from '../../engine/PollingManager';
import type { IRateLimiter } from '../../engine/RateLimiter';
import type { IMatchStateRepository, TimelineItem } from '../../engine/StateManager';
import type { IMetricsCollector } from '../../engine/MetricsCollector';
import type { ICommentaryEngine, MatchMomentum, MatchSummary } from '../../engine/CommentaryEngine';
import { CircuitState } from '../../engine/CircuitBreaker';

export interface StatsResponse {
  service: {
    name: string;
    version: string;
    status: 'ok';
    uptimeSeconds: number;
    timestamp: number;
  };
  metrics: {
    events: {
      goals: number;
      yellowCards: number;
      redCards: number;
      substitutions: number;
      total: number;
    };
    polling: {
      totalPolls: number;
      successfulPolls: number;
      failedPolls: number;
      circuitBreakerRejections: number;
    };
  };
  rateLimiter: {
    capacity: number;
    windowSeconds: number;
    availableTokens: number;
    consumedTokens: number;
    queueLength: number;
    usagePercent: number;
  };
  circuitBreakers: {
    summary: {
      closed: number;
      halfOpen: number;
      open: number;
      total: number;
    };
  };
  watchlist: {
    total: number;
    matches: Array<{
      matchId: string;
      workerRunning: boolean;
      circuitState: CircuitState;
      failureCount: number;
      pollCount: number;
      lastPollAt: number | null;
      lastSuccessAt: number | null;
      lastError: string | null;
      lastEvent: unknown | null;
      snapshot: {
        homeTeam: string;
        awayTeam: string;
        score: { home: number; away: number };
        minute: number;
        status: string;
      } | null;
      timeline?: TimelineItem[];
      momentum?: MatchMomentum | null;
      summary?: MatchSummary | null;
    }>;
  };
  sse: {
    connectedClients: number;
  };
  recentEvents: unknown[];
  config: {
    upstreamApiUrl: string;
    pollingIntervalSeconds: number;
    circuitBreakerFailureThreshold: number;
    circuitBreakerOpenSeconds: number;
    sseKeepAliveSeconds: number;
  };
}

export class StatsController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly config: AppConfig,
    private readonly pollingManager: IPollingManager,
    private readonly broadcaster: IEventBroadcaster,
    private readonly rateLimiter: IRateLimiter,
    private readonly stateRepository: IMatchStateRepository,
    private readonly metrics: IMetricsCollector,
    private readonly commentaryEngine?: ICommentaryEngine,
  ) {}

  handle = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const uptimeSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
    const available = this.rateLimiter.availableTokens;
    const capacity = this.config.rateLimitMaxRequests;
    const consumed = Math.max(0, capacity - available);

    const workers = this.pollingManager.getAllWorkers();
    let closed = 0;
    let halfOpen = 0;
    let open = 0;

    const matchesList = workers.map(({ matchId, worker }) => {
      const state = worker.circuitState;
      if (state === CircuitState.CLOSED) {
        closed += 1;
      } else if (state === CircuitState.HALF_OPEN) {
        halfOpen += 1;
      } else if (state === CircuitState.OPEN) {
        open += 1;
      }

      const snapshot = this.stateRepository.get(matchId) ?? null;
      const timeline = this.stateRepository.getTimeline?.(matchId) ?? [];
      const momentum =
        snapshot && this.commentaryEngine
          ? this.commentaryEngine.calculateMomentum(
              snapshot.homeTeam,
              snapshot.awayTeam,
              timeline,
              snapshot.score,
            )
          : null;

      const isFinal =
        snapshot &&
        (snapshot.status === 'FINISHED' ||
          snapshot.status === 'FULL_TIME' ||
          snapshot.status === 'FT');

      const summary =
        isFinal && snapshot && this.commentaryEngine
          ? this.commentaryEngine.generateFullTimeSummary(snapshot, timeline)
          : null;

      return {
        matchId,
        workerRunning: worker.isRunning,
        circuitState: state,
        failureCount: worker.failureCount,
        pollCount: worker.pollCount,
        lastPollAt: worker.lastPollAt,
        lastSuccessAt: worker.lastSuccessAt,
        lastError: worker.lastError,
        lastEvent: worker.lastEvent,
        snapshot: snapshot
          ? {
              homeTeam: snapshot.homeTeam,
              awayTeam: snapshot.awayTeam,
              score: snapshot.score,
              minute: snapshot.minute,
              status: snapshot.status,
            }
          : null,
        timeline,
        momentum,
        summary,
      };
    });

    const response: StatsResponse = {
      service: {
        name: 'SportsPulse',
        version: '1.0.0',
        status: 'ok',
        uptimeSeconds,
        timestamp: Date.now(),
      },
      metrics: {
        events: this.metrics.getEventCounters(),
        polling: this.metrics.getPollingCounters(),
      },
      rateLimiter: {
        capacity,
        windowSeconds: this.config.rateLimitWindowSeconds,
        availableTokens: available,
        consumedTokens: consumed,
        queueLength: this.rateLimiter.queueLength,
        usagePercent: Math.round((consumed / Math.max(1, capacity)) * 100),
      },
      circuitBreakers: {
        summary: {
          closed,
          halfOpen,
          open,
          total: workers.length,
        },
      },
      watchlist: {
        total: workers.length,
        matches: matchesList,
      },
      sse: {
        connectedClients: this.broadcaster.clientCount,
      },
      recentEvents: this.metrics.getRecentEvents(25),
      config: {
        upstreamApiUrl: this.config.externalApiUrl,
        pollingIntervalSeconds: this.config.pollingIntervalSeconds,
        circuitBreakerFailureThreshold: this.config.circuitBreakerFailureThreshold,
        circuitBreakerOpenSeconds: this.config.circuitBreakerOpenSeconds,
        sseKeepAliveSeconds: this.config.sseKeepAliveSeconds,
      },
    };

    await reply.code(200).type('application/json').send(response);
  };
}
