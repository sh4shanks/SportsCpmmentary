import http from 'node:http';
import { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app';
import type { AppConfig } from '../../src/config/env';
import { startMockSportsApi, type MockSportsApiServer } from '../mock/mockSportsApi';

/* -------------------------------------------------------------------------- */
/* Application harness                                                         */
/* -------------------------------------------------------------------------- */

export interface TestHarness {
  app: FastifyInstance;
  mock: MockSportsApiServer;
  /** Base URL of the running service (only set when `listen: true`). */
  baseUrl: string;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Config overrides layered on top of the fast test defaults. */
  config?: Partial<AppConfig>;
  /** Bind to a real ephemeral port (required for SSE tests). */
  listen?: boolean;
}

/**
 * Boots a mock upstream provider plus a fully wired application instance whose
 * timers are compressed so the suite runs in seconds rather than minutes.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<TestHarness> {
  const mock = await startMockSportsApi();

  const config: Partial<AppConfig> = {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    externalApiUrl: mock.url,
    apiKey: 'test-api-key',
    httpTimeoutMs: 2000,
    logLevel: 'silent',
    pollingIntervalSeconds: 0.1,
    // The production default is 10 requests / 60 seconds (asserted in
    // health.test.ts and exercised in ratelimit.test.ts). Other suites poll far
    // faster than real time, so they raise the ceiling to keep the throttle from
    // masking the behaviour actually under test.
    rateLimitMaxRequests: 1000,
    rateLimitWindowSeconds: 60,
    circuitBreakerFailureThreshold: 3,
    circuitBreakerOpenSeconds: 60,
    sseKeepAliveSeconds: 20,
    ...options.config,
  };

  const app = await buildApp({ config });

  let baseUrl = '';
  if (options.listen) {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  return {
    app,
    mock,
    baseUrl,
    close: async (): Promise<void> => {
      await app.close();
      await mock.stop();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Async helpers                                                               */
/* -------------------------------------------------------------------------- */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `predicate` until it is true or the timeout elapses. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 25, message = 'Condition not met in time' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out: ${message}`);
    }
    await sleep(intervalMs);
  }
}

/* -------------------------------------------------------------------------- */
/* SSE test client                                                             */
/* -------------------------------------------------------------------------- */

export interface ReceivedSseEvent {
  id?: string;
  event: string;
  data: string;
  json<T = Record<string, unknown>>(): T;
}

/**
 * Minimal Server-Sent Events client built on `http.get`, sufficient to assert
 * headers, comments and typed events without pulling in a browser polyfill.
 */
export class SseTestClient {
  private buffer = '';
  private readonly received: ReceivedSseEvent[] = [];
  private readonly comments: string[] = [];
  private readonly listeners = new Set<(event: ReceivedSseEvent) => void>();

  private constructor(
    private readonly request: http.ClientRequest,
    private readonly response: http.IncomingMessage,
  ) {
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => this.consume(chunk));
  }

  static connect(url: string, timeoutMs = 5000): Promise<SseTestClient> {
    return new Promise((resolve, reject) => {
      const request = http.get(url, { headers: { Accept: 'text/event-stream' } }, (response) => {
        clearTimeout(timer);
        resolve(new SseTestClient(request, response));
      });

      const timer = setTimeout(() => {
        request.destroy();
        reject(new Error(`SSE connection to ${url} timed out`));
      }, timeoutMs);

      request.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  get headers(): http.IncomingHttpHeaders {
    return this.response.headers;
  }

  get statusCode(): number {
    return this.response.statusCode ?? 0;
  }

  get events(): ReceivedSseEvent[] {
    return [...this.received];
  }

  get commentLines(): string[] {
    return [...this.comments];
  }

  /** Resolve with the next (or already received) event of the given type. */
  waitForEvent(type: string, timeoutMs = 10_000): Promise<ReceivedSseEvent> {
    const existing = this.received.find((event) => event.event === type);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`Timed out waiting for SSE event "${type}"`));
      }, timeoutMs);

      const listener = (event: ReceivedSseEvent): void => {
        if (event.event !== type) {
          return;
        }
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(event);
      };

      this.listeners.add(listener);
    });
  }

  close(): void {
    this.listeners.clear();
    this.response.destroy();
    this.request.destroy();
  }

  private consume(chunk: string): void {
    this.buffer += chunk;

    let boundary = this.buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      this.parseFrame(frame);
      boundary = this.buffer.indexOf('\n\n');
    }
  }

  private parseFrame(frame: string): void {
    const lines = frame.split('\n').filter((line) => line.length > 0);
    if (lines.length === 0) {
      return;
    }

    let id: string | undefined;
    let eventName: string | undefined;
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith(':')) {
        this.comments.push(line.slice(1).trim());
        continue;
      }
      if (line.startsWith('id:')) {
        id = line.slice(3).trim();
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (!eventName || dataLines.length === 0) {
      return;
    }

    const data = dataLines.join('\n');
    const event: ReceivedSseEvent = {
      ...(id !== undefined ? { id } : {}),
      event: eventName,
      data,
      json: <T = Record<string, unknown>>(): T => JSON.parse(data) as T,
    };

    this.received.push(event);
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}
