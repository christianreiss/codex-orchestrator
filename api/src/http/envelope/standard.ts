import type { ApiError } from '../errors.js';

export interface StandardSuccess<T = unknown> {
  status: 'ok';
  data?: T;
  [key: string]: unknown;
}

export interface StandardError {
  status: 'error';
  message: string;
  code?: string;
  bucket?: string;
  reset_at?: string;
  [key: string]: unknown;
}

export function success<T>(data: T): StandardSuccess<T> {
  if (data === null || data === undefined) return { status: 'ok' };
  if (typeof data === 'object' && !Array.isArray(data) && data !== null) {
    const obj = data as Record<string, unknown>;
    if ('data' in obj) {
      if ('status' in obj && obj.status === 'ok') return obj as StandardSuccess<T>;
      return { status: 'ok', ...obj } as StandardSuccess<T>;
    }
    // Keep object fields at the root for the rewritten clients, but also
    // preserve the legacy `{status:"ok",data:{...}}` envelope shape consumed
    // by still-installed bash wrappers.
    return { status: 'ok', data: obj, ...obj } as StandardSuccess<T>;
  }
  return { status: 'ok', data };
}

export function failure(err: ApiError): StandardError {
  const out: StandardError = {
    status: 'error',
    message: err.message,
    code: err.code,
  };
  if (err.extra) {
    for (const [k, v] of Object.entries(err.extra)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}
