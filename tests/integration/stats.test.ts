import request from 'supertest';
import { createHarness, waitFor, type TestHarness } from '../helpers/testHarness';
import { baselineFixture, goalEntry, cardEntry } from '../mock/mockSportsApi';

describe('GET /stats (Observability & Telemetry)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('returns 200 with structured observability telemetry', async () => {
    const response = await request(harness.app.server).get('/stats');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toMatchObject({
      service: {
        name: 'SportsPulse',
        status: 'ok',
        uptimeSeconds: expect.any(Number),
      },
      metrics: {
        events: {
          goals: expect.any(Number),
          yellowCards: expect.any(Number),
          redCards: expect.any(Number),
          substitutions: expect.any(Number),
          total: expect.any(Number),
        },
        polling: {
          totalPolls: expect.any(Number),
          successfulPolls: expect.any(Number),
          failedPolls: expect.any(Number),
          circuitBreakerRejections: expect.any(Number),
        },
      },
      rateLimiter: {
        capacity: expect.any(Number),
        windowSeconds: expect.any(Number),
        availableTokens: expect.any(Number),
        consumedTokens: expect.any(Number),
      },
      circuitBreakers: {
        summary: {
          closed: expect.any(Number),
          halfOpen: expect.any(Number),
          open: expect.any(Number),
          total: expect.any(Number),
        },
      },
      watchlist: {
        total: 0,
        matches: [],
      },
      sse: {
        connectedClients: 0,
      },
    });
  });

  it('accurately tracks watched matches, worker statuses and snapshots in stats', async () => {
    harness.mock.setMatch(baselineFixture('match-stats-1'));

    await request(harness.app.server)
      .post('/watch/matches')
      .send({ matchIds: ['match-stats-1'] });

    await waitFor(() => harness.mock.requestCount('match-stats-1') >= 1);

    const stats = await request(harness.app.server).get('/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.watchlist.total).toBe(1);
    expect(stats.body.circuitBreakers.summary.closed).toBe(1);

    const workerStat = stats.body.watchlist.matches.find(
      (m: { matchId: string }) => m.matchId === 'match-stats-1',
    );
    expect(workerStat).toBeDefined();
    expect(workerStat.workerRunning).toBe(true);
    expect(workerStat.circuitState).toBe('CLOSED');
    expect(workerStat.pollCount).toBeGreaterThanOrEqual(1);
    expect(workerStat.snapshot).toMatchObject({
      homeTeam: 'Arsenal',
      awayTeam: 'Chelsea',
      score: { home: 0, away: 0 },
    });
  });

  it('increments event counters when incidents are detected', async () => {
    harness.mock.setMatch(baselineFixture('match-events-test'));

    await request(harness.app.server)
      .post('/watch/matches')
      .send({ matchIds: ['match-events-test'] });

    await waitFor(() => harness.mock.requestCount('match-events-test') >= 1);

    // Inject goal and yellow card
    harness.mock.addEvent('match-events-test', goalEntry({ minute: 34 }));
    harness.mock.addEvent('match-events-test', cardEntry({ minute: 40, cardType: 'yellow' }));

    await waitFor(
      async () => {
        const res = await request(harness.app.server).get('/stats');
        return res.body.metrics.events.total >= 2;
      },
      { timeoutMs: 4000, message: 'event counters never updated in stats' },
    );

    const statsAfter = await request(harness.app.server).get('/stats');
    expect(statsAfter.body.metrics.events.goals).toBeGreaterThanOrEqual(1);
    expect(statsAfter.body.metrics.events.yellowCards).toBeGreaterThanOrEqual(1);
    expect(statsAfter.body.metrics.events.total).toBeGreaterThanOrEqual(2);
    expect(statsAfter.body.recentEvents.length).toBeGreaterThanOrEqual(2);
  });
});
