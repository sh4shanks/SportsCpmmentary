import { z } from 'zod';
import {
  type CardType,
  type MatchSnapshot,
  type MatchTimelineEntry,
  type TimelineEntryType,
} from '../models/MatchSnapshot';
import { ExternalApiError, isAbortError } from '../utils/errors';
import type { ILogger } from '../utils/logger';
import { SilentLogger } from '../utils/logger';

/**
 * Port for the upstream provider. Workers depend on this interface only, which
 * is what makes the whole engine testable with an in-memory fake.
 */
export interface ISportsApiClient {
  fetchMatch(matchId: string, signal?: AbortSignal): Promise<MatchSnapshot>;
}

/** Minimal structural type for `fetch`, so no DOM lib is required. */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; method?: string },
) => Promise<FetchResponseLike>;

export interface SportsApiClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  logger?: ILogger;
  /** Injectable transport – defaults to the global `fetch` of Node 20+. */
  fetchImpl?: FetchLike;
  /** Path template for a single match. `:matchId` is replaced at call time. */
  matchPath?: string;
}

/* -------------------------------------------------------------------------- */
/* Upstream payload schema (deliberately permissive)                           */
/* -------------------------------------------------------------------------- */

const TeamSchema = z.union([z.string(), z.object({ name: z.string() }).passthrough()]);

const RawTimelineEntrySchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    type: z.string(),
    team: TeamSchema.optional(),
    player: z.string().optional(),
    playerIn: z.string().optional(),
    playerOut: z.string().optional(),
    minute: z.coerce.number().optional(),
    cardType: z.string().optional(),
    score: z.string().optional(),
  })
  .passthrough();

const RawMatchSchema = z
  .object({
    matchId: z.union([z.string(), z.number()]).optional(),
    id: z.union([z.string(), z.number()]).optional(),
    status: z.string().optional(),
    minute: z.coerce.number().optional(),
    homeTeam: TeamSchema.optional(),
    awayTeam: TeamSchema.optional(),
    score: z
      .object({ home: z.coerce.number(), away: z.coerce.number() })
      .passthrough()
      .optional(),
    events: z.array(RawTimelineEntrySchema).optional(),
  })
  .passthrough();

type RawTimelineEntry = z.infer<typeof RawTimelineEntrySchema>;

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

export class HttpSportsApiClient implements ISportsApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly logger: ILogger;
  private readonly fetchImpl: FetchLike;
  private readonly matchPath: string;

  constructor(options: SportsApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? '';
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.logger = options.logger ?? new SilentLogger();
    this.matchPath = options.matchPath ?? '/matches/:matchId';

    const transport = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!transport) {
      throw new Error('No fetch implementation available. Node.js 18+ is required.');
    }
    this.fetchImpl = transport;
  }

  async fetchMatch(matchId: string, signal?: AbortSignal): Promise<MatchSnapshot> {
    const url = `${this.baseUrl}${this.matchPath.replace(':matchId', encodeURIComponent(matchId))}`;
    const { signal: requestSignal, dispose } = this.buildSignal(signal);

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: requestSignal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new ExternalApiError(
          `Upstream request for match "${matchId}" failed with status ${response.status}${
            body ? `: ${body.slice(0, 200)}` : ''
          }`,
          response.status,
        );
      }

      const payload = await response.json();
      return this.toSnapshot(matchId, payload);
    } catch (error) {
      if (error instanceof ExternalApiError) {
        throw error;
      }
      if (isAbortError(error)) {
        throw new ExternalApiError(`Upstream request for match "${matchId}" timed out`);
      }
      throw new ExternalApiError(
        `Upstream request for match "${matchId}" failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      dispose();
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };

    if (this.apiKey) {
      // `X-Auth-Token` is what football-data.org expects; the Bearer header
      // covers most other providers. Sending both is harmless.
      headers['X-Auth-Token'] = this.apiKey;
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  /**
   * Combine the caller's cancellation signal with a request timeout without
   * relying on `AbortSignal.any` (Node >= 20.3 only).
   */
  private buildSignal(external?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();

    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    const onExternalAbort = (): void => controller.abort();

    if (external) {
      if (external.aborted) {
        controller.abort();
      } else {
        external.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    return {
      signal: controller.signal,
      dispose: (): void => {
        clearTimeout(timer);
        external?.removeEventListener('abort', onExternalAbort);
      },
    };
  }

  /** Translate an arbitrary provider payload into the internal snapshot model. */
  private toSnapshot(matchId: string, payload: unknown): MatchSnapshot {
    const parsed = RawMatchSchema.safeParse(payload);

    if (!parsed.success) {
      throw new ExternalApiError(
        `Unexpected payload for match "${matchId}": ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
      );
    }

    const raw = parsed.data;
    const homeTeam = readTeamName(raw.homeTeam) ?? 'Home';
    const awayTeam = readTeamName(raw.awayTeam) ?? 'Away';

    const events: MatchTimelineEntry[] = [];

    for (const [index, entry] of (raw.events ?? []).entries()) {
      const normalized = this.toTimelineEntry(entry, index, homeTeam);
      if (normalized) {
        events.push(normalized);
      } else {
        this.logger.debug('Skipping unsupported timeline entry', { matchId, type: entry.type });
      }
    }

    return {
      matchId: String(raw.matchId ?? raw.id ?? matchId),
      status: raw.status ?? 'UNKNOWN',
      homeTeam,
      awayTeam,
      score: { home: raw.score?.home ?? 0, away: raw.score?.away ?? 0 },
      minute: raw.minute ?? events.reduce((max, entry) => Math.max(max, entry.minute), 0),
      events,
      fetchedAt: Date.now(),
    };
  }

  private toTimelineEntry(
    entry: RawTimelineEntry,
    index: number,
    fallbackTeam: string,
  ): MatchTimelineEntry | null {
    const type = normalizeEntryType(entry.type);
    if (!type) {
      return null;
    }

    const minute = entry.minute ?? 0;
    const team = readTeamName(entry.team) ?? fallbackTeam;
    const id =
      entry.id !== undefined && entry.id !== null
        ? String(entry.id)
        : `${type}-${minute}-${team}-${entry.player ?? entry.playerIn ?? index}`;

    const normalized: MatchTimelineEntry = {
      id,
      type,
      team,
      minute,
      ...(entry.player !== undefined ? { player: entry.player } : {}),
      ...(entry.playerIn !== undefined ? { playerIn: entry.playerIn } : {}),
      ...(entry.playerOut !== undefined ? { playerOut: entry.playerOut } : {}),
      ...(type === 'card' ? { cardType: normalizeCardType(entry.type, entry.cardType) } : {}),
      ...(entry.score !== undefined ? { score: entry.score } : {}),
    };

    return normalized;
  }
}

/* -------------------------------------------------------------------------- */
/* Normalization helpers                                                       */
/* -------------------------------------------------------------------------- */

function readTeamName(team: unknown): string | undefined {
  if (typeof team === 'string') {
    return team;
  }
  if (team && typeof team === 'object' && 'name' in team) {
    const { name } = team as { name?: unknown };
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}

function normalizeEntryType(rawType: string): TimelineEntryType | null {
  const value = rawType.toLowerCase();

  if (value.includes('sub')) {
    return 'substitution';
  }
  if (value.includes('card') || value === 'yellow' || value === 'red' || value === 'booking') {
    return 'card';
  }
  if (value.includes('goal') || value === 'score' || value === 'penalty') {
    return 'goal';
  }
  return null;
}

function normalizeCardType(rawType: string, rawCardType?: string): CardType {
  const value = `${rawCardType ?? ''} ${rawType}`.toLowerCase();
  return value.includes('red') ? 'red' : 'yellow';
}
