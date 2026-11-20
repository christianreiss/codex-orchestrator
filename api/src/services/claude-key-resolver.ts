/**
 * Anthropic-compatible API-key resolver. Accepts the same three header forms
 * the legacy PHP `ClaudeApiController::authenticate()` honoured:
 *
 *   Authorization: Bearer <key>
 *   x-api-key: <key>              (raw, no prefix — matches Anthropic public API)
 *   Authorization: x-api-key <k>  (legacy curl fallback)
 *
 * Resolves through `OpenAiKeyService.findActiveByBearer` (the lookup every
 * gateway surface shares) to an active `openai_api_keys` row with
 * `engine='claude'`. Bumps `use_count` + `last_used_at` on success, throws
 * Anthropic-shaped authentication_error on miss.
 */
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { ApiError } from '../http/errors.js';
import { ENGINE_CLAUDE as CLAUDE_ENGINE } from '../util/engine.js';
import type { OpenAiKeyService } from './openai-keys.js';

declare module 'fastify' {
  interface FastifyRequest {
    claudeApiKey?: ClaudeApiKeyContext;
  }
}

export interface ClaudeApiKeyContext {
  id: number;
  name: string;
  keyPrefix: string;
  adminUserId: number | null;
  backendEngine?: string | null;
}

export interface ClaudeKeyResolver {
  /** Strict resolver used by `requireClaudeApiKey` below. */
  resolve(req: FastifyRequest): Promise<ClaudeApiKeyContext>;
  /** Fastify preHandler that decorates `req.claudeApiKey`. */
  preHandler: preHandlerHookHandler;
}

/**
 * Parse an Anthropic-style API key header. Returns the raw key value
 * (no scheme prefix) or null when none is present / well-formed.
 *
 * Accepts:
 *   Authorization: Bearer <key>           → <key>
 *   Authorization: x-api-key <key>        → <key>   (legacy)
 *   Authorization: <key>                  → <key>   (legacy bare)
 *   x-api-key: <key>                      → <key>
 */
export function extractAnthropicApiKey(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const auth = headers['authorization'];
  const authValue = Array.isArray(auth) ? auth[0] : auth;
  if (authValue && typeof authValue === 'string') {
    const trimmed = authValue.trim();
    if (trimmed) {
      const lower = trimmed.toLowerCase();
      if (lower.startsWith('bearer ')) {
        const v = trimmed.slice(7).trim();
        if (v) return v;
      }
      if (lower.startsWith('x-api-key ')) {
        const v = trimmed.slice(10).trim();
        if (v) return v;
      }
      // Legacy: bare token in Authorization. Reject obviously-non-key prefixes.
      if (!lower.startsWith('basic ') && !lower.startsWith('digest ')) {
        return trimmed;
      }
    }
  }
  const xk = headers['x-api-key'];
  if (typeof xk === 'string' && xk.trim()) return xk.trim();
  if (Array.isArray(xk) && xk[0]) return xk[0].trim();
  return null;
}

function makeAuthError(message: string, code: string): ApiError {
  return new ApiError(message, {
    status: 401,
    code,
    type: 'authentication_error',
  });
}

export function createClaudeKeyResolver(
  keys: Pick<OpenAiKeyService, 'findActiveByBearer' | 'touch'>,
): ClaudeKeyResolver {
  async function resolve(req: FastifyRequest): Promise<ClaudeApiKeyContext> {
    const raw = extractAnthropicApiKey(
      req.headers as Record<string, string | string[] | undefined>,
    );
    if (!raw) {
      throw makeAuthError(
        'Missing API key. Include it in the Authorization header or x-api-key header.',
        'invalid_api_key',
      );
    }
    // One lookup for every gateway surface: active, unexpired, engine-scoped,
    // and (under the owner) bound to the request principal.
    const row = await keys.findActiveByBearer(raw, CLAUDE_ENGINE);
    if (!row) throw makeAuthError('Invalid or expired API key.', 'invalid_api_key');
    // Best-effort usage bump; never blocks the request.
    await keys.touch(row.id);
    return {
      id: row.id,
      name: row.name,
      keyPrefix: row.keyPrefix,
      adminUserId: row.adminUserId ?? null,
      backendEngine: row.backendEngine ?? null,
    };
  }

  const preHandler: preHandlerHookHandler = async (req) => {
    req.claudeApiKey = await resolve(req);
  };

  return { resolve, preHandler };
}
