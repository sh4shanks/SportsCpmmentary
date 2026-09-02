import request from 'supertest';

import { createHarness, sleep, waitFor, type TestHarness } from '../helpers/testHarness';
import { baselineFixture, type RecordedRequest } from '../mock/mockSportsApi';
import { TokenBucketRateLimiter } from '../../src/engine/RateLimiter';
import { FakeClock } from '../../src/utils/time';

/** Largest number of requests found in any 60 second sliding window. */
function maxRequestsInWindow(requests: RecordedRequest[], windowMs: number): number {
  const timestamps = requests.map((entry) => entry.timestamp).sort((a, b) => a - b);
  let max = 0;

  for (let start = 0; start < timestamps.length; start += 1) {
    let count = 0;
    for (let end = start; end < timestamps.length; end += 1) {
      if ((timestamps[end] as number) - (timestamps[start] as number) < windowMs) {
        count += 1;
      } else {
        break;
      }
    }
    max = Math.max(max, count);
  }

  return max;
}

describe('Global rate limiting', () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness.close();
  });

  it('never exceeds 10 upstream requests in any 60 second window, across all workers', async () => {
    harness = await createHarness({
      config: {
        pollingIntervalSeconds: 0.05,
        rateLimitMaxRequests: 10,
        rateLimitWindowSeconds: 60,
      },
    });

    // 15 concurrent workers all competing for a shared budget of 10 calls.
    const matchIds = Array.from({ length: 15 }, (_, index) => `match-rl-${index + 1}`);
    for (const matchId of matchIds) {
      harness.mock.setMatch(baselineFixture(matchId));
    }

    const response = await request(harness.app.server).post('/watch/matches').send({ matchIds });
    expect(response.status).toBe(202);

    // The bucket is drained immediately; everything after that must be blocked.
    await waitFor(() => harness.mock.requestCount() >= 10, {
      message: 'workers never reached the rate limit ceiling',
    });

    // Keep the workers spinning well beyond several polling intervals.
    await sleep(2000);

    const requests = harness.mock.getRequests();
    expect(requests.length).toBe(10);
    expect(maxRequestsInWindow(requests, 60_000)).toBeLessThanOrEqual(10);

    // Every worker is alive – they are waiting for a token, not dead.
    const list = await request(harness.app.server).get('/watch/matches');
    expect(list.body.watching).toHaveLength(15);
  });

  it('lets throttled workers through again once tokens regenerate', async () => {
    harness = await createHarness({
      config: {
        pollingIntervalSeconds: 0.02,
        rateLimitMaxRequests: 5,
        // Short window so regeneration is observable inside the test budget.
        rateLimitWindowSeconds: 1,
      },
    });

    const matchIds = ['match-rr-1', 'match-rr-2', 'match-rr-3'];
    for (const matchId of matchIds) {
      harness.mock.setMatch(baselineFixture(matchId));
    }

    await request(harness.app.server).post('/watch/matches').send({ matchIds });

    await waitFor(() => harness.mock.requestCount() >= 5);
    await sleep(1500);

    const requests = harness.mock.getRequests();
    expect(requests.length).toBeGreaterThan(5);
    expect(maxRequestsInWindow(requests, 1000)).toBeLessThanOrEqual(5);
  });

  it('regenerates a token exactly one window after it was consumed (unit level)', async () => {
    const clock = new FakeClock(0);
    const limiter = new TokenBucketRateLimiter({ capacity: 2, windowMs: 60_000, clock });

    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.availableTokens).toBe(0);

    clock.advance(59_999);
    expect(limiter.availableTokens).toBe(0);

    clock.advance(1);
    expect(limiter.availableTokens).toBe(1);
  });

  it('aborts a queued acquisition when the caller is cancelled', async () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 1, windowMs: 60_000 });
    await limiter.acquire();

    const controller = new AbortController();
    const queued = limiter.acquire(controller.signal);
    controller.abort();

    await expect(queued).rejects.toThrow(/aborted/i);
  });
});
