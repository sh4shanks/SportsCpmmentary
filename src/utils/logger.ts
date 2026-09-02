import type { LogLevel } from '../config/env';

/** Arbitrary structured metadata attached to a log line. */
export type LogMeta = Record<string, unknown>;

/**
 * Logging abstraction. Every component depends on this interface rather than on
 * `console`, which keeps the engine testable and the transport swappable.
 */
export interface ILogger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  /** Returns a logger that automatically merges `bindings` into every line. */
  child(bindings: LogMeta): ILogger;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** Newline-delimited JSON logger – container and log-aggregator friendly. */
export class ConsoleLogger implements ILogger {
  private readonly threshold: number;

  constructor(
    private readonly level: LogLevel = 'info',
    private readonly bindings: LogMeta = {},
    private readonly sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {
    this.threshold = LEVEL_WEIGHT[level];
  }

  debug(message: string, meta?: LogMeta): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: LogMeta): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: LogMeta): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: LogMeta): void {
    this.write('error', message, meta);
  }

  child(bindings: LogMeta): ILogger {
    return new ConsoleLogger(this.level, { ...this.bindings, ...bindings }, this.sink);
  }

  private write(level: Exclude<LogLevel, 'silent'>, message: string, meta?: LogMeta): void {
    if (LEVEL_WEIGHT[level] < this.threshold) {
      return;
    }

    const line = {
      time: new Date().toISOString(),
      level,
      message,
      ...this.bindings,
      ...(meta ?? {}),
    };

    try {
      this.sink(JSON.stringify(line));
    } catch {
      // Never let logging crash the process (e.g. circular metadata).
      this.sink(JSON.stringify({ time: new Date().toISOString(), level, message }));
    }
  }
}

/** No-op logger, handy for unit tests and quiet test runs. */
export class SilentLogger implements ILogger {
  debug(): void {
    /* no-op */
  }

  info(): void {
    /* no-op */
  }

  warn(): void {
    /* no-op */
  }

  error(): void {
    /* no-op */
  }

  child(): ILogger {
    return this;
  }
}

export function createLogger(level: LogLevel): ILogger {
  return level === 'silent' ? new SilentLogger() : new ConsoleLogger(level);
}
