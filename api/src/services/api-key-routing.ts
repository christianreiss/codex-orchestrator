import { ApiError } from '../http/errors.js';
import type { Database } from '../db/client.js';
import { isEngine, type Engine } from '../util/engine.js';
import { assertFleetEngineEnabledForAdmin } from './engine-switch.js';
import { isApiSource, type ApiSource } from './api-surfaces.js';

/** Omission preserves endpoint routing for existing API clients. */
export async function parseKeyBackend(db: Database, value: unknown): Promise<Engine | null> {
  if (value === undefined) return null;
  if (!isEngine(value)) {
    throw new ApiError('backend_engine must be codex, claude, grok, or kimi', {
      status: 400, code: 'invalid_request', type: 'invalid_request_error', param: 'backend_engine',
    });
  }
  await assertFleetEngineEnabledForAdmin(db, value);
  return value;
}

/** Omitted or null follows the surface's default source; otherwise a pin. */
export function parseKeySource(value: unknown): ApiSource | null {
  if (value === undefined || value === null) return null;
  if (!isApiSource(value)) {
    throw new ApiError('source must be emulated, upstream or null', {
      status: 400, code: 'invalid_request', type: 'invalid_request_error', param: 'source',
    });
  }
  return value;
}
