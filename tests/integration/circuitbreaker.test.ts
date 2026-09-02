import request from 'supertest';

import { createHarness, sleep, waitFor, type TestHarness } from '../helpers/testHarness';
import { baselineFixture, goalEntry } from '../mock/mockSportsApi';
import { CircuitBreaker, CircuitState } from '../../src/engine/CircuitBreaker';
import { FakeClock } from '../../src/utils/time';

const MATCH_ID = 'match-789';

describe('Circuit breaker', () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness.close();
  });

  it('trips after 3 consecutive failures, stays open for the backoff, then probes once', async () => {
    // A 2 second backoff keeps the test fast; production defaults to 60s and are
    // asserted separately in health.test.ts.
    harness = await createHarness({
      config: {
        pollingIntervalSeconds: 0.05,
        circuitBreakerFailureThreshold: 3,
        circuitBreakerOpenSeconds: 2,
      },
    });

    harness.mock.setMatch(baselineFixture(MATCH_ID));
    harness.mock.setFailure(MATCH_ID, 503);

    await request(harness.app.server).post('/watch/matches').send({ matchIds: [MATCH_ID] });

    // Exactly three attempts are allowed before the circuit opens.
    await waitFor(() => harness.mock.requestCount(MATCH_ID) >= 3, {
      message: 'the poller never reached the failure threshold',
    });
    expect(harness.mock.requestCount(MATCH_ID)).toBe(3);

    // Circuit is OPEN: many polling intervals pass with zero upstream traffic.
    await sleep(1000);
    expect(harness.mock.requestCount(MATCH_ID)).toBe(3);

    // Once the backoff elapses, HALF_OPEN allows exactly one probe.
    await waitFor(() => harness.mock.requestCount(MATCH_ID) >= 4, {
      timeoutMs: 5000,
      message: 'the half-open probe was never sent',
    });
    expect(harness.mock.requestCount(MATCH_ID)).toBe(4);

    // The probe also fails, so the circuit re-opens instead of resuming polling.
    await sleep(1000);
    expect(harness.mock.requestCount(MATCH_ID)).toBe(4);
  });

  it('recovers and resumes broadcasting once the upstream heals', async () => {
    harness = await createHarness({
      config: {
        pollingIntervalSeconds: 0.05,
        circuitBreakerFailureThreshold: 3,
        circuitBreakerOpenSeconds: 1,
      },
    });

    harness.mock.setMatch(baselineFixture(MATCH_ID));
    harness.mock.setFailure(MATCH_ID, 503);

    await request(harness.app.server).post('/watch/matches').send({ matchIds: [MATCH_ID] });
    await waitFor(() => harness.mock.requestCount(MATCH_ID) >= 3);

    harness.mock.setFailure(MATCH_ID, null);

    // The successful half-open probe closes the circuit and polling resumes.
    await waitFor(() => harness.mock.requestCount(MATCH_ID) >= 6, {
      timeoutMs: 8000,
      message: 'polling did not resume after recovery',
    });

    harness.mock.addEvent(MATCH_ID, goalEntry({ minute: 55 }));
    await waitFor(() => harness.app.deps.stateRepository.get(MATCH_ID)?.events.length === 1, {
      message: 'state was not refreshed after recovery',
    });
  });

  it('isolates failures: a broken match never stops a healthy one', async () => {
    harness = await createHarness({
      config: {
        pollingIntervalSeconds: 0.05,
        circuitBreakerFailureThreshold: 3,
        circuitBreakerOpenSeconds: 30,
      },
    });

    harness.mock.setMatch(baselineFixture('match-broken'));
    harness.mock.setMatch(baselineFixture('match-healthy'));
    harness.mock.setFailure('match-broken', 500);

    await request(harness.app.server)
      .post('/watch/matches')
      .send({ matchIds: ['match-broken', 'match-healthy'] });

    await waitFor(() => harness.mock.requestCount('match-broken') >= 3);
    await sleep(600);

    expect(harness.mock.requestCount('match-broken')).toBe(3);
    expect(harness.mock.requestCount('match-healthy')).toBeGreaterThan(3);
  });

  it('implements the CLOSED -> OPEN -> HALF_OPEN -> CLOSED state machine', async () => {
    const clock = new FakeClock(0);
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      openTimeoutMs: 60_000,
      clock,
      name: 'unit',
    });

    const fail = async (): Promise<never> => {
      throw new Error('upstream down');
    };
    const succeed = async (): Promise<string> => 'ok';

    expect(breaker.state).toBe(CircuitState.CLOSED);

    await expect(breaker.execute(fail)).rejects.toThrow('upstream down');
    await expect(breaker.execute(fail)).rejects.toThrow('upstream down');
    expect(breaker.state).toBe(CircuitState.CLOSED);

    await expect(breaker.execute(fail)).rejects.toThrow('upstream down');
    expect(breaker.state).toBe(CircuitState.OPEN);

    // While OPEN the operation is not invoked at all.
    const spy = jest.fn(succeed);
    await expect(breaker.execute(spy)).rejects.toThrow(/OPEN/);
    expect(spy).not.toHaveBeenCalled();

    // Still open one millisecond before the backoff elapses.
    clock.advance(59_999);
    expect(breaker.state).toBe(CircuitState.OPEN);

    clock.advance(1);
    expect(breaker.state).toBe(CircuitState.HALF_OPEN);

    // A failing probe re-opens the circuit and restarts the timer.
    await expect(breaker.execute(fail)).rejects.toThrow('upstream down');
    expect(breaker.state).toBe(CircuitState.OPEN);

    clock.advance(60_000);
    expect(breaker.state).toBe(CircuitState.HALF_OPEN);

    // A successful probe closes it again.
    await expect(breaker.execute(succeed)).resolves.toBe('ok');
    expect(breaker.state).toBe(CircuitState.CLOSED);
    expect(breaker.failureCount).toBe(0);
  });
});
