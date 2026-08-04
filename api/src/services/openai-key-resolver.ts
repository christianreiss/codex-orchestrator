import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { ApiError } from '../http/errors.js';
import { ENGINE_CODEX, type Engine } from '../util/engine.js';
import { OpenAiKeyService } from './openai-keys.js';
import type { OpenaiApiKey } from '../db/schema.js';

/**
 * preHandler that authenticates `/v1/*` routes against the
 * `openai_api_keys` table:
 *   1. Pull a bearer token from `Authorization: Bearer <key>` (Bearer-only,
 *      matching OpenAI's public API).
 *   2. Hash it and look it up scoped to the configured engine.
 *   3. Bump `use_count` + `last_used_at` (best-effort).
 *
 * Errors are thrown as OpenAI-shape `ApiError`s — the envelope plugin
 * renders them in the right shape because `/v1/*` is in scope.
 */

const BEARER_RE = /^bearer\s+(\S.*)$/i;

function extractBearer(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers['authorization'];
  const value = Array.isArray(auth) ? auth[0] : auth;
  if (typeof value !== 'string') return null;
  const m = BEARER_RE.exec(value.trim());
  return m && m[1] ? m[1].trim() : null;
}

declare module 'fastify' {
  interface FastifyRequest {
    openaiKey?: OpenaiApiKey;
  }
}

export interface OpenAiKeyResolverDeps {
  keys: OpenAiKeyService;
  engine?: Engine;
}

export function makeOpenAiKeyResolver(
  deps: OpenAiKeyResolverDeps,
): preHandlerHookHandler {
  const engine: Engine = deps.engine ?? ENGINE_CODEX;
  return async function openaiKeyResolver(req: FastifyRequest): Promise<void> {
    if (req.method === 'OPTIONS') return; // CORS preflight bypasses auth

    const token = extractBearer(req.headers as Record<string, string | string[] | undefined>);
    if (!token) {
      // Upstream OpenAI returns type `invalid_request_error` (code
      // `invalid_api_key`) for a missing/bad key — NOT `authentication_error`
      // (that is the Anthropic wire shape). The 401 status is what the SDK
      // classifies on; the type field must still match OpenAI's own vocabulary.
      throw new ApiError('Incorrect API key provided', {
        status: 401,
        code: 'invalid_api_key',
        type: 'invalid_request_error',
      });
    }

    const record = await deps.keys.findActiveByBearer(token, engine);
    if (!record) {
      throw new ApiError('Incorrect API key provided', {
        status: 401,
        code: 'invalid_api_key',
        type: 'invalid_request_error',
      });
    }

    req.openaiKey = record;
    // Fire-and-forget touch; never block the request.
    void deps.keys.touch(record.id);
  };
}
