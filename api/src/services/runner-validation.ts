import { eq } from 'drizzle-orm';
import { authCanonicalHeads, authPayloads } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { sha256 } from '../security/hash.js';
import { decryptOrNull } from '../security/secret-box.js';
import type { Keyring } from '../security/keyring.js';
import { ValidationError } from '../http/errors.js';
import { compareRfc3339, isRfc3339, parseRfc3339Millis, parseRfc3339Nanos } from '../util/timestamp.js';
import type { Engine } from '../util/engine.js';
import { ENGINE_CODEX, ENGINE_CLAUDE } from '../util/engine.js';

const MIN_REFRESH_EPOCH_MS = Date.UTC(2000, 0, 1);
const MAX_FUTURE_SKEW_MS = 300 * 1000;
const DEFAULT_TOKEN_MIN_LENGTH = 24;
const TOKEN_MIN_LENGTH_FLOOR = 8;

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
  verificationReason?: string | null;
  generation?: number | null;
  fingerprintKid?: string | null;
  pairFingerprint?: string | null;
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
  validateCanonicalPayload(
    row: CanonicalPayloadRow | null,
  ): { auth: Record<string, unknown>; digest: string; last_refresh: string } | null;
  canonicalAuthFromPayload(row: CanonicalPayloadRow): Record<string, unknown> | null;
  ensureAuthsFallback(payload: Record<string, unknown>, engine: Engine): Record<string, unknown>;
  normalizeAuthEntries(payload: Record<string, unknown>, engine: Engine): NormalizedAuthEntry[];
  hasUsableEngineCredential(payload: Record<string, unknown>, engine: Engine): boolean;
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
  /** Test/embedding override; production defaults to TOKEN_MIN_LENGTH or 24. */
  tokenMinLength?: number;
}

export function createRunnerValidationService(deps: RunnerValidationDeps): RunnerValidationService {
  const { db } = deps;
  const tokenMinLength = resolveTokenMinLength(deps.tokenMinLength);
  const service: RunnerValidationService = {
    async resolveCanonicalPayload(engine) {
      const heads = await db
        .select()
        .from(authCanonicalHeads)
        .where(eq(authCanonicalHeads.engine, engine));
      const head = heads[0];
      if (head) {
        const selected = await db
          .select()
          .from(authPayloads)
          .where(eq(authPayloads.id, head.payloadId));
        // Once an explicit head exists it is the lineage authority. Returning
        // null for a dangling pointer, or the selected invalid row for callers
        // to fail closed on, prevents silent resurrection of older history.
        return selected[0] ? toCanonicalPayloadRow(selected[0]) : null;
      }
      // RFC3339 values can contain offsets, so VARCHAR ordering is not
      // chronological (`10:30+02:00` is older than `09:00Z`).  Resolve by the
      // parsed instant instead.  Do not prefer an older `verified` row over a
      // newer `failed`/`pending` row: doing so resurrects rotated credentials
      // after the current lineage has failed.
      const rows = await db.select().from(authPayloads).where(eq(authPayloads.engine, engine));
      const ordered = rows.map(toCanonicalPayloadRow).sort(compareCanonicalRowsNewestFirst);
      // Corrupt rows are not candidates for distribution. Fall back only past
      // structurally corrupt rows; a structurally valid failed row remains the
      // selected canonical and is surfaced as failed by the route layer.
      return ordered.find((row) => service.validateCanonicalPayload(row) !== null) ?? null;
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
      if (!isRfc3339(row.lastRefresh) || compareRfc3339(lr, row.lastRefresh) !== 0) return null;
      if (!isReasonableLastRefresh(lr)) return null;
      if (sha256(body) !== row.sha256) return null;
      const engine =
        row.engine === ENGINE_CLAUDE ? ENGINE_CLAUDE : row.engine === ENGINE_CODEX ? ENGINE_CODEX : null;
      if (!engine) return null;
      const withFallback = service.ensureAuthsFallback(auth, engine);
      if (!service.hasUsableEngineCredential(withFallback, engine)) return null;
      return { auth, digest: row.sha256, last_refresh: lr };
    },

    canonicalAuthFromPayload(row) {
      if (row.verificationState === 'failed') return null;
      return service.validateCanonicalPayload(row)?.auth ?? null;
    },

    ensureAuthsFallback(payload, engine) {
      const out = { ...payload };
      const nativeTarget = engine === ENGINE_CLAUDE ? 'api.anthropic.com' : 'api.openai.com';
      const rawAuths = out.auths;
      const hadAuths = isRecord(rawAuths);
      const auths = hadAuths ? { ...rawAuths } : {};
      const nativeEntry = isRecord(auths[nativeTarget]) ? auths[nativeTarget] : null;
      const nativeToken = nativeEntry && typeof nativeEntry.token === 'string' ? nativeEntry.token : '';
      if (isTokenQualityValid(nativeToken, tokenMinLength)) {
        out.auths = auths;
        return out;
      }

      const candidates: unknown[] = [];
      if (engine === ENGINE_CLAUDE) {
        candidates.push(out.api_key, out.anthropic_api_key, out.ANTHROPIC_API_KEY);
        const tokens = isRecord(out.tokens) ? out.tokens : null;
        candidates.push(tokens?.anthropic_api_key, tokens?.ANTHROPIC_API_KEY);
        const oauth = isRecord(out.claudeAiOauth) ? out.claudeAiOauth : null;
        candidates.push(oauth?.accessToken);
      } else if (engine === ENGINE_CODEX) {
        const tokens = isRecord(out.tokens) ? out.tokens : null;
        candidates.push(tokens?.access_token, tokens?.openai_api_key, out.OPENAI_API_KEY);
      } else {
        return out;
      }

      const token = candidates.find(
        (candidate): candidate is string =>
          typeof candidate === 'string' && isTokenQualityValid(candidate, tokenMinLength),
      );
      if (!token) {
        if (hadAuths) out.auths = auths;
        return out;
      }
      out.auths = {
        ...auths,
        [nativeTarget]: { token: token.trim(), token_type: 'bearer' },
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
        const normalizedTarget = target.trim();
        if (!normalizedTarget) continue;
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        const token = typeof r.token === 'string' ? r.token.trim() : '';
        if (!isTokenQualityValid(typeof r.token === 'string' ? r.token : '', tokenMinLength)) continue;
        out.push({
          target: normalizedTarget,
          token,
          tokenType: nonEmptyString(r.token_type) ?? nonEmptyString(r.type) ?? 'bearer',
          organization:
            nonEmptyString(r.organization) ??
            nonEmptyString(r.org) ??
            nonEmptyString(r.default_organization) ??
            nonEmptyString(r.default_org),
          project: nonEmptyString(r.project) ?? nonEmptyString(r.default_project),
          apiBase: nonEmptyString(r.api_base) ?? nonEmptyString(r.base_url),
          meta: extractMeta(r),
        });
      }
      return out;
    },

    hasUsableEngineCredential(payload, engine) {
      const withFallback = service.ensureAuthsFallback(payload, engine);
      const nativeTarget = engine === ENGINE_CLAUDE ? 'api.anthropic.com' : 'api.openai.com';
      return service.normalizeAuthEntries(withFallback, engine).some((entry) => entry.target === nativeTarget);
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
      for (const key of ['api_key', 'anthropic_api_key', 'ANTHROPIC_API_KEY'] as const) {
        if (typeof payload[key] === 'string') canonical[key] = payload[key];
      }
      if (typeof payload.session_started_at === 'string') canonical.session_started_at = payload.session_started_at;
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
  return service;
}

function resolveTokenMinLength(override?: number): number {
  const configured = override ?? Number(process.env.TOKEN_MIN_LENGTH ?? DEFAULT_TOKEN_MIN_LENGTH);
  if (!Number.isFinite(configured)) return DEFAULT_TOKEN_MIN_LENGTH;
  return Math.max(TOKEN_MIN_LENGTH_FLOOR, Math.trunc(configured));
}

function isReasonableLastRefresh(value: string): boolean {
  const timestamp = parseRfc3339Millis(value);
  return (
    timestamp !== null &&
    timestamp >= MIN_REFRESH_EPOCH_MS &&
    timestamp <= Date.now() + MAX_FUTURE_SKEW_MS
  );
}

function isTokenQualityValid(rawToken: string, minLength: number): boolean {
  if (!rawToken || rawToken !== rawToken.trim() || /\s/.test(rawToken)) return false;
  if (rawToken.length < minLength) return false;
  const lower = rawToken.toLowerCase();
  if (
    new Set([
      'token',
      'newer-token',
      'placeholder',
      'changeme',
      'dummy',
      'test',
      'example',
      'example-token',
    ]).has(lower)
  ) {
    return false;
  }
  if (/^(.)\1+$/.test(rawToken)) return false;
  return new Set(rawToken).size >= 6;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toCanonicalPayloadRow(row: typeof authPayloads.$inferSelect): CanonicalPayloadRow {
  return {
    id: row.id,
    lastRefresh: row.lastRefresh,
    sha256: row.sha256,
    body: row.body ?? null,
    engine: row.engine,
    createdAt: row.createdAt,
    verificationState: row.verificationState,
    verificationCheckedAt: row.verificationCheckedAt ?? null,
    verificationReason: row.verificationReason ?? null,
    generation: row.generation ?? null,
    fingerprintKid: row.fingerprintKid ?? null,
    pairFingerprint: row.pairFingerprint ?? null,
  };
}

function compareCanonicalRowsNewestFirst(a: CanonicalPayloadRow, b: CanonicalPayloadRow): number {
  const aNanos = parseRfc3339Nanos(a.lastRefresh);
  const bNanos = parseRfc3339Nanos(b.lastRefresh);
  if (aNanos !== null && bNanos !== null && aNanos !== bNanos) return aNanos < bNanos ? 1 : -1;
  if (aNanos === null && bNanos !== null) return 1;
  if (aNanos !== null && bNanos === null) return -1;
  return b.id - a.id;
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
  const reserved = new Set([
    'token',
    'token_type',
    'type',
    'organization',
    'org',
    'default_organization',
    'default_org',
    'project',
    'default_project',
    'api_base',
    'base_url',
  ]);
  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!reserved.has(k)) meta[k] = v;
  return Object.keys(meta).length === 0 ? null : meta;
}

function removeUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}
