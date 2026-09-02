import request from 'supertest';

import {
  SseTestClient,
  createHarness,
  waitFor,
  type TestHarness,
} from '../helpers/testHarness';
import {
  AWAY_TEAM,
  HOME_TEAM,
  baselineFixture,
  cardEntry,
  goalEntry,
  substitutionEntry,
} from '../mock/mockSportsApi';

const MATCH_ID = 'match-123';

describe('SSE stream (/events)', () => {
  let harness: TestHarness;
  let client: SseTestClient | null = null;

  beforeEach(async () => {
    harness = await createHarness({ listen: true });
    harness.mock.setMatch(baselineFixture(MATCH_ID));
  });

  afterEach(async () => {
    client?.close();
    client = null;
    await harness.close();
  });

  /**
   * Subscribe, start watching the match, and wait until the baseline poll has
   * happened. Only *changes* after the baseline are broadcast.
   */
  async function subscribeAndWatch(): Promise<SseTestClient> {
    const sse = await SseTestClient.connect(`${harness.baseUrl}/events`);
    client = sse;

    await request(harness.app.server).post('/watch/matches').send({ matchIds: [MATCH_ID] });
    await waitFor(() => harness.mock.requestCount(MATCH_ID) >= 1, {
      message: 'baseline poll never happened',
    });

    return sse;
  }

  it('responds with the Server-Sent Events headers', async () => {
    const sse = await SseTestClient.connect(`${harness.baseUrl}/events`);
    client = sse;

    expect(sse.statusCode).toBe(200);
    expect(sse.headers['content-type']).toContain('text/event-stream');
    expect(sse.headers['cache-control']).toContain('no-cache');
    expect(sse.headers.connection).toContain('keep-alive');
  });

  it('broadcasts a goal event when the score changes upstream', async () => {
    const sse = await subscribeAndWatch();

    harness.mock.addEvent(MATCH_ID, goalEntry({ team: HOME_TEAM, player: 'Bukayo Saka', minute: 15 }));

    const event = await sse.waitForEvent('goal');
    expect(event.event).toBe('goal');
    expect(event.json()).toEqual({
      matchId: MATCH_ID,
      team: HOME_TEAM,
      player: 'Bukayo Saka',
      minute: 15,
      score: '1-0',
    });
  });

  it('broadcasts a card event', async () => {
    const sse = await subscribeAndWatch();

    harness.mock.addEvent(
      MATCH_ID,
      cardEntry({ team: AWAY_TEAM, player: 'Reece James', minute: 22, cardType: 'yellow' }),
    );

    const event = await sse.waitForEvent('card');
    expect(event.json()).toEqual({
      matchId: MATCH_ID,
      team: AWAY_TEAM,
      player: 'Reece James',
      minute: 22,
      cardType: 'yellow',
    });
  });

  it('broadcasts a substitution event', async () => {
    const sse = await subscribeAndWatch();

    harness.mock.addEvent(
      MATCH_ID,
      substitutionEntry({
        team: HOME_TEAM,
        playerIn: 'Gabriel Jesus',
        playerOut: 'Kai Havertz',
        minute: 67,
      }),
    );

    const event = await sse.waitForEvent('substitution');
    expect(event.json()).toEqual({
      matchId: MATCH_ID,
      team: HOME_TEAM,
      playerIn: 'Gabriel Jesus',
      playerOut: 'Kai Havertz',
      minute: 67,
    });
  });

  it('fans the same event out to every connected client', async () => {
    const first = await subscribeAndWatch();
    const second = await SseTestClient.connect(`${harness.baseUrl}/events`);

    try {
      await waitFor(() => harness.app.deps.broadcaster.clientCount === 2, {
        message: 'second client never registered',
      });

      harness.mock.addEvent(MATCH_ID, goalEntry({ id: 'goal-fanout', minute: 31 }));

      const [a, b] = await Promise.all([first.waitForEvent('goal'), second.waitForEvent('goal')]);

      expect(a.json()).toEqual(b.json());
      expect(a.id).toBe(b.id);
    } finally {
      second.close();
    }
  });

  it('does not replay historic incidents when the baseline is established', async () => {
    // Pre-existing goal before the service ever polls the match.
    harness.mock.addEvent(MATCH_ID, goalEntry({ id: 'historic', minute: 3 }));

    const sse = await subscribeAndWatch();
    await waitFor(() => harness.mock.requestCount(MATCH_ID) >= 3);

    expect(sse.events).toHaveLength(0);

    // A genuinely new incident is still delivered.
    harness.mock.addEvent(MATCH_ID, cardEntry({ id: 'fresh-card', minute: 40 }));
    const event = await sse.waitForEvent('card');
    expect(event.json()).toMatchObject({ matchId: MATCH_ID, minute: 40 });
  });

  it('drops the client from the broadcaster when the connection closes', async () => {
    const sse = await SseTestClient.connect(`${harness.baseUrl}/events`);
    await waitFor(() => harness.app.deps.broadcaster.clientCount === 1);

    sse.close();

    await waitFor(() => harness.app.deps.broadcaster.clientCount === 0, {
      message: 'client was not unregistered on disconnect',
    });
  });
});
