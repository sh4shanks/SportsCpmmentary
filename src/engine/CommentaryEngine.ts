import type {
  CommentaryStyle,
  EventSeverity,
  MatchEvent,
  MatchEventType,
} from '../models/MatchEvent';
import type { MatchScore, MatchSnapshot } from '../models/MatchSnapshot';
import type { TimelineItem } from './StateManager';

export type CommentaryEventType =
  | 'GOAL'
  | 'YELLOW_CARD'
  | 'RED_CARD'
  | 'SUBSTITUTION'
  | 'PENALTY'
  | 'VAR'
  | 'OFFSIDE'
  | 'CORNER'
  | 'INJURY'
  | 'KICKOFF'
  | 'HALF_TIME'
  | 'FULL_TIME'
  | 'MATCH_SUSPENDED'
  | 'MATCH_RESUMED';

export interface CommentaryResult {
  readonly type: CommentaryEventType;
  readonly severity: EventSeverity;
  readonly commentary: string;
  readonly style: CommentaryStyle;
}

export interface MatchMomentum {
  readonly homeTeam: string;
  readonly awayTeam: string;
  readonly homePercent: number;
  readonly awayPercent: number;
  readonly label: 'Engine-generated momentum';
  readonly explanation: string;
}

export interface MatchSummary {
  readonly matchId: string;
  readonly status: string;
  readonly homeTeam: string;
  readonly awayTeam: string;
  readonly score: MatchScore;
  readonly scoreFormatted: string;
  readonly goals: Array<{ minute: number; team: string; player?: string }>;
  readonly totalCards: number;
  readonly totalYellowCards: number;
  readonly totalRedCards: number;
  readonly totalSubstitutions: number;
  readonly totalEvents: number;
  readonly headline: string;
}

export interface ICommentaryEngine {
  generate(
    event: MatchEvent,
    snapshot?: MatchSnapshot,
    style?: CommentaryStyle,
  ): CommentaryResult;
  classifySeverity(type: CommentaryEventType | MatchEventType | string): EventSeverity;
  calculateMomentum(
    homeTeam: string,
    awayTeam: string,
    timeline: TimelineItem[],
    currentScore?: MatchScore,
  ): MatchMomentum;
  generateFullTimeSummary(snapshot: MatchSnapshot, timeline: TimelineItem[]): MatchSummary;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Domain component responsible for converting structured match events into
 * narrative commentary, classifying incident severity, calculating match
 * momentum from detected incidents, and producing post-match summaries.
 */
export class CommentaryEngine implements ICommentaryEngine {
  constructor(private readonly defaultStyle: CommentaryStyle = 'standard') {}

  /**
   * Translates a detected MatchEvent into a stylized, human-readable commentary
   * narrative and attaches its canonical severity rating.
   */
  generate(
    event: MatchEvent,
    snapshot?: MatchSnapshot,
    style: CommentaryStyle = this.defaultStyle,
  ): CommentaryResult {
    const canonicalType = this.toCanonicalType(event);
    const severity = this.classifySeverity(canonicalType);
    const commentary = this.renderTemplate(event, canonicalType, severity, style, snapshot);

    return {
      type: canonicalType,
      severity,
      commentary,
      style,
    };
  }

  /**
   * Deterministic severity classification:
   *   GOAL             -> CRITICAL
   *   RED_CARD         -> HIGH
   *   YELLOW_CARD      -> MEDIUM
   *   SUBSTITUTION     -> LOW
   *   Future events:
   *   PENALTY, VAR     -> HIGH
   *   MATCH_SUSPENDED  -> CRITICAL
   *   FULL_TIME        -> MEDIUM
   *   others           -> LOW
   */
  classifySeverity(type: CommentaryEventType | MatchEventType | string): EventSeverity {
    const normalized = type.toUpperCase().replace(/\s+/g, '_');

    switch (normalized) {
      case 'GOAL':
      case 'MATCH_SUSPENDED':
        return 'CRITICAL';

      case 'RED_CARD':
      case 'PENALTY':
      case 'VAR':
        return 'HIGH';

      case 'YELLOW_CARD':
      case 'FULL_TIME':
      case 'MATCH_RESUMED':
        return 'MEDIUM';

      case 'SUBSTITUTION':
      case 'CORNER':
      case 'OFFSIDE':
      case 'INJURY':
      case 'KICKOFF':
      case 'HALF_TIME':
      default:
        return 'LOW';
    }
  }

  /**
   * Calculates engine-generated momentum based purely on actual detected match incidents.
   *
   * Algorithm:
   *   1. Baseline starts at 50/50.
   *   2. Goal: +25% for scoring team, -25% for conceding team.
   *   3. Red Card: -30% for penalized team, +30% for opponent.
   *   4. Yellow Card: -8% for booked team, +8% for opponent.
   *   5. Substitution: +4% tactical lift for substituting team.
   *   6. Score margin: +5% per goal advantage.
   *   7. Bounded within 10% - 90% so neither team reaches 0% during play.
   */
  calculateMomentum(
    homeTeam: string,
    awayTeam: string,
    timeline: TimelineItem[],
    currentScore?: MatchScore,
  ): MatchMomentum {
    let homeShift = 0;
    let awayShift = 0;

    for (const item of timeline) {
      const isHome = item.team.toLowerCase() === homeTeam.toLowerCase();

      if (item.type === 'goal') {
        if (isHome) {
          homeShift += 25;
          awayShift -= 25;
        } else {
          awayShift += 25;
          homeShift -= 25;
        }
      } else if (item.type === 'card') {
        const isRed = item.description.toLowerCase().includes('red') || item.severity === 'HIGH';
        const penalty = isRed ? 30 : 8;
        if (isHome) {
          homeShift -= penalty;
          awayShift += penalty;
        } else {
          awayShift -= penalty;
          homeShift += penalty;
        }
      } else if (item.type === 'substitution') {
        if (isHome) {
          homeShift += 4;
        } else {
          awayShift += 4;
        }
      }
    }

    if (currentScore) {
      const diff = currentScore.home - currentScore.away;
      homeShift += diff * 5;
      awayShift -= diff * 5;
    }

    // Baseline 50, apply net shift, clamp between 10 and 90
    const netHome = 50 + (homeShift - awayShift) / 2;
    const homePercent = Math.max(10, Math.min(90, Math.round(netHome)));
    const awayPercent = 100 - homePercent;

    const leader =
      homePercent > 55
        ? `${homeTeam} holding significant attacking momentum`
        : awayPercent > 55
          ? `${awayTeam} exerting sustained offensive pressure`
          : 'Evenly balanced contest';

    return {
      homeTeam,
      awayTeam,
      homePercent,
      awayPercent,
      label: 'Engine-generated momentum',
      explanation: `${leader} (calculated from ${timeline.length} verified match incidents)`,
    };
  }

  /**
   * Produces an accurate post-match aggregate summary strictly from verified
   * timeline incidents. Never fabricates missing statistical data.
   */
  generateFullTimeSummary(snapshot: MatchSnapshot, timeline: TimelineItem[]): MatchSummary {
    const goals: Array<{ minute: number; team: string; player?: string }> = [];
    let totalYellowCards = 0;
    let totalRedCards = 0;
    let totalSubstitutions = 0;

    for (const item of timeline) {
      if (item.type === 'goal') {
        goals.push({
          minute: item.minute,
          team: item.team,
          player: item.description.replace(/^Goal:\s*/i, ''),
        });
      } else if (item.type === 'card') {
        if (item.severity === 'HIGH' || item.description.toLowerCase().includes('red')) {
          totalRedCards++;
        } else {
          totalYellowCards++;
        }
      } else if (item.type === 'substitution') {
        totalSubstitutions++;
      }
    }

    const homeScore = snapshot.score.home;
    const awayScore = snapshot.score.away;
    let headline = `${snapshot.homeTeam} ${homeScore}–${awayScore} ${snapshot.awayTeam}`;

    if (homeScore > awayScore) {
      headline = `FULL TIME: ${snapshot.homeTeam} claim victory over ${snapshot.awayTeam} (${homeScore}-${awayScore})`;
    } else if (awayScore > homeScore) {
      headline = `FULL TIME: ${snapshot.awayTeam} triumph over ${snapshot.homeTeam} (${awayScore}-${homeScore})`;
    } else {
      headline = `FULL TIME: Honours even as ${snapshot.homeTeam} and ${snapshot.awayTeam} draw ${homeScore}-${awayScore}`;
    }

    return {
      matchId: snapshot.matchId,
      status: snapshot.status,
      homeTeam: snapshot.homeTeam,
      awayTeam: snapshot.awayTeam,
      score: snapshot.score,
      scoreFormatted: `${homeScore}–${awayScore}`,
      goals,
      totalCards: totalYellowCards + totalRedCards,
      totalYellowCards,
      totalRedCards,
      totalSubstitutions,
      totalEvents: timeline.length,
      headline,
    };
  }

  /* ------------------------------- internals ------------------------------ */

  private toCanonicalType(event: MatchEvent): CommentaryEventType {
    if (event.type === 'goal') {
      return 'GOAL';
    }
    if (event.type === 'card') {
      const cardType = event.payload.cardType;
      return cardType === 'red' ? 'RED_CARD' : 'YELLOW_CARD';
    }
    if (event.type === 'substitution') {
      return 'SUBSTITUTION';
    }
    return 'GOAL';
  }

  private renderTemplate(
    event: MatchEvent,
    type: CommentaryEventType,
    severity: EventSeverity,
    style: CommentaryStyle,
    snapshot?: MatchSnapshot,
  ): string {
    switch (type) {
      case 'GOAL':
        return this.renderGoal(event, style, snapshot);
      case 'YELLOW_CARD':
        return this.renderYellowCard(event, style);
      case 'RED_CARD':
        return this.renderRedCard(event, style);
      case 'SUBSTITUTION':
        return this.renderSubstitution(event, style);
      default:
        return `${type} recorded in minute ${'minute' in event.payload ? event.payload.minute : 0}`;
    }
  }

  private renderGoal(
    event: MatchEvent,
    style: CommentaryStyle,
    snapshot?: MatchSnapshot,
  ): string {
    if (event.type !== 'goal') return 'GOAL!';
    const { team, player, minute, score } = event.payload;

    if (style === 'concise') {
      return `${minute}' — GOAL ${team}. ${player} (${score}).`;
    }

    if (style === 'professional') {
      return `${team} move ahead following a successful attacking sequence finished by ${player} in minute ${minute} (${score}).`;
    }

    // standard
    const isLead = snapshot
      ? (team === snapshot.homeTeam && snapshot.score.home > snapshot.score.away) ||
        (team === snapshot.awayTeam && snapshot.score.away > snapshot.score.home)
      : true;

    if (isLead) {
      return `GOAL! ${team} take the lead through ${player} in the ${ordinal(minute)} minute! (${score})`;
    }
    return `GOAL! ${player} scores for ${team} in the ${ordinal(minute)} minute! Score is now ${score}.`;
  }

  private renderYellowCard(event: MatchEvent, style: CommentaryStyle): string {
    if (event.type !== 'card') return 'Yellow card.';
    const { team, player, minute } = event.payload;

    if (style === 'concise') {
      return `${minute}' — YELLOW CARD ${player} (${team}).`;
    }

    if (style === 'professional') {
      return `${player} of ${team} is shown a yellow card by the referee for a disciplinary infraction in minute ${minute}.`;
    }

    // standard
    return `YELLOW CARD! ${player} (${team}) receives a booking in the ${ordinal(minute)} minute.`;
  }

  private renderRedCard(event: MatchEvent, style: CommentaryStyle): string {
    if (event.type !== 'card') return 'Red card.';
    const { team, player, minute } = event.payload;

    if (style === 'concise') {
      return `${minute}' — RED CARD ${player} (${team}).`;
    }

    if (style === 'professional') {
      return `${team} are reduced to 10 players as ${player} receives a straight red card in minute ${minute}.`;
    }

    // standard
    return `RED CARD! ${player} (${team}) is sent off in the ${ordinal(minute)} minute!`;
  }

  private renderSubstitution(event: MatchEvent, style: CommentaryStyle): string {
    if (event.type !== 'substitution') return 'Substitution.';
    const { team, playerIn, playerOut, minute } = event.payload;

    if (style === 'concise') {
      return `${minute}' — SUB ${team}: ${playerIn} on for ${playerOut}.`;
    }

    if (style === 'professional') {
      return `${team} execute a tactical alteration: ${playerIn} enters the pitch in place of ${playerOut} (minute ${minute}).`;
    }

    // standard
    return `SUBSTITUTION: ${team} bring on ${playerIn} to replace ${playerOut} in the ${ordinal(minute)} minute.`;
  }
}
