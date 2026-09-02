/**
 * Normalized representation of a match at a point in time.
 *
 * The `SportsApiClient` maps whatever shape the upstream provider returns into
 * this internal model, so the rest of the pipeline (state manager, change
 * detector, broadcaster) never depends on a third-party schema.
 */

export type TimelineEntryType = 'goal' | 'card' | 'substitution';
export type CardType = 'yellow' | 'red';

/** A single incident on the match timeline. */
export interface MatchTimelineEntry {
  /** Provider supplied id when available; otherwise synthesised by the mapper. */
  readonly id: string;
  readonly type: TimelineEntryType;
  readonly team: string;
  readonly minute: number;
  /** Scorer / booked player. Absent for substitutions. */
  readonly player?: string;
  readonly playerIn?: string;
  readonly playerOut?: string;
  readonly cardType?: CardType;
  /** Score right after the incident, e.g. "2-1". Optional upstream field. */
  readonly score?: string;
}

export interface MatchScore {
  readonly home: number;
  readonly away: number;
}

export interface MatchSnapshot {
  readonly matchId: string;
  readonly status: string;
  readonly homeTeam: string;
  readonly awayTeam: string;
  readonly score: MatchScore;
  /** Current match minute when the provider exposes it. */
  readonly minute: number;
  readonly events: readonly MatchTimelineEntry[];
  /** Epoch millis at which this snapshot was fetched. */
  readonly fetchedAt: number;
}

export function formatScore(score: MatchScore): string {
  return `${score.home}-${score.away}`;
}
