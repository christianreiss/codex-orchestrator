/**
 * Anthropic-compatible API-key resolver. Accepts the same three header forms
 * the legacy PHP `ClaudeApiController::authenticate()` honoured:
 *
 *   Authorization: Bearer <key>
 *   x-api-key: <key>              (raw, no prefix — matches Anthropic public API)
 *   Authorization: x-api-key <k>  (legacy curl fallback)
 *
 * Resolves to an active `openai_api_keys` row with `engine='claude'`. Bumps
 * `use_count` + `last_used_at` on success, throws Anthropic-shaped
 * authentication_error on miss.
 */
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { openaiApiKeys } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { ApiError } from '../http/errors.js';
import { sha256 } from '../security/hash.js';
import { nowIso } from '../util/timestamp.js';
import { CLAUDE_ENGINE } from './claude-keys.js';

declare module 'fastify' {
  interface FastifyRequest {
    claudeApiKey?: ClaudeApiKeyContext;
  }
}

export interface ClaudeApiKeyContext {
  id: number;
  name: string;
  keyPrefix: string;
  rateLimitRpm: number;
  adminUserId: number | null;
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

export function createClaudeKeyResolver(db: Database): ClaudeKeyResolver {
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
    const keyHash = sha256(raw);
    const rows = await db
      .select()
      .from(openaiApiKeys)
      .where(and(eq(openaiApiKeys.keyHash, keyHash), eq(openaiApiKeys.engine, CLAUDE_ENGINE)))
      .limit(1);
    const row = rows[0];
    if (!row) throw makeAuthError('Invalid API key.', 'invalid_api_key');
    if (row.isActive !== 1) throw makeAuthError('API key is disabled.', 'invalid_api_key');
    if (row.expiresAt && row.expiresAt < nowIso()) {
      throw makeAuthError('API key has expired.', 'invalid_api_key');
    }

    // Best-effort touch; never block the request on a touch failure.
    try {
      await db
        .update(openaiApiKeys)
        .set({ useCount: row.useCount + 1, lastUsedAt: nowIso(), updatedAt: nowIso() })
        .where(eq(openaiApiKeys.id, row.id));
    } catch {
      /* ignore */
    }

    const ctx: ClaudeApiKeyContext = {
      id: row.id,
      name: row.name,
      keyPrefix: row.keyPrefix,
      rateLimitRpm: row.rateLimitRpm,
      adminUserId: row.adminUserId ?? null,
    };
    return ctx;
  }

  const preHandler: preHandlerHookHandler = async (req) => {
    req.claudeApiKey = await resolve(req);
  };

  return { resolve, preHandler };
}
