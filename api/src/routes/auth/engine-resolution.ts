import type { FastifyRequest } from 'fastify';
import { resolveRequestEngine } from '../../util/engine-resolution.js';
import { ENGINE_CODEX, type Engine } from '../../util/engine.js';

/**
 * Engine for an `/auth`-family request.
 *
 * A thin binding over the fleet-wide resolver in `util/engine-resolution.ts` —
 * the rules (explicit hints beat inference, conflicting hints are an error,
 * a malformed hint is never Codex) live there so `/auth`, `/mcp` and every
 * other engine-scoped route cannot drift apart again.
 *
 * The two settings this family needs:
 *  - `legacyUserAgentInference`: deployed `clx` wrappers predate the `X-Engine`
 *    header and identify themselves only in the user-agent.
 *  - `fallback: codex`: an unlabelled request from an older `cdx` is Codex,
 *    which is what the fleet has always done and what those wrappers expect.
 */
export function resolveAuthRequestEngine(
  req: Pick<FastifyRequest, 'query' | 'headers'>,
  payload: Record<string, unknown>,
): Engine {
  return resolveRequestEngine(req, payload, {
    legacyUserAgentInference: true,
    fallback: ENGINE_CODEX,
  });
}
