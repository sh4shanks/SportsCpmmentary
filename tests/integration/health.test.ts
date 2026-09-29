import request from 'supertest';

import { createHarness, type TestHarness } from '../helpers/testHarness';
import { loadConfig } from '../../src/config/env';

describe('GET /health', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('returns 200 with {"status":"ok"}', async () => {
    const response = await request(harness.app.server).get('/health');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toMatchObject({ status: 'ok' });
  });

  it('reports how many matches are watched and how many SSE clients are attached', async () => {
    const response = await request(harness.app.server).get('/health');

    expect(response.body).toEqual(
      expect.objectContaining({
        status: 'ok',
        watching: expect.any(Number),
        sseClients: expect.any(Number),
        uptimeSeconds: expect.any(Number),
      }),
    );
  });

  it('answers unknown routes with JSON rather than HTML', async () => {
    const response = await request(harness.app.server).get('/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body.error).toEqual(expect.any(String));
  });

  it('ships production defaults of 10 requests/60s and a 60s circuit breaker backoff', () => {
    const config = loadConfig({
      EXTERNAL_API_URL: 'http://localhost:4000',
    } as NodeJS.ProcessEnv);

    expect(config.rateLimitMaxRequests).toBe(10);
    expect(config.rateLimitWindowSeconds).toBe(60);
    expect(config.circuitBreakerFailureThreshold).toBe(3);
    expect(config.circuitBreakerOpenSeconds).toBe(60);
  });

  describe('GET / (Root overview route)', () => {
    it('returns 200 with HTML dashboard by default', async () => {
      const response = await request(harness.app.server).get('/');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.text).toContain('Sports Commentary Service');
      expect(response.text).toContain('/health');
      expect(response.text).toContain('/events');
    });

    it('returns 200 with JSON overview when Accept is application/json', async () => {
      const response = await request(harness.app.server)
        .get('/')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body).toMatchObject({
        name: 'sports-commentary-service',
        status: 'ok',
        endpoints: expect.any(Array),
      });
    });
  });
});
