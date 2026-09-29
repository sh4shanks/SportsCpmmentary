import type { MatchEvent } from '../models/MatchEvent';

export interface EventCounters {
  goals: number;
  yellowCards: number;
  redCards: number;
  substitutions: number;
  total: number;
}

export interface PollingCounters {
  totalPolls: number;
  successfulPolls: number;
  failedPolls: number;
  circuitBreakerRejections: number;
}

export interface IMetricsCollector {
  recordPoll(success: boolean, circuitRejected?: boolean): void;
  recordEvent(event: MatchEvent): void;
  getEventCounters(): EventCounters;
  getPollingCounters(): PollingCounters;
  getRecentEvents(limit?: number): MatchEvent[];
  reset(): void;
}

export class MetricsCollector implements IMetricsCollector {
  private readonly recentEvents: MatchEvent[] = [];
  private readonly maxRecentEvents: number;

  private goals = 0;
  private yellowCards = 0;
  private redCards = 0;
  private substitutions = 0;
  private totalEvents = 0;

  private totalPolls = 0;
  private successfulPolls = 0;
  private failedPolls = 0;
  private circuitBreakerRejections = 0;

  constructor(options: { maxRecentEvents?: number } = {}) {
    this.maxRecentEvents = options.maxRecentEvents ?? 50;
  }

  recordPoll(success: boolean, circuitRejected = false): void {
    this.totalPolls += 1;
    if (circuitRejected) {
      this.circuitBreakerRejections += 1;
    } else if (success) {
      this.successfulPolls += 1;
    } else {
      this.failedPolls += 1;
    }
  }

  recordEvent(event: MatchEvent): void {
    this.totalEvents += 1;
    if (event.type === 'goal') {
      this.goals += 1;
    } else if (event.type === 'card') {
      if (event.payload.cardType === 'red') {
        this.redCards += 1;
      } else {
        this.yellowCards += 1;
      }
    } else if (event.type === 'substitution') {
      this.substitutions += 1;
    }

    this.recentEvents.unshift(event);
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.pop();
    }
  }

  getEventCounters(): EventCounters {
    return {
      goals: this.goals,
      yellowCards: this.yellowCards,
      redCards: this.redCards,
      substitutions: this.substitutions,
      total: this.totalEvents,
    };
  }

  getPollingCounters(): PollingCounters {
    return {
      totalPolls: this.totalPolls,
      successfulPolls: this.successfulPolls,
      failedPolls: this.failedPolls,
      circuitBreakerRejections: this.circuitBreakerRejections,
    };
  }

  getRecentEvents(limit = 20): MatchEvent[] {
    return this.recentEvents.slice(0, limit);
  }

  reset(): void {
    this.goals = 0;
    this.yellowCards = 0;
    this.redCards = 0;
    this.substitutions = 0;
    this.totalEvents = 0;
    this.totalPolls = 0;
    this.successfulPolls = 0;
    this.failedPolls = 0;
    this.circuitBreakerRejections = 0;
    this.recentEvents.length = 0;
  }
}
