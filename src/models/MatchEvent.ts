import type { CardType } from './MatchSnapshot';

/**
 * Public event contract broadcast over SSE.
 *
 * These payloads are intentionally decoupled from the upstream provider: the
 * change detector translates provider data into exactly these shapes.
 */

export type MatchEventType = 'goal' | 'card' | 'substitution';

export interface GoalEventPayload {
  matchId: string;
  team: string;
  player: string;
  minute: number;
  /** Score after the goal, e.g. "2-1" (home-away). */
  score: string;
}

export interface CardEventPayload {
  matchId: string;
  team: string;
  player: string;
  minute: number;
  cardType: CardType;
}

export interface SubstitutionEventPayload {
  matchId: string;
  team: string;
  playerIn: string;
  playerOut: string;
  minute: number;
}

export type MatchEventPayload = GoalEventPayload | CardEventPayload | SubstitutionEventPayload;

interface BaseMatchEvent {
  /** Stable, de-duplicated identifier; also emitted as the SSE `id:` field. */
  readonly id: string;
  readonly matchId: string;
  /** Epoch millis at which the service detected the event. */
  readonly detectedAt: number;
}

export interface GoalEvent extends BaseMatchEvent {
  readonly type: 'goal';
  readonly payload: GoalEventPayload;
}

export interface CardEvent extends BaseMatchEvent {
  readonly type: 'card';
  readonly payload: CardEventPayload;
}

export interface SubstitutionEvent extends BaseMatchEvent {
  readonly type: 'substitution';
  readonly payload: SubstitutionEventPayload;
}

/** Discriminated union of everything the service can broadcast. */
export type MatchEvent = GoalEvent | CardEvent | SubstitutionEvent;

/**
 * Serialize an event into a wire-format SSE message.
 *
 *   id: <event id>
 *   event: goal
 *   data: {"matchId":"...", ...}
 *   <blank line>
 */
export function formatSseMessage(event: MatchEvent): string {
  const data = JSON.stringify(event.payload);
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${data}\n\n`;
}

/** Serialize an SSE comment line (used for keep-alive frames). */
export function formatSseComment(comment: string): string {
  return `: ${comment}\n\n`;
}
