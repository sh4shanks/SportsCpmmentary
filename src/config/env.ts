import * as dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Raw environment schema.
 *
 * Every value is validated and coerced exactly once, at start-up, so that the
 * rest of the application can depend on a strongly typed `AppConfig` object
 * instead of reaching into `process.env` (which is `string | undefined`).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // HTTP server
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),

  // External sports API
  EXTERNAL_API_URL: z.string().url().default('http://localhost:4000'),
  API_KEY: z.string().default(''),
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  // Polling
  POLLING_INTERVAL_SECONDS: z.coerce.number().positive().default(10),

  // Global rate limiting
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().positive().default(60),

  // Circuit breaker
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  CIRCUIT_BREAKER_OPEN_SECONDS: z.coerce.number().positive().default(60),

  // SSE
  SSE_KEEPALIVE_SECONDS: z.coerce.number().positive().default(20),

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
});

export type LogLevel = z.infer<typeof EnvSchema>['LOG_LEVEL'];

/** Application configuration consumed by every component through DI. */
export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly externalApiUrl: string;
  readonly apiKey: string;
  readonly httpTimeoutMs: number;
  readonly pollingIntervalSeconds: number;
  readonly rateLimitMaxRequests: number;
  readonly rateLimitWindowSeconds: number;
  readonly circuitBreakerFailureThreshold: number;
  readonly circuitBreakerOpenSeconds: number;
  readonly sseKeepAliveSeconds: number;
  readonly logLevel: LogLevel;
}

/**
 * Parse and validate the environment.
 *
 * @param source - environment source (defaults to `process.env`); injectable so
 *                 tests can build a configuration without mutating the process.
 * @throws Error with a human readable list of invalid variables.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;

  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    externalApiUrl: env.EXTERNAL_API_URL.replace(/\/+$/, ''),
    apiKey: env.API_KEY,
    httpTimeoutMs: env.HTTP_TIMEOUT_MS,
    pollingIntervalSeconds: env.POLLING_INTERVAL_SECONDS,
    rateLimitMaxRequests: env.RATE_LIMIT_MAX_REQUESTS,
    rateLimitWindowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
    circuitBreakerFailureThreshold: env.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    circuitBreakerOpenSeconds: env.CIRCUIT_BREAKER_OPEN_SECONDS,
    sseKeepAliveSeconds: env.SSE_KEEPALIVE_SECONDS,
    logLevel: env.LOG_LEVEL,
  });
}

/**
 * Build a configuration object from the environment and apply explicit
 * overrides. Used by the integration test suite to shorten timers.
 */
export function createConfig(
  overrides: Partial<AppConfig> = {},
  source: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return Object.freeze({ ...loadConfig(source), ...overrides });
}
