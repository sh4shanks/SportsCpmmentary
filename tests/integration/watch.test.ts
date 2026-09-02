import request from 'supertest';

import { createHarness, waitFor, type TestHarness } from '../helpers/testHarness';
import { baselineFixture } from '../mock/mockSportsApi';

describe('Watchlist API (/watch/matches)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
    harness.mock.setMatch(baselineFixture('match-A'));
    harness.mock.setMatch(baselineFixture('match-B'));
  });

  afterEach(async () => {
    await harness.close();
  });

  it('accepts matches with 202, lists them with 200 and removes them with 204', async () => {
    const post = await request(harness.app.server)
      .post('/watch/matches')
      .send({ matchIds: ['match-A', 'match-B'] });

    expect(post.status).toBe(202);
    expect(post.body.accepted).toEqual(['match-A', 'match-B']);

    const list = await request(harness.app.server).get('/watch/matches');
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ watching: ['match-A', 'match-B'] });

    const remove = await request(harness.app.server)
      .delete('/watch/matches')
      .send({ matchIds: ['match-A'] });

    expect(remove.status).toBe(204);
    expect(remove.text).toBe('');

    const listAfter = await request(harness.app.server).get('/watch/matches');
    expect(listAfter.status).toBe(200);
    expect(listAfter.body.watching).toEqual(['match-B']);
    expect(listAfter.body.watching).not.toContain('match-A');
  });

  it('never starts a duplicate worker for the same match id', async () => {
    await request(harness.app.server).post('/watch/matches').send({ matchIds: ['match-A'] });

    const second = await request(harness.app.server)
      .post('/watch/matches')
      .send({ matchIds: ['match-A', 'match-A', 'match-B'] });

    expect(second.status).toBe(202);
    expect(second.body.accepted).toEqual(['match-B']);
    expect(second.body.alreadyWatching).toEqual(['match-A']);

    const list = await request(harness.app.server).get('/watch/matches');
    expect(list.body.watching).toEqual(['match-A', 'match-B']);
  });

  it('runs concurrent polling loops for every watched match', async () => {
    await request(harness.app.server)
      .post('/watch/matches')
      .send({ matchIds: ['match-A', 'match-B'] });

    // Both workers must reach the upstream provider independently.
    await waitFor(
      () => harness.mock.requestCount('match-A') >= 2 && harness.mock.requestCount('match-B') >= 2,
      { message: 'expected both matches to be polled concurrently' },
    );

    expect(harness.mock.requestCount('match-A')).toBeGreaterThanOrEqual(2);
    expect(harness.mock.requestCount('match-B')).toBeGreaterThanOrEqual(2);
  });

  it('stops polling a match once it is removed from the watchlist', async () => {
    await request(harness.app.server).post('/watch/matches').send({ matchIds: ['match-A'] });
    await waitFor(() => harness.mock.requestCount('match-A') >= 1);

    await request(harness.app.server).delete('/watch/matches').send({ matchIds: ['match-A'] });

    // Allow an in-flight poll to settle, then confirm the loop is silent.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const countAfterStop = harness.mock.requestCount('match-A');

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(harness.mock.requestCount('match-A')).toBe(countAfterStop);
  });

  it('rejects invalid payloads with a JSON 400', async () => {
    const missingField = await request(harness.app.server).post('/watch/matches').send({});
    expect(missingField.status).toBe(400);
    expect(missingField.headers['content-type']).toContain('application/json');
    expect(missingField.body.error).toBe('Invalid request body');

    const emptyArray = await request(harness.app.server)
      .post('/watch/matches')
      .send({ matchIds: [] });
    expect(emptyArray.status).toBe(400);

    const wrongType = await request(harness.app.server)
      .post('/watch/matches')
      .send({ matchIds: [42] });
    expect(wrongType.status).toBe(400);

    const illegalCharacters = await request(harness.app.server)
      .post('/watch/matches')
      .send({ matchIds: ['../../etc/passwd'] });
    expect(illegalCharacters.status).toBe(400);
    expect(illegalCharacters.body.details).toEqual(expect.any(Array));
  });
});
