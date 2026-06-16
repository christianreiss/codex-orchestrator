import { and, desc, eq } from 'drizzle-orm';
import { authPayloads } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { sha256 } from '../security/hash.js';
import { decryptOrNull } from '../security/secret-box.js';
import type { Keyring } from '../security/keyring.js';
import { ValidationError } from '../http/errors.js';
import { isRfc3339 } from '../util/timestamp.js';
import type { Engine } from '../util/engine.js';
import { ENGINE_CODEX, ENGINE_CLAUDE } from '../util/engine.js';

/**
 * Lightweight port of RunnerValidationService. The full PHP service handles
 * runner preflight + backoff + GitHub-release client-version refresh; that
 * preflight logic now lives in a separate worker (out of scope for the
 * host-api worktree). What we keep here:
 *
 *   - resolveCanonicalPayload(engine)   → latest stored payload for the engine
 *   - validateCanonicalPayload(row)     → parses body, checks last_refresh
 *   - canonicalizeAuthPayload(...)      → recomputes canonical JSON + digest
 *   - normalizeAuthEntries(...)         → splits auths{} into row inserts
 *   - calculateDigest(canonicalJson)    → sha256 hex
 *   - ensureAuthsFallback(...)          → synthesise auths from tokens.access_token
 */

export interface CanonicalPayloadRow {
  id: number;
  lastRefresh: string;
  sha256: string;
  body: string | null;
  engine: string;
  createdAt: string;
  verificationState: string;
  verificationCheckedAt: string | null;
}

export interface NormalizedAuthEntry {
  target: string;
  token: string;
  tokenType: string | null;
  organization: string | null;
  project: string | null;
  apiBase: string | null;
  meta: Record<string, unknown> | null;
}

export interface RunnerValidationService {
  resolveCanonicalPayload(engine: Engine): Promise<CanonicalPayloadRow | null>;
  validateCanonicalPayload(row: CanonicalPayloadRow | null):
    | { auth: Record<string, unknown>; digest: string; last_refresh: string }
    | null;
  canonicalAuthFromPayload(row: CanonicalPayloadRow): Record<string, unknown> | null;
  ensureAuthsFallback(payload: Record<string, unknown>, engine: Engine): Record<string, unknown>;
  normalizeAuthEntries(payload: Record<string, unknown>, engine: Engine): NormalizedAuthEntry[];
  canonicalizeAuthPayload(
    payload: Record<string, unknown>,
    entries: NormalizedAuthEntry[],
    lastRefresh: string,
  ): Record<string, unknown>;
  calculateDigest(canonicalJson: string): string;
}

export interface RunnerValidationDeps {
  db: Database;
  keyring?: Keyring;
}

export function createRunnerValidationService(deps: RunnerValidationDeps): RunnerValidationService {
  const { db } = deps;
  return {
    async resolveCanonicalPayload(engine) {
      const verified = await db
        .select()
        .from(authPayloads)
        .where(and(eq(authPayloads.engine, engine), eq(authPayloads.verificationState, 'verified')))
        .orderBy(desc(authPayloads.lastRefresh), desc(authPayloads.id))
        .limit(1);
      let row = verified[0];
      if (!row) {
        const fallback = await db
          .select()
          .from(authPayloads)
          .where(eq(authPayloads.engine, engine))
          .orderBy(desc(authPayloads.lastRefresh), desc(authPayloads.id))
          .limit(1);
        row = fallback[0];
      }
      if (!row) return null;
      return {
        id: row.id,
        lastRefresh: row.lastRefresh,
        sha256: row.sha256,
        body: row.body ?? null,
        engine: row.engine,
        createdAt: row.createdAt,
        verificationState: row.verificationState,
        verificationCheckedAt: row.verificationCheckedAt ?? null,
      };
    },

    validateCanonicalPayload(row) {
      if (!row || !row.body) return null;
      const body = decodePayloadBody(row.body, deps.keyring);
      if (!body) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return null;
      }
      if (!parsed || typeof parsed !== 'object') return null;
      const auth = parsed as Record<string, unknown>;
      const lr = auth.last_refresh;
      if (typeof lr !== 'string' || !isRfc3339(lr)) return null;
      return { auth, digest: row.sha256, last_refresh: lr };
    },

    canonicalAuthFromPayload(row) {
      if (!row.body) return null;
      const body = decodePayloadBody(row.body, deps.keyring);
      if (!body) return null;
      try {
        return JSON.parse(body) as Record<string, unknown>;
      } catch {
        return null;
      }
    },

    ensureAuthsFallback(payload, engine) {
      const out = { ...payload };
      if (out.auths && typeof out.auths === 'object') return out;
      if (engine === ENGINE_CLAUDE) {
        // The Claude.ai OAuth credentials.json (`{claudeAiOauth:{accessToken,…}}`)
        // is what `claude` writes locally and what the seed script / `clx
        // auth-upload` send verbatim. Map the OAuth access token onto the
        // canonical bearer entry so seeding real Claude creds doesn't normalize
        // to an empty auths{} (which then silently stores a useless payload).
        const oauth = (out.claudeAiOauth ?? null) as Record<string, unknown> | null;
        const access =
          oauth && typeof oauth.accessToken === 'string' ? oauth.accessToken.trim() : '';
        if (access) {
          out.auths = { 'api.anthropic.com': { token: access, token_type: 'bearer' } };
        }
        return out;
      }
      if (engine !== ENGINE_CODEX) return out;
      const tokens = (out.tokens ?? {}) as Record<string, unknown>;
      const access = typeof tokens.access_token === 'string' ? tokens.access_token : null;
      const apiKey = typeof out.OPENAI_API_KEY === 'string' ? (out.OPENAI_API_KEY as string) : null;
      const token = access ?? apiKey;
      if (!token) return out;
      out.auths = {
        'api.openai.com': { token, token_type: 'bearer' },
      };
      return out;
    },

    normalizeAuthEntries(payload, _engine) {
      const auths = payload.auths;
      const out: NormalizedAuthEntry[] = [];
      if (!auths || typeof auths !== 'object' || Array.isArray(auths)) return out;
      const entries = Object.entries(auths as Record<string, unknown>);
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      for (const [target, raw] of entries) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        const token = typeof r.token === 'string' ? r.token : '';
        if (!token) continue;
        out.push({
          target,
          token,
          tokenType: typeof r.token_type === 'string' ? r.token_type : 'bearer',
          organization: typeof r.organization === 'string' ? r.organization : null,
          project: typeof r.project === 'string' ? r.project : null,
          apiBase: typeof r.api_base === 'string' ? r.api_base : null,
          meta: extractMeta(r),
        });
      }
      return out;
    },

    canonicalizeAuthPayload(payload, entries, lastRefresh) {
      const canonical: Record<string, unknown> = {
        last_refresh: lastRefresh,
        auths: Object.fromEntries(
          entries.map((e) => [
            e.target,
            removeUndefined({
              token: e.token,
              token_type: e.tokenType ?? undefined,
              organization: e.organization ?? undefined,
              project: e.project ?? undefined,
              api_base: e.apiBase ?? undefined,
              ...(e.meta ?? {}),
            }),
          ]),
        ),
      };
      if (payload.tokens && typeof payload.tokens === 'object') canonical.tokens = payload.tokens;
      if (typeof payload.OPENAI_API_KEY === 'string') canonical.OPENAI_API_KEY = payload.OPENAI_API_KEY;
      // Symmetric to codex's `tokens`: preserve Claude's native account-login
      // object so the canonical payload served to hosts is the real
      // `.credentials.json` shape (accessToken + refreshToken + expiresAt +
      // scopes), not just the derived `auths` bearer. Without this the host
      // could never refresh and Claude Code can't do native account login.
      if (
        payload.claudeAiOauth &&
        typeof payload.claudeAiOauth === 'object' &&
        !Array.isArray(payload.claudeAiOauth)
      ) {
        canonical.claudeAiOauth = payload.claudeAiOauth;
      }
      return canonical;
    },

    calculateDigest(canonicalJson) {
      return sha256(canonicalJson);
    },
  };
}

function decodePayloadBody(body: string, keyring?: Keyring): string | null {
  return keyring ? decryptOrNull(body, keyring) : body;
}

export function extractAuthPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.auth && typeof payload.auth === 'object' && !Array.isArray(payload.auth)) {
    return payload.auth as Record<string, unknown>;
  }
  if (typeof payload.last_refresh === 'string') return payload;
  throw new ValidationError('Auth payload is required', { param: 'auth' });
}

function extractMeta(raw: Record<string, unknown>): Record<string, unknown> | null {
  const reserved = new Set(['token', 'token_type', 'organization', 'project', 'api_base']);
  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!reserved.has(k)) meta[k] = v;
  return Object.keys(meta).length === 0 ? null : meta;
}

function removeUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}
