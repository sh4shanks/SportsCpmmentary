import type { MatchEvent } from '../models/MatchEvent';
import {
  formatScore,
  type MatchSnapshot,
  type MatchTimelineEntry,
} from '../models/MatchSnapshot';

export interface IChangeDetector {
  /**
   * Compare the previous snapshot with the freshly polled one and return the
   * events that are new. The first poll of a match produces no events: it only
   * establishes the baseline, otherwise every already-scored goal would be
   * replayed as breaking news.
   */
  detect(previous: MatchSnapshot | undefined, current: MatchSnapshot): MatchEvent[];
}

/**
 * Diff-based detector.
 *
 * Primary strategy: compare timeline entries by a stable key and emit anything
 * that was not present before.
 *
 * Fallback strategy: some providers only expose the aggregate score without a
 * timeline. If the score moved but the timeline produced no goal, a synthetic
 * goal event is emitted so clients still learn about it.
 */
export class ChangeDetector implements IChangeDetector {
  constructor(private readonly now: () => number = () => Date.now()) {}

  detect(previous: MatchSnapshot | undefined, current: MatchSnapshot): MatchEvent[] {
    if (!previous) {
      return [];
    }

    const seen = new Set(previous.events.map((entry) => this.keyFor(entry)));

    const newEntries = current.events
      .filter((entry) => !seen.has(this.keyFor(entry)))
      .slice()
      .sort((a, b) => a.minute - b.minute);

    const events: MatchEvent[] = [];

    for (const entry of newEntries) {
      const event = this.toMatchEvent(current, entry);
      if (event) {
        events.push(event);
      }
    }

    const scoreChanged =
      previous.score.home !== current.score.home || previous.score.away !== current.score.away;
    const goalDetected = events.some((event) => event.type === 'goal');

    if (scoreChanged && !goalDetected) {
      events.push(this.syntheticGoal(previous, current));
    }

    return events;
  }

  /**
   * Stable identity for a timeline entry. Provider ids are preferred; when the
   * provider omits them the semantic content of the incident is used, which is
   * unique enough in practice (same type + minute + team + players).
   */
  private keyFor(entry: MatchTimelineEntry): string {
    return [
      entry.id,
      entry.type,
      entry.minute,
      entry.team,
      entry.player ?? '',
      entry.playerIn ?? '',
      entry.playerOut ?? '',
      entry.cardType ?? '',
    ].join('|');
  }

  private eventId(matchId: string, entry: MatchTimelineEntry): string {
    return `${matchId}:${entry.type}:${entry.id}`;
  }

  private toMatchEvent(snapshot: MatchSnapshot, entry: MatchTimelineEntry): MatchEvent | null {
    const base = {
      id: this.eventId(snapshot.matchId, entry),
      matchId: snapshot.matchId,
      detectedAt: this.now(),
    };

    switch (entry.type) {
      case 'goal':
        return {
          ...base,
          type: 'goal',
          payload: {
            matchId: snapshot.matchId,
            team: entry.team,
            player: entry.player ?? 'Unknown',
            minute: entry.minute,
            score: entry.score ?? formatScore(snapshot.score),
          },
        };

      case 'card':
        return {
          ...base,
          type: 'card',
          payload: {
            matchId: snapshot.matchId,
            team: entry.team,
            player: entry.player ?? 'Unknown',
            minute: entry.minute,
            cardType: entry.cardType ?? 'yellow',
          },
        };

      case 'substitution':
        return {
          ...base,
          type: 'substitution',
          payload: {
            matchId: snapshot.matchId,
            team: entry.team,
            playerIn: entry.playerIn ?? 'Unknown',
            playerOut: entry.playerOut ?? 'Unknown',
            minute: entry.minute,
          },
        };

      default:
        return null;
    }
  }

  private syntheticGoal(previous: MatchSnapshot, current: MatchSnapshot): MatchEvent {
    const homeScored = current.score.home > previous.score.home;
    const team = homeScored ? current.homeTeam : current.awayTeam;
    const minute = current.minute;
    const score = formatScore(current.score);

    return {
      id: `${current.matchId}:goal:score:${score}:${minute}`,
      matchId: current.matchId,
      detectedAt: this.now(),
      type: 'goal',
      payload: {
        matchId: current.matchId,
        team,
        player: 'Unknown',
        minute,
        score,
      },
    };
  }
}
