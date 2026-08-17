import type { FastifyRequest } from 'fastify';
import { ValidationError } from '../http/errors.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, isEngine, type Engine } from './engine.js';

/**
 * One resolver for every engine-scoped route.
 *
 * The rule that matters is the one this file exists to enforce: **a malformed
 * explicit hint is never Codex.** `POST /mcp` with `X-Engine: gemini` used to
 * run the request against Codex — silently, with no error — because the header
 * read was `isEngine(h) ? h : ENGINE_CODEX`. The auth routes already rejected
 * the same input, so the fleet had two different answers to one question.
 *
 * Precedence, and the reasons:
 *  - An explicit hint always wins over inference. Body, query, and header are
 *    equal in rank; two of them disagreeing is a caller bug, not a tie to break
 *    by ordering, so it is a validation error rather than a silent pick.
 *  - With no explicit hint, a route may opt into the legacy `clx` user-agent
 *    inference. That exists because deployed wrappers predate the header, and
 *    it is spelled out per route instead of applied globally.
 *  - With no hint and no inference, `fallback` decides. A route that cannot
 *    safely guess passes none and gets a validation error instead.
 */

export interface EngineHint {
  /** Where the value came from, named as the caller would fix it: `engine`, `X-Engine`. */
  source: string;
  value: unknown;
}

export interface ResolveEngineOptions {
  /**
   * Allow the deployed-wrapper `clx` user-agent to select Claude when no
   * explicit hint is present. Off unless a route documents why it needs it.
   */
  legacyUserAgentInference?: boolean;
  /**
   * Engine to use when nothing else resolves. Omit to require an explicit
   * engine — which is the right choice for a dual-engine host performing an
   * operation whose target cannot be inferred.
   */
  fallback?: Engine;
  /**
   * Engines the target host has enabled. When supplied, a resolved engine
   * outside this set is a validation error, and a single-engine host with no
   * explicit hint resolves to its one engine rather than to `fallback`.
   */
  hostEngines?: readonly Engine[];
}

export function invalidEngineError(source: string): ValidationError {
  return new ValidationError(`${source} must be "codex" or "claude"`, { param: 'engine' });
}

/**
 * Normalize one hint: `null` when absent, an Engine when valid, throw otherwise.
 *
 * "Absent" means the key was not sent at all. `?engine=` with an empty value is
 * a caller that meant to name an engine and failed to, so it is rejected rather
 * than treated as silence — the same reading `/auth` has always had.
 */
export function readEngineHint(hint: EngineHint): Engine | null {
  const { source, value } = hint;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidEngineError(source);
  const normalized = value.trim().toLowerCase();
  if (!isEngine(normalized)) throw invalidEngineError(source);
  return normalized;
}

/**
 * The single engine every explicit hint agrees on, or `null` when none was
 * given. Disagreement is an error: the caller has two intentions and the server
 * must not choose one for it.
 */
export function resolveEngineHints(hints: readonly EngineHint[]): Engine | null {
  let resolved: Engine | null = null;
  let resolvedSource = '';
  for (const hint of hints) {
    const engine = readEngineHint(hint);
    if (engine === null) continue;
    if (resolved !== null && engine !== resolved) {
      throw new ValidationError(
        `conflicting engine hints: ${resolvedSource}=${resolved}, ${hint.source}=${engine}`,
        { param: 'engine' },
      );
    }
    resolved = engine;
    resolvedSource = hint.source;
  }
  return resolved;
}

/** True when the user-agent is a `clx` wrapper rather than `cdx`. */
export function isClaudeUserAgent(userAgent: string | undefined): boolean {
  return /(?:^|[\s(])clx(?:\/|[-_\s;)]|$)/i.test(userAgent ?? '');
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Resolve the engine for one HTTP request from body, query, and `X-Engine`.
 *
 * `payload` is the parsed body (or any object carrying an `engine` field).
 * Nothing here defaults to Codex on bad input; the only paths to a value are an
 * agreed explicit hint, opted-in user-agent inference, a single-engine host, or
 * an explicitly configured `fallback`.
 */
export function resolveRequestEngine(
  req: Pick<FastifyRequest, 'query' | 'headers'>,
  payload: Record<string, unknown> | undefined,
  options: ResolveEngineOptions = {},
): Engine {
  const query = (req.query ?? {}) as Record<string, unknown>;
  const explicit = resolveEngineHints([
    { source: 'engine', value: payload?.engine },
    { source: 'engine', value: query.engine },
    { source: 'X-Engine', value: req.headers['x-engine'] },
  ]);

  if (explicit !== null) {
    assertEngineAllowed(explicit, options.hostEngines);
    return explicit;
  }

  const hostEngines = options.hostEngines;

  // Ahead of the single-engine shortcut: a `clx` user-agent is the wrapper
  // stating which engine it is, which is a signal, not silence. Honouring it
  // and then checking it against the host turns a `clx` wrapper pointed at a
  // Codex-only host into a reported misconfiguration instead of a request
  // quietly served as Codex.
  if (options.legacyUserAgentInference) {
    const inferred = isClaudeUserAgent(firstHeader(req.headers['user-agent']))
      ? ENGINE_CLAUDE
      : ENGINE_CODEX;
    assertEngineAllowed(inferred, hostEngines);
    return inferred;
  }

  if (hostEngines && hostEngines.length === 1) return hostEngines[0] as Engine;

  if (options.fallback !== undefined) {
    assertEngineAllowed(options.fallback, hostEngines);
    return options.fallback;
  }

  throw new ValidationError(
    'engine is required: pass "engine" in the body or query, or the X-Engine header',
    { param: 'engine' },
  );
}

export function assertEngineAllowed(
  engine: Engine,
  hostEngines: readonly Engine[] | undefined,
): void {
  if (!hostEngines || hostEngines.length === 0) return;
  if (hostEngines.includes(engine)) return;
  throw new ValidationError(
    `engine ${engine} is not enabled for this host (enabled: ${hostEngines.join(', ')})`,
    { param: 'engine' },
  );
}

/**
 * The engine recorded on a stored row.
 *
 * Separate from the request path on purpose: a column this build cannot parse
 * is history to read, not a caller to reject, so it degrades to `fallback`
 * rather than failing a request. Never use this for request input.
 */
export function engineFromStoredValue(value: unknown, fallback: Engine = ENGINE_CODEX): Engine {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  return isEngine(normalized) ? normalized : fallback;
}
