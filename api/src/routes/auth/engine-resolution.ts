import type { FastifyRequest } from 'fastify';
import { ValidationError } from '../../http/errors.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, isEngine, type Engine } from '../../util/engine.js';

/** Resolve the engine without silently defaulting an invalid explicit hint. */
export function resolveAuthRequestEngine(
  req: Pick<FastifyRequest, 'query' | 'headers'>,
  payload: Record<string, unknown>,
): Engine {
  const query = (req.query ?? {}) as Record<string, unknown>;
  for (const candidate of [payload.engine, query.engine, req.headers['x-engine']]) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate !== 'string') throw invalidEngine();
    const normalized = candidate.trim().toLowerCase();
    if (!isEngine(normalized)) throw invalidEngine();
    return normalized;
  }
  const userAgent = firstHeader(req.headers['user-agent']) ?? '';
  return /(?:^|[\s(])clx(?:\/|[-_\s;)]|$)/i.test(userAgent) ? ENGINE_CLAUDE : ENGINE_CODEX;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function invalidEngine(): ValidationError {
  return new ValidationError('engine must be "codex" or "claude"', { param: 'engine' });
}
