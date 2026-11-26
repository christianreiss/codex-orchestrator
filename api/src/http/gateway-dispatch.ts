import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';
import type { createGatewayLifecycle } from './gateway-lifecycle.js';
import { notFoundHandler } from './not-found.js';
import { API_SURFACES, type ApiSurfaceId, type SurfaceRouting } from '../services/api-surfaces.js';
import { resolveRequestSource, type GatewayWiring } from '../services/gateway-backends.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The exact request bytes of a JSON or text/plain body on a gateway
     * surface. The emulated backends read the parsed `req.body`; the upstream
     * forward sends these bytes unchanged, so a client's payload reaches the
     * provider 1:1 and can be replayed to the next key on failover.
     */
    gatewayRawBody?: Buffer;
  }
}

/**
 * Replace the gateway scope's `application/json` and `text/plain` parsers with
 * buffer parsers that keep the raw bytes and then hand them to Fastify's own
 * default parsers. Fastify reads every body as Buffer chunks and decodes it
 * once with `toString('utf8')` before calling a string parser, and an added
 * parser inherits the instance body limit, so content-type matching, the
 * size limit, empty-body and invalid-JSON errors and prototype-poisoning
 * handling stay exactly what the root scope does.
 *
 * Call it on an encapsulated scope (`app.register`), never on the root: the
 * admin API must keep the default parsers.
 */
export function installGatewayBodyCapture(scope: FastifyInstance): void {
  const json = scope.getDefaultJsonParser(
    scope.initialConfig.onProtoPoisoning ?? 'error',
    scope.initialConfig.onConstructorPoisoning ?? 'error',
  );
  scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const raw = body as Buffer;
    req.gatewayRawBody = raw;
    json(req, raw.toString('utf8'), done);
  });
  scope.addContentTypeParser('text/plain', { parseAs: 'buffer' }, (req, body, done) => {
    const raw = body as Buffer;
    req.gatewayRawBody = raw;
    done(null, raw.toString('utf8'));
  });
}

type GatewayRun = ReturnType<typeof createGatewayLifecycle>;
type AsyncHook = (this: FastifyInstance, req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;

export interface GatewayDispatchDeps {
  surface: ApiSurfaceId;
  gateway: GatewayWiring;
  /** The surface's request lifecycle: cancels on client close and on shutdown. */
  run: GatewayRun;
  /** The emulated path's fleet backend-engine check. */
  backendEnabled(req: FastifyRequest): Promise<void>;
}

function upstreamUnavailable(surface: ApiSurfaceId): ApiError {
  return new ApiError(`${API_SURFACES[surface].label} API upstream source is not available on this server`, {
    status: 503,
    code: 'backend_unavailable',
    type: 'api_error',
  });
}

/**
 * The source switch of a gateway route, placed after the kill switch and the
 * key check. Source `upstream`: the request is forwarded to the surface's
 * provider and this hook owns the reply (Fastify skips the remaining hooks
 * and the route handler once the reply is hijacked). Source `emulated`: the
 * route's own handler runs after the backend-engine check. A catch-all route
 * (`catchAll`) has no emulated handler, so it skips that check and answers
 * 404; an unauthenticated catch-all request (see `makeCatchAllKeyHook`) is
 * never forwarded.
 */
export function makeGatewayDispatch(deps: GatewayDispatchDeps, options: { catchAll?: boolean } = {}) {
  return async function gatewayDispatch(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (req.method === 'OPTIONS') return;
    if (options.catchAll && !req.openaiKey && !req.claudeApiKey) return;
    const source = await resolveRequestSource(req, deps.gateway.routing, deps.surface);
    if (source === 'upstream') {
      const upstream = deps.gateway.upstream;
      if (!upstream) throw upstreamUnavailable(deps.surface);
      await deps.run(reply, (signal) => upstream.forward(req, reply, deps.surface, signal));
      return;
    }
    if (!options.catchAll) await deps.backendEnabled(req);
  };
}

/**
 * A blank header is no credential: an edge proxy that copies the client's
 * `Authorization` (Caddy `header_up Authorization {http.request.header.Authorization}`)
 * sends an empty one when the client sent none.
 */
function hasCredential(req: FastifyRequest): boolean {
  const present = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value.some((entry) => entry.trim() !== '') : typeof value === 'string' && value.trim() !== '';
  return present(req.headers.authorization) || present(req.headers['x-api-key']);
}

/**
 * Key check of a catch-all route. An unknown path on an emulated surface
 * keeps answering 404 without a key; a request that carries a credential, or
 * any request while the surface defaults to `upstream`, must authenticate,
 * because a key may pin the request to the upstream source.
 */
export function makeCatchAllKeyHook(resolver: unknown, routing: SurfaceRouting, surface: ApiSurfaceId) {
  const authenticate = resolver as AsyncHook;
  return async function catchAllKey(this: FastifyInstance, req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (req.method === 'OPTIONS') return;
    if (!hasCredential(req) && (routing.sourceFor ? await routing.sourceFor(surface) : 'emulated') !== 'upstream') return;
    await authenticate.call(this, req, reply);
  };
}

/**
 * The scope of the catch-all routes. No body parser runs: the request stream
 * stays untouched for the forward (multipart, binary, any content type), and
 * a bodyless request that still names a content type (Stainless SDKs send
 * `content-type: application/json` on GET) does not fail with 415.
 */
export function installRawBodyPassthrough(scope: FastifyInstance): void {
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser('*', (_req, _payload, done) => done(null, undefined));
}

/** The 404 an emulated catch-all answers with (a hijacked forward never reaches it). */
export const catchAllHandler = notFoundHandler;
