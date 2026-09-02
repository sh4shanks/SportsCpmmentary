import type { MatchSnapshot } from '../models/MatchSnapshot';

/**
 * Repository holding the last known snapshot of every watched match.
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
}

/** Simple `Map`-backed implementation. */
export class InMemoryStateManager implements IMatchStateRepository {
  private readonly states = new Map<string, MatchSnapshot>();

  get(matchId: string): MatchSnapshot | undefined {
    return this.states.get(matchId);
  }

  set(matchId: string, snapshot: MatchSnapshot): void {
    this.states.set(matchId, snapshot);
  }

  delete(matchId: string): boolean {
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
  }

  get size(): number {
    return this.states.size;
  }
}
