import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * Controllable stand-in for the upstream sports provider.
 *
 * It is shipped in `src/` (not only in `tests/`) for two reasons:
 *   1. the integration suite drives it programmatically,
 *   2. `docker compose up` starts it as a second container so the whole stack
 *      is demonstrable without a third-party API key.
 *
 * Data endpoint:
 *   GET  /matches/:matchId          -> current fixture (or the configured failure)
 *
 * Control endpoints (also usable with curl):
 *   GET  /_control/requests         -> recorded request log
 *   PUT  /_control/matches/:matchId -> replace a fixture (JSON body)
 *   PUT  /_control/failures/:matchId?status=503 -> force a failure status
 *   DELETE /_control/failures/:matchId          -> clear the forced failure
 *   POST /_control/reset            -> clear fixtures, failures and the log
 */

export interface MockTimelineEntry {
  id?: string;
  type: 'goal' | 'card' | 'substitution';
  team: string;
  minute: number;
  player?: string;
  playerIn?: string;
  playerOut?: string;
  cardType?: 'yellow' | 'red';
  score?: string;
}

export interface MockMatchFixture {
  matchId: string;
  status: string;
  minute: number;
  homeTeam: string;
  awayTeam: string;
  score: { home: number; away: number };
  events: MockTimelineEntry[];
}

export interface RecordedRequest {
  matchId: string;
  url: string;
  timestamp: number;
}

export function createFixture(
  matchId: string,
  overrides: Partial<MockMatchFixture> = {},
): MockMatchFixture {
  return {
    matchId,
    status: 'IN_PLAY',
    minute: 0,
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    score: { home: 0, away: 0 },
    events: [],
    ...overrides,
  };
}

export class MockSportsApiServer {
  private readonly server: http.Server;
  private readonly fixtures = new Map<string, MockMatchFixture>();
  private readonly failures = new Map<string, number>();
  private requests: RecordedRequest[] = [];
  private listeningPort = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch(() => {
        this.json(res, 500, { error: 'mock server failure' });
      });
    });
  }

  /* ------------------------------- lifecycle ------------------------------ */

  async start(port = 0, host = '0.0.0.0'): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });

    this.listeningPort = (this.server.address() as AddressInfo).port;
    return this.listeningPort;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  get port(): number {
    return this.listeningPort;
  }

  get url(): string {
    return `http://127.0.0.1:${this.listeningPort}`;
  }

  /* ----------------------------- test controls ---------------------------- */

  setMatch(fixture: MockMatchFixture): void {
    this.fixtures.set(fixture.matchId, fixture);
  }

  getMatch(matchId: string): MockMatchFixture | undefined {
    return this.fixtures.get(matchId);
  }

  /** Append a timeline entry and keep the aggregate score consistent. */
  addEvent(matchId: string, entry: MockTimelineEntry): void {
    const fixture = this.fixtures.get(matchId) ?? createFixture(matchId);
    const events = [...fixture.events, entry];
    const score = { ...fixture.score };

    if (entry.type === 'goal') {
      if (entry.team === fixture.homeTeam) {
        score.home += 1;
      } else {
        score.away += 1;
      }
    }

    this.fixtures.set(matchId, {
      ...fixture,
      events,
      score,
      minute: Math.max(fixture.minute, entry.minute),
    });
  }

  /** Update match status, e.g. 'IN_PLAY', 'HALF_TIME', 'FINISHED', 'FULL_TIME'. */
  setStatus(matchId: string, status: string): void {
    const fixture = this.fixtures.get(matchId) ?? createFixture(matchId);
    this.fixtures.set(matchId, {
      ...fixture,
      status,
    });
  }

  /** Force every request for `matchId` to fail with `status` (null clears it). */
  setFailure(matchId: string, status: number | null): void {
    if (status === null) {
      this.failures.delete(matchId);
    } else {
      this.failures.set(matchId, status);
    }
  }

  getRequests(matchId?: string): RecordedRequest[] {
    return matchId ? this.requests.filter((entry) => entry.matchId === matchId) : [...this.requests];
  }

  requestCount(matchId?: string): number {
    return this.getRequests(matchId).length;
  }

  clearRequests(): void {
    this.requests = [];
  }

  reset(): void {
    this.fixtures.clear();
    this.failures.clear();
    this.requests = [];
  }

  /* ------------------------------- internals ------------------------------ */

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://localhost:${this.listeningPort}`);
    const segments = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    // GET /health
    if (method === 'GET' && segments[0] === 'health') {
      this.json(res, 200, { status: 'ok' });
      return;
    }

    // Control plane
    if (segments[0] === '_control') {
      await this.handleControl(method, segments, url, req, res);
      return;
    }

    // GET /matches
    if (method === 'GET' && segments[0] === 'matches' && !segments[1]) {
      this.json(res, 200, { matches: [...this.fixtures.values()] });
      return;
    }

    // GET /matches/:matchId
    if (method === 'GET' && segments[0] === 'matches' && segments[1]) {
      const matchId = decodeURIComponent(segments[1]);
      this.requests.push({ matchId, url: url.pathname, timestamp: Date.now() });

      const failure = this.failures.get(matchId);
      if (failure !== undefined) {
        this.json(res, failure, { error: `Simulated upstream failure (${failure})` });
        return;
      }

      const fixture = this.fixtures.get(matchId);
      if (!fixture) {
        this.json(res, 404, { error: `Unknown match "${matchId}"` });
        return;
      }

      this.json(res, 200, fixture);
      return;
    }

    this.json(res, 404, { error: 'Not Found' });
  }

  private async handleControl(
    method: string,
    segments: string[],
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const resource = segments[1];
    const id = segments[2] ? decodeURIComponent(segments[2]) : undefined;

    if (method === 'GET' && resource === 'requests') {
      const matchId = url.searchParams.get('matchId') ?? undefined;
      this.json(res, 200, { requests: this.getRequests(matchId) });
      return;
    }

    if (method === 'POST' && resource === 'reset') {
      this.reset();
      this.json(res, 200, { status: 'reset' });
      return;
    }

    if (method === 'PUT' && resource === 'matches' && id) {
      const body = (await readJsonBody(req)) as Partial<MockMatchFixture> | null;
      this.setMatch(createFixture(id, { ...(body ?? {}), matchId: id }));
      this.json(res, 200, this.fixtures.get(id));
      return;
    }

    if ((method === 'POST' || method === 'PUT') && resource === 'events' && id) {
      const body = (await readJsonBody(req)) as Partial<MockTimelineEntry> | null;
      const fixture = this.fixtures.get(id) ?? createFixture(id);
      const type = (body?.type as 'goal' | 'card' | 'substitution') ?? 'goal';
      const entry: MockTimelineEntry = {
        id: body?.id ?? `e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type,
        team: body?.team ?? fixture.homeTeam,
        minute: body?.minute ?? Math.min(90, fixture.minute + 3),
        player: body?.player ?? (type === 'goal' ? 'Bukayo Saka' : 'Player'),
        playerIn: body?.playerIn,
        playerOut: body?.playerOut,
        cardType: body?.cardType ?? (type === 'card' ? 'yellow' : undefined),
      };
      this.addEvent(id, entry);
      this.json(res, 200, { matchId: id, event: entry, fixture: this.fixtures.get(id) });
      return;
    }

    if ((method === 'POST' || method === 'PUT') && (resource === 'status' || resource === 'end') && id) {
      const body = (await readJsonBody(req)) as { status?: string } | null;
      const status =
        resource === 'end'
          ? 'FINISHED'
          : (url.searchParams.get('status') ?? body?.status ?? 'FINISHED');
      this.setStatus(id, status);
      this.json(res, 200, { matchId: id, status, fixture: this.fixtures.get(id) });
      return;
    }

    if (method === 'PUT' && resource === 'failures' && id) {
      const status = Number(url.searchParams.get('status') ?? 503);
      this.setFailure(id, Number.isFinite(status) ? status : 503);
      this.json(res, 200, { matchId: id, status });
      return;
    }

    if (method === 'DELETE' && resource === 'failures' && id) {
      this.setFailure(id, null);
      this.json(res, 200, { matchId: id, status: null });
      return;
    }

    this.json(res, 404, { error: 'Unknown control endpoint' });
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body ?? {});
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) {
    return null;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}
