/** Base class for every error the application throws deliberately. */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(message: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Request body / params failed schema validation → HTTP 400. */
export class ValidationError extends AppError {
  constructor(message = 'Invalid request', details?: unknown) {
    super(message, 400, details);
  }
}

/** Resource does not exist → HTTP 404. */
export class NotFoundError extends AppError {
  constructor(message = 'Not Found') {
    super(message, 404);
  }
}

/** The upstream sports API answered with a non-2xx status or unusable payload. */
export class ExternalApiError extends AppError {
  public readonly upstreamStatus?: number;

  constructor(message: string, upstreamStatus?: number) {
    super(message, 502);
    this.upstreamStatus = upstreamStatus;
  }
}

/** Thrown by the circuit breaker while the circuit is OPEN. */
export class CircuitOpenError extends AppError {
  constructor(message = 'Circuit is open') {
    super(message, 503);
  }
}

/** Thrown when a worker is stopped while it waits on a shared resource. */
export class OperationAbortedError extends AppError {
  constructor(message = 'Operation aborted') {
    super(message, 499);
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof OperationAbortedError) {
    return true;
  }
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}
