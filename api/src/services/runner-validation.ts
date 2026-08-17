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
import {
  fingerprintMatches,
  inspectCredential,
  pairFingerprints,
  resolveCodexCredential,
} from './auth-generation.js';

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
  resolvePendingQuarantine?(engine: Engine): Promise<CanonicalPayloadRow | null>;
  validateCanonicalPayload(
    row: CanonicalPayloadRow | null,
  ): { auth: Record<string, unknown>; digest: string; last_refresh: string } | null;
  canonicalAuthFromPayload(row: CanonicalPayloadRow): Record<string, unknown> | null;
  ensureAuthsFallback(payload: Record<string, unknown>, engine: Engine): Record<string, unknown>;
  normalizeAuthEntries(payload: Record<string, unknown>, engine: Engine): NormalizedAuthEntry[];
  hasUsableEngineCredential(payload: Record<string, unknown>, engine: Engine): boolean;
  /**
   * `engine` is required, not inferred. The canonical head is per engine, and
   * guessing it from the credential shape silently filed ambiguous payloads —
   * empty ones, and ones carrying both families — as Codex. Callers that must
   * derive it use `inferCanonicalEngine`, which answers `null` when it cannot
   * tell.
   */
  canonicalizeAuthPayload(
    payload: Record<string, unknown>,
    entries: NormalizedAuthEntry[],
    lastRefresh: string,
    engine: Engine,
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
      const heads = await db.select().from(authCanonicalHeads).where(eq(authCanonicalHeads.engine, engine));
      const head = heads[0];
      if (head) {
        const selected = await db.select().from(authPayloads).where(eq(authPayloads.id, head.payloadId));
        // Once an explicit head exists it is the lineage authority. Returning
        // null for a dangling pointer, or the selected invalid row for callers
        // to fail closed on, prevents silent resurrection of older history.
        return selected[0] ? toCanonicalPayloadRow(selected[0]) : null;
      }
      // RFC3339 values can contain offsets, so VARCHAR ordering is not
      // chronological (`10:30+02:00` is older than `09:00Z`). Resolve by the
      // parsed instant instead. Before explicit heads were introduced, only a
      // verified row was distributable; pending/failed history is quarantine,
      // not an implicit canonical head.
      const rows = await db.select().from(authPayloads).where(eq(authPayloads.engine, engine));
      const ordered = rows.map(toCanonicalPayloadRow).sort(compareCanonicalRowsNewestFirst);
      return (
        ordered.find(
          (row) => row.verificationState === 'verified' && service.validateCanonicalPayload(row) !== null,
        ) ?? null
      );
    },

    async resolvePendingQuarantine(engine) {
      const current = await service.resolveCanonicalPayload(engine);
      const currentGeneration = current?.generation ?? 0;
      const rows = await db.select().from(authPayloads).where(eq(authPayloads.engine, engine));
      const newestQuarantine = rows
        .map(toCanonicalPayloadRow)
        .filter(
          (row) =>
            row.verificationState !== 'verified' &&
            (current === null || (row.generation ?? 0) > currentGeneration) &&
            service.validateCanonicalPayload(row) !== null,
        )
        .sort((a, b) => {
          const generationOrder = (b.generation ?? 0) - (a.generation ?? 0);
          return generationOrder !== 0 ? generationOrder : compareCanonicalRowsNewestFirst(a, b);
        });
      return newestQuarantine[0]?.verificationState === 'pending' ? newestQuarantine[0] : null;
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
      if (row.verificationState !== 'verified') return null;
      const validated = service.validateCanonicalPayload(row);
      if (!validated) return null;
      const engine =
        row.engine === ENGINE_CODEX ? ENGINE_CODEX : row.engine === ENGINE_CLAUDE ? ENGINE_CLAUDE : null;
      if (!engine) return null;

      // Old rows may predate native credential-precedence normalization. They
      // remain distributable only when the native/selected credential is also
      // the exact derived bearer stored in the canonical body, and when its
      // keyed identity still matches the live-verified row metadata.
      if (engine === ENGINE_CODEX && !resolveCodexCredential(validated.auth, { allowLegacy: false })) {
        return null;
      }
      const projected = service.ensureAuthsFallback(validated.auth, engine);
      const normalized = service.canonicalizeAuthPayload(
        projected,
        service.normalizeAuthEntries(projected, engine),
        validated.last_refresh,
        engine,
      );
      // The selected bearer can match while legacy bytes still carry shadow
      // credentials or unrelated auth targets the runner never verified.
      // Serve only the exact projection that was live-probed. The background
      // worker force-verifies and promotes this projection for older rows.
      if (sha256(JSON.stringify(normalized)) !== row.sha256) return null;
      const identity = inspectCredential(validated.auth, engine);
      if (!identity) return null;
      const derivedToken = nativeAuthsToken(validated.auth, engine);
      if (!derivedToken || derivedToken !== identity.access) return null;
      const hasFingerprintMetadata = Boolean(row.pairFingerprint || row.fingerprintKid);
      if (hasFingerprintMetadata) {
        if (!row.pairFingerprint || !row.fingerprintKid || !deps.keyring) return null;
        const candidate = pairFingerprints(identity, deps.keyring).get(row.fingerprintKid);
        if (!fingerprintMatches(row.pairFingerprint, candidate)) return null;
      }
      return validated.auth;
    },

    ensureAuthsFallback(payload, engine) {
      const out = { ...payload };
      const nativeTarget = engine === ENGINE_CLAUDE ? 'api.anthropic.com' : 'api.openai.com';
      const rawAuths = out.auths;
      const hadAuths = isRecord(rawAuths);
      const auths = hadAuths ? { ...rawAuths } : {};
      const nativeEntry = isRecord(auths[nativeTarget]) ? auths[nativeTarget] : null;
      let nativeToken = nativeEntry && typeof nativeEntry.token === 'string' ? nativeEntry.token : '';

      if (engine === ENGINE_CLAUDE) {
        const tokens = isRecord(out.tokens) ? out.tokens : null;
        const oauth = isRecord(out.claudeAiOauth) ? out.claudeAiOauth : null;
        const oauthAccess = typeof oauth?.accessToken === 'string' ? oauth.accessToken : '';
        if (oauthAccess.trim()) {
          if (!isTokenQualityValid(oauthAccess, tokenMinLength)) {
            delete auths[nativeTarget];
            out.auths = auths;
            return out;
          }
          return projectNativeEntry(out, auths, nativeEntry, nativeTarget, oauthAccess);
        }
        // An `oat` bearer is a projection of the native OAuth object, never an
        // independent API key. Without a usable native OAuth access token it
        // cannot authenticate Claude Code or refresh itself.
        if (nativeToken.trim().toLowerCase().startsWith('sk-ant-oat')) {
          delete auths[nativeTarget];
          nativeToken = '';
        }
        const configuredKey = firstConfiguredString(
          out.api_key,
          out.anthropic_api_key,
          out.ANTHROPIC_API_KEY,
          tokens?.anthropic_api_key,
          tokens?.ANTHROPIC_API_KEY,
        );
        if (configuredKey !== null) {
          if (
            configuredKey.toLowerCase().startsWith('sk-ant-oat') ||
            !isTokenQualityValid(configuredKey, tokenMinLength)
          ) {
            delete auths[nativeTarget];
            out.auths = auths;
            return out;
          }
          return projectNativeEntry(out, auths, nativeEntry, nativeTarget, configuredKey);
        }
      } else if (engine === ENGINE_CODEX) {
        const selected = resolveCodexCredential(out);
        if (selected) {
          if (!isTokenQualityValid(selected.access, tokenMinLength)) {
            delete auths[nativeTarget];
            out.auths = auths;
            return out;
          }
          return projectNativeEntry(out, auths, nativeEntry, nativeTarget, selected.access);
        }
        delete auths[nativeTarget];
        nativeToken = '';
      } else {
        return out;
      }

      if (isTokenQualityValid(nativeToken, tokenMinLength)) {
        out.auths = auths;
        return out;
      }

      if (hadAuths) out.auths = auths;
      return out;
    },

    normalizeAuthEntries(payload, engine) {
      const auths = payload.auths;
      const out: NormalizedAuthEntry[] = [];
      if (!auths || typeof auths !== 'object' || Array.isArray(auths)) return out;
      const nativeTarget = engine === ENGINE_CLAUDE ? 'api.anthropic.com' : 'api.openai.com';
      const entries = Object.entries(auths as Record<string, unknown>);
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      for (const [target, raw] of entries) {
        const normalizedTarget = target.trim();
        if (normalizedTarget !== nativeTarget) continue;
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
      return service
        .normalizeAuthEntries(withFallback, engine)
        .some((entry) => entry.target === nativeTarget);
    },

    canonicalizeAuthPayload(payload, entries, lastRefresh, engine) {
      assertCanonicalEngineConsistent(entries, engine);
      const nativeTarget = engine === ENGINE_CLAUDE ? 'api.anthropic.com' : 'api.openai.com';
      const canonical: Record<string, unknown> = {
        last_refresh: lastRefresh,
        auths: Object.fromEntries(
          entries
            .filter((entry) => entry.target === nativeTarget)
            .map((e) => [
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
      if (engine === ENGINE_CODEX) {
        const selected = resolveCodexCredential(payload);
        if (selected?.mode === 'chatgpt') {
          canonical.auth_mode = 'chatgpt';
          const tokens = isRecord(payload.tokens) ? { ...payload.tokens } : {};
          delete tokens.openai_api_key;
          delete tokens.OPENAI_API_KEY;
          canonical.tokens = tokens;
        } else if (selected?.mode === 'apikey') {
          canonical.auth_mode = 'apikey';
          canonical.OPENAI_API_KEY = selected.access.trim();
        }
      } else {
        const selected = inspectCredential(payload, ENGINE_CLAUDE);
        if (selected?.kind === 'claude_oauth') {
          if (
            payload.claudeAiOauth &&
            typeof payload.claudeAiOauth === 'object' &&
            !Array.isArray(payload.claudeAiOauth)
          ) {
            canonical.claudeAiOauth = payload.claudeAiOauth;
          }
        } else if (selected?.kind === 'api_key') {
          canonical.api_key = selected.access;
        }
      }
      if (typeof payload.session_started_at === 'string')
        canonical.session_started_at = payload.session_started_at;
      // Symmetric to codex's `tokens`: preserve Claude's native account-login
      // object so the canonical payload served to hosts is the real
      // `.credentials.json` shape (accessToken + refreshToken + expiresAt +
      // scopes), not just the derived `auths` bearer. Without this the host
      // could never refresh and Claude Code can't do native account login.
      return canonical;
    },

    calculateDigest(canonicalJson) {
      return sha256(canonicalJson);
    },
  };
  return service;
}

function projectNativeEntry(
  payload: Record<string, unknown>,
  auths: Record<string, unknown>,
  nativeEntry: Record<string, unknown> | null,
  nativeTarget: string,
  token: string,
): Record<string, unknown> {
  return {
    ...payload,
    auths: {
      ...auths,
      [nativeTarget]: {
        ...(nativeEntry ?? {}),
        token: token.trim(),
        token_type: nonEmptyString(nativeEntry?.token_type) ?? 'bearer',
      },
    },
  };
}

/**
 * The engine a set of normalized auth entries unambiguously belongs to.
 *
 * `null` means "cannot tell" — no native entry at all, or both families
 * present — and the caller must then require an explicit engine. The previous
 * form was `hasAnthropic && !hasOpenAi ? claude : codex`, so *every* ambiguous
 * case became Codex: an empty payload, a payload holding both an OpenAI and an
 * Anthropic credential, a payload holding neither. A dual-credential upload
 * with no engine was silently filed as Codex, discarding the Anthropic half and
 * stamping the wrong engine's canonical head.
 */
export function inferCanonicalEngine(entries: readonly NormalizedAuthEntry[]): Engine | null {
  const hasAnthropic = entries.some((entry) => entry.target === 'api.anthropic.com');
  const hasOpenAi = entries.some((entry) => entry.target === 'api.openai.com');
  if (hasAnthropic === hasOpenAi) return null;
  return hasAnthropic ? ENGINE_CLAUDE : ENGINE_CODEX;
}

/**
 * Reject an engine that contradicts the credentials it is filed under.
 *
 * A canonical record is single-engine by construction, so an explicit engine
 * that names one family while the entries carry the other is a mislabelled
 * upload, not something to normalize away.
 */
export function assertCanonicalEngineConsistent(
  entries: readonly NormalizedAuthEntry[],
  engine: Engine,
): void {
  const foreignTarget = engine === ENGINE_CLAUDE ? 'api.openai.com' : 'api.anthropic.com';
  if (entries.some((entry) => entry.target === foreignTarget)) {
    throw new ValidationError(
      `canonical payload declared engine ${engine} but carries ${foreignTarget} credentials`,
      { param: 'engine' },
    );
  }
  const inferred = inferCanonicalEngine(entries);
  if (inferred !== null && inferred !== engine) {
    throw new ValidationError(
      `canonical payload declared engine ${engine} but its credentials are ${inferred}`,
      { param: 'engine' },
    );
  }
}

function nativeAuthsToken(payload: Record<string, unknown>, engine: Engine): string {
  const auths = isRecord(payload.auths) ? payload.auths : null;
  const target = engine === ENGINE_CLAUDE ? 'api.anthropic.com' : 'api.openai.com';
  const entry = auths && isRecord(auths[target]) ? auths[target] : null;
  return typeof entry?.token === 'string' ? entry.token.trim() : '';
}

function firstConfiguredString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function resolveTokenMinLength(override?: number): number {
  const configured = override ?? Number(process.env.TOKEN_MIN_LENGTH ?? DEFAULT_TOKEN_MIN_LENGTH);
  if (!Number.isFinite(configured)) return DEFAULT_TOKEN_MIN_LENGTH;
  return Math.max(TOKEN_MIN_LENGTH_FLOOR, Math.trunc(configured));
}

function isReasonableLastRefresh(value: string): boolean {
  const timestamp = parseRfc3339Millis(value);
  return (
    timestamp !== null && timestamp >= MIN_REFRESH_EPOCH_MS && timestamp <= Date.now() + MAX_FUTURE_SKEW_MS
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
