import { ValidationError } from '../http/errors.js';

export const ENGINE_CODEX = 'codex' as const;
export const ENGINE_CLAUDE = 'claude' as const;
export type Engine = typeof ENGINE_CODEX | typeof ENGINE_CLAUDE;
export const ENGINES: readonly Engine[] = [ENGINE_CODEX, ENGINE_CLAUDE];

export function isEngine(x: unknown): x is Engine {
  return x === ENGINE_CODEX || x === ENGINE_CLAUDE;
}

/**
 * Read a caller-supplied engine value.
 *
 * `fallback` applies to *absence* only — `undefined`, `null`, or an empty
 * string. A value that is present but not an engine is a caller error and is
 * rejected. It used to fall through to `fallback`, which meant `{"engine":
 * "gemini"}` ran against Codex and `{"engine": "clude"}` did too: a typo
 * silently pointed a write at the wrong engine's canonical state.
 *
 * For a value read back out of the database, use `engineFromStoredValue` in
 * `engine-resolution.ts` instead — an unparseable stored column is history, not
 * a request to reject.
 */
export function parseEngine(x: unknown, fallback: Engine = ENGINE_CODEX): Engine {
  if (x === undefined || x === null) return fallback;
  if (typeof x === 'string') {
    const normalized = x.trim().toLowerCase();
    if (normalized === '') return fallback;
    if (isEngine(normalized)) return normalized;
  }
  throw new ValidationError('engine must be "codex" or "claude"', { param: 'engine' });
}
