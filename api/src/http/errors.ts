/**
 * Domain error hierarchy. Routes throw these (or use reply.ok/fail); the
 * envelope plugin renders them in the right shape based on URL prefix.
 */

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly type: string;
  public readonly param?: string;
  public readonly extra?: Record<string, unknown>;
  public readonly headers?: Record<string, string>;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      type?: string;
      param?: string;
      extra?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.name = this.constructor.name;
    this.status = options.status ?? 400;
    this.code = options.code ?? 'error';
    this.type = options.type ?? 'api_error';
    this.param = options.param;
    this.extra = options.extra;
    this.headers = options.headers;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      message: this.message,
      code: this.code,
      type: this.type,
    };
    if (this.param) out.param = this.param;
    if (this.extra) Object.assign(out, this.extra);
    return out;
  }
}

export class ValidationError extends ApiError {
  constructor(message: string, options: { param?: string; extra?: Record<string, unknown> } = {}) {
    super(message, { status: 422, code: 'validation_failed', type: 'invalid_request_error', ...options });
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Unauthorized', code = 'unauthorized') {
    super(message, { status: 401, code, type: 'authentication_error' });
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = 'Forbidden', code = 'forbidden') {
    super(message, { status: 403, code, type: 'permission_error' });
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'Not found', code = 'not_found') {
    super(message, { status: 404, code, type: 'not_found_error' });
  }
}

export class ConflictError extends ApiError {
  constructor(message = 'Conflict', code = 'conflict', extra?: Record<string, unknown>) {
    super(message, { status: 409, code, type: 'conflict_error', extra });
  }
}

export class RateLimitedError extends ApiError {
  constructor(
    message = 'Rate limited',
    options: { bucket?: string; resetAt?: string; retryAfter?: number } = {},
  ) {
    super(message, {
      status: 429,
      code: 'rate_limited',
      type: 'rate_limit_error',
      extra: { bucket: options.bucket, reset_at: options.resetAt },
      headers: options.retryAfter ? { 'Retry-After': String(options.retryAfter) } : undefined,
    });
  }
}

export class LockedError extends ApiError {
  constructor(message = 'Locked', code = 'locked') {
    super(message, { status: 423, code, type: 'locked_error' });
  }
}

export class ServiceUnavailableError extends ApiError {
  constructor(message = 'Service unavailable', code = 'unavailable') {
    super(message, { status: 503, code, type: 'service_unavailable' });
  }
}
