/**
 * The `upstream` source of the gateway surfaces: forward a request 1:1 to the
 * surface's fixed provider with a stored provider API key.
 *
 * `forward()` runs as a preHandler, after the kill switch and the gateway-key
 * check, and owns the reply from the moment it commits an upstream answer
 * (`reply.hijack()`); until then it throws ordinary `ApiError`s that the
 * envelope renders in the surface's wire shape.
 *
 *  1. The provider's fleet engine master switch must be on (503 `api_disabled`,
 *     reason `provider_engine_disabled`). An owner response proof re-checks it,
 *     the surface kill switch and the surface default source on every chunk,
 *     so flipping any of them cuts an open stream.
 *  2. Candidates are the provider's `active`, not-`invalid` keys in failover
 *     order, cooling keys last (503 `upstream_unconfigured` when none).
 *  3. Failover only before the first byte reaches the client, see
 *     `failover.ts`. A buffered body is replayed; a streamed upload gets one
 *     attempt. A header timeout is 504 `upstream_timeout`; a connection lost
 *     after the request may have been sent is 502 `upstream_connection_lost`
 *     (never retried on another key); when every key fails to connect, 502
 *     `upstream_unreachable`.
 *  4. The committed answer streams through unchanged (status, allowed headers,
 *     body bytes; no decompression, no redirects followed). An upstream error
 *     after the headers were sent destroys the client socket.
 *
 * Nothing records tokens or request bodies; key telemetry is `last_used_at` and
 * the `last_error_*` columns only.
 */
import { pipeline } from 'node:stream/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { request, type Dispatcher } from 'undici';
import { addOwnerResponseProof } from '../../control-plane/state/runtime.js';
import type { Database } from '../../db/client.js';
import type { Env } from '../../env.js';
import { ApiError } from '../../http/errors.js';
import type { Keyring } from '../../security/keyring.js';
import { ENGINE_LABELS } from '../../util/engine.js';
import { API_SURFACES, storedSource, surfaceDisabled, type ApiSurfaceId } from '../api-surfaces.js';
import { ENGINE_DISABLED_FLAGS, readFleetEngineState } from '../engine-switch.js';
import { isTruthyFlagValue } from '../settings.js';
import { ProviderApiKeyService, type ProviderKeyCandidate, type ProviderKeyMeta } from '../provider-api-keys.js';
import { isConnectFailure } from './base-url.js';
import { isReplayable, readUpstreamBody, UploadTooLargeError } from './body.js';
import { createUpstreamAgent, upstreamConfigFromEnv, type UpstreamConfig } from './client.js';
import {
  KeyCooldowns,
  UNAUTHORIZED_COOLDOWN_S,
  classifyStatus,
  orderCandidates,
  retryAfterSeconds,
  type StatusClass,
} from './failover.js';
import { clientResponseHeaders, upstreamRequestHeaders } from './headers.js';
import { PROVIDERS } from './providers.js';
import { reasonForStatus, recordProviderKeyError, recordProviderKeyUse } from './telemetry.js';
import { reasonForError, verifyProviderKey } from './verify.js';

type Log = { warn?: (obj: unknown, msg: string) => void };

export interface GatewayUpstream {
  /** Forward one authenticated request; resolves once the reply is finished. */
  forward(req: FastifyRequest, reply: FastifyReply, surface: ApiSurfaceId, signal: AbortSignal): Promise<void>;
  /** Admin verification of one stored key (same guarded agent as the forward). */
  verify(id: number): Promise<ProviderKeyMeta | null>;
  readonly keys: ProviderApiKeyService;
  readonly config: UpstreamConfig;
  close(): Promise<void>;
}

export interface GatewayUpstreamOptions {
  log?: Log;
  config?: UpstreamConfig;
  /**
   * Test seam: a dispatcher in place of the guarded agent. Its connection
   * errors are not marked by the guarded connector, so they never fail over.
   */
  dispatcher?: Dispatcher;
}

/**
 * The path below the surface prefix plus the raw query, forwarded verbatim.
 * Refused with 400, because a proxy behind a custom base URL may normalise
 * them into a path outside the base: dot segments, and a segment whose
 * percent-decoding contains a separator (`%2f`, `%5c`) or does not decode.
 */
export function upstreamPath(rawUrl: string, basePath: string): string {
  if (!rawUrl.startsWith(`${basePath}/`) && !rawUrl.startsWith(`${basePath}?`) && rawUrl !== basePath)
    throw new ApiError('Route not found', { status: 404, code: 'not_found', type: 'not_found_error' });
  const rest = rawUrl.slice(basePath.length);
  const query = rest.indexOf('?');
  const path = query === -1 ? rest : rest.slice(0, query);
  const unsafe = path.includes('\\') || path.split('/').some((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\');
  });
  if (unsafe)
    throw new ApiError('Request path must not contain dot segments or encoded separators', {
      status: 400,
      code: 'invalid_request',
      type: 'invalid_request_error',
    });
  return rest;
}

function isHeadersTimeout(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'UND_ERR_HEADERS_TIMEOUT';
}

function isUploadTooLarge(err: unknown): boolean {
  return err instanceof UploadTooLargeError || (err as { cause?: unknown } | null)?.cause instanceof UploadTooLargeError;
}

export function createGatewayUpstream(
  ctx: { db: Database; keyring: Keyring; env?: Partial<Env> },
  options: GatewayUpstreamOptions = {},
): GatewayUpstream {
  const config = options.config ?? upstreamConfigFromEnv(ctx.env);
  let agent: Dispatcher | null = options.dispatcher ?? null;
  const dispatcher = () => (agent ??= createUpstreamAgent(config));
  const keys = new ProviderApiKeyService({ db: ctx.db, keyring: ctx.keyring, policy: config.policy });
  const cooldowns = new KeyCooldowns();
  const reverifying = new Set<number>();

  /** Background re-check after a 401; only it may mark the key invalid. */
  function reverify(candidate: ProviderKeyCandidate): void {
    if (reverifying.has(candidate.id)) return;
    reverifying.add(candidate.id);
    void (async () => {
      try {
        const result = await verifyProviderKey(dispatcher(), candidate.provider, candidate.baseUrl, candidate.key);
        await keys.recordVerification(candidate, result, { background: true });
      } catch (err) {
        options.log?.warn?.({ provider_key_id: candidate.id, error: (err as Error)?.name ?? 'Error' }, 'provider key re-verification failed');
      } finally {
        reverifying.delete(candidate.id);
      }
    })();
  }

  /** Side effects of a key-specific answer, whether it fails over or is the last word. */
  function noteKeyFailure(candidate: ProviderKeyCandidate, cls: Exclude<StatusClass, 'commit'>, response: Dispatcher.ResponseData): void {
    recordProviderKeyError(ctx.db, candidate.id, reasonForStatus(response.statusCode), response.statusCode);
    if (cls === 'rate_limited') cooldowns.set(candidate.id, retryAfterSeconds(response.headers));
    if (cls === 'unauthorized') {
      cooldowns.set(candidate.id, UNAUTHORIZED_COOLDOWN_S);
      reverify(candidate);
    }
  }

  async function commit(req: FastifyRequest, reply: FastifyReply, response: Dispatcher.ResponseData): Promise<void> {
    const ours = reply.getHeaders();
    const gatewayRequestId = String(ours['x-request-id'] ?? req.id);
    const headers = clientResponseHeaders(response.headers, ours, gatewayRequestId);
    reply.hijack();
    const raw = reply.raw;
    try {
      raw.writeHead(response.statusCode, headers);
      if (req.method === 'HEAD' || response.statusCode === 204 || response.statusCode === 304) {
        await response.body.dump().catch(() => undefined);
        raw.end();
        return;
      }
      await pipeline(response.body, raw);
    } catch {
      // Headers are out: the only honest signal left is a cut connection.
      response.body.destroy();
      if (!raw.destroyed) raw.destroy();
    }
  }

  async function forward(req: FastifyRequest, reply: FastifyReply, surfaceId: ApiSurfaceId, signal: AbortSignal): Promise<void> {
    const surface = API_SURFACES[surfaceId];
    const provider = PROVIDERS[surface.provider];
    if (!(await readFleetEngineState(ctx.db))[provider.engine]) {
      throw new ApiError(
        `${surface.label} API is unavailable: its provider ${provider.label} belongs to the ${ENGINE_LABELS[provider.engine]} engine, which is disabled fleet-wide by the administrator`,
        { status: 503, code: 'api_disabled', type: 'api_error', extra: { reason: 'provider_engine_disabled', engine: provider.engine } },
      );
    }
    const pinned = (req.openaiKey?.source ?? req.claudeApiKey?.source) != null;
    addOwnerResponseProof(`gateway-upstream:${surfaceId}`, (snapshot) => {
      if (surfaceDisabled(surface, snapshot.setting(surface.disabledFlag)))
        throw new ApiError(`${surface.label} API disabled by administrator`, { status: 503, code: 'api_disabled', type: 'api_error' });
      if (isTruthyFlagValue(snapshot.setting(ENGINE_DISABLED_FLAGS[provider.engine])))
        throw new ApiError(`${provider.label} upstream disabled fleet-wide`, { status: 503, code: 'api_disabled', type: 'api_error' });
      if (!pinned && storedSource(snapshot.setting(surface.sourceFlag)) !== 'upstream')
        throw new ApiError(`${surface.label} API source changed`, { status: 503, code: 'backend_unavailable', type: 'api_error' });
    });
    const path = upstreamPath(req.raw.url ?? '', surface.basePath);
    const candidates = orderCandidates(await keys.candidates(provider.id), cooldowns);
    if (candidates.length === 0) {
      throw new ApiError(`No usable ${provider.label} API key is configured for the ${surface.label} API`, {
        status: 503,
        code: 'upstream_unconfigured',
        type: 'api_error',
      });
    }
    const body = await readUpstreamBody(req, config);
    const attempts = isReplayable(body) ? candidates : candidates.slice(0, 1);
    let timedOut = false;
    for (const [index, candidate] of attempts.entries()) {
      const last = index === attempts.length - 1;
      signal.throwIfAborted();
      let response: Dispatcher.ResponseData;
      try {
        response = await request(`${candidate.baseUrl}${path}`, {
          method: req.method as Dispatcher.HttpMethod,
          headers: upstreamRequestHeaders(req.headers, provider.id, candidate.key, {
            contentLength: body.kind === 'stream' ? body.length : null,
          }),
          body: body.kind === 'none' ? undefined : body.kind === 'buffer' ? body.bytes : body.stream,
          dispatcher: dispatcher(),
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw signal.reason ?? err;
        if (isUploadTooLarge(err)) throw new UploadTooLargeError();
        recordProviderKeyError(ctx.db, candidate.id, reasonForError(err), null);
        if (isHeadersTimeout(err)) {
          throw new ApiError(`${provider.label} did not answer in time`, { status: 504, code: 'upstream_timeout', type: 'api_error' });
        }
        // Only a failure to open the connection proves the provider never
        // saw the request. Anything else (a reset, a close, an unparsable
        // answer) may follow a request it already acted on: no other key.
        if (!isConnectFailure(err)) {
          throw new ApiError(`${provider.label} closed the connection before answering`, {
            status: 502,
            code: 'upstream_connection_lost',
            type: 'api_error',
          });
        }
        timedOut ||= reasonForError(err) === 'timeout';
        continue;
      }
      const cls = classifyStatus(response.statusCode);
      if (cls !== 'commit') {
        noteKeyFailure(candidate, cls, response);
        if (!last) {
          await response.body.dump().catch(() => undefined);
          continue;
        }
      } else if (response.statusCode >= 500) {
        recordProviderKeyError(ctx.db, candidate.id, 'upstream_error', response.statusCode);
      } else {
        recordProviderKeyUse(ctx.db, candidate.id);
      }
      if (signal.aborted) {
        response.body.destroy();
        throw signal.reason;
      }
      await commit(req, reply, response);
      return;
    }
    throw new ApiError(`${provider.label} could not be reached with any configured key`, {
      status: 502,
      code: 'upstream_unreachable',
      type: 'api_error',
      extra: timedOut ? { reason: 'timeout' } : undefined,
    });
  }

  return {
    forward,
    keys,
    config,
    async verify(id) {
      const candidate = await keys.secret(id);
      if (!candidate) return null;
      const result = await verifyProviderKey(dispatcher(), candidate.provider, candidate.baseUrl, candidate.key);
      return (await keys.recordVerification(candidate, result)) ?? (await keys.get(id));
    },
    async close() {
      if (agent && !options.dispatcher) await (agent as { close?: () => Promise<void> }).close?.();
      agent = null;
    },
  };
}
