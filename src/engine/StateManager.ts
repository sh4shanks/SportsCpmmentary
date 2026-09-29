import type { MatchSnapshot } from '../models/MatchSnapshot';
import type { EventSeverity, MatchEventType } from '../models/MatchEvent';

export interface TimelineItem {
  readonly id: string;
  readonly matchId: string;
  readonly minute: number;
  readonly type: MatchEventType;
  readonly team: string;
  readonly description: string;
  readonly commentary: string;
  readonly severity: EventSeverity;
  readonly detectedAt: number;
  readonly icon: string;
}

/**
 * Repository holding the last known snapshot of every watched match,
 * as well as the chronological timeline of incidents detected during the session.
 *
 * Modelled as an interface so the in-memory implementation can be swapped for
 * Redis (or any shared store) when the service is scaled horizontally, without
 * touching the polling or detection logic.
 */
export interface IMatchStateRepository {
  get(matchId: string): MatchSnapshot | undefined;
  set(matchId: string, snapshot: MatchSnapshot): void;
  delete(matchId: string): boolean;
  has(matchId: string): boolean;
  keys(): string[];
  clear(): void;
  readonly size: number;

  getTimeline(matchId: string): TimelineItem[];
  recordTimelineEvent(matchId: string, item: TimelineItem): void;
  clearTimeline(matchId: string): void;
}

/** Simple `Map`-backed implementation. */
export class InMemoryStateManager implements IMatchStateRepository {
  private readonly states = new Map<string, MatchSnapshot>();
  private readonly timelines = new Map<string, TimelineItem[]>();

  get(matchId: string): MatchSnapshot | undefined {
    return this.states.get(matchId);
  }

  set(matchId: string, snapshot: MatchSnapshot): void {
    this.states.set(matchId, snapshot);
  }

  delete(matchId: string): boolean {
    this.timelines.delete(matchId);
    return this.states.delete(matchId);
  }

  has(matchId: string): boolean {
    return this.states.has(matchId);
  }

  keys(): string[] {
    return [...this.states.keys()];
  }

  clear(): void {
    this.states.clear();
    this.timelines.clear();
  }

  get size(): number {
    return this.states.size;
  }

  getTimeline(matchId: string): TimelineItem[] {
    const list = this.timelines.get(matchId);
    return list ? [...list] : [];
  }

  recordTimelineEvent(matchId: string, item: TimelineItem): void {
    const list = this.timelines.get(matchId) ?? [];
    // Maintain chronological order (latest events first for live feeds)
    list.unshift(item);
    this.timelines.set(matchId, list);
  }

  clearTimeline(matchId: string): void {
    this.timelines.delete(matchId);
  }
}

