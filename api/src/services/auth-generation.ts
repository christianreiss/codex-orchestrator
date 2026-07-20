import { createHmac, timingSafeEqual } from 'node:crypto';
import type { KeyEntry, Keyring } from '../security/keyring.js';
import type { Engine } from '../util/engine.js';
import { ENGINE_CLAUDE } from '../util/engine.js';

export type CredentialKind = 'codex_oauth' | 'claude_oauth' | 'api_key';

export interface CredentialIdentity {
  kind: CredentialKind;
  access: string;
  refresh: string;
  issuedAt: string | null;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
}

export interface CredentialMetadata {
  credentialKind: CredentialKind;
  fingerprintKid: string;
  accessFingerprint: string;
  refreshFingerprint: string | null;
  pairFingerprint: string;
  credentialIssuedAt: string | null;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
}

export function inspectCredential(auth: Record<string, unknown>, engine: Engine): CredentialIdentity | null {
  if (engine === ENGINE_CLAUDE) {
    const oauth = record(auth.claudeAiOauth);
    const access = text(oauth?.accessToken);
    if (access) {
      return {
        kind: 'claude_oauth',
        access,
        refresh: text(oauth?.refreshToken),
        issuedAt: null,
        accessExpiresAt: epochMillisIso(oauth?.expiresAt),
        refreshExpiresAt: epochMillisIso(oauth?.refreshTokenExpiresAt),
      };
    }
  } else {
    const tokens = record(auth.tokens);
    const access = text(tokens?.access_token);
    if (access) {
      const claims = jwtClaims(access);
      return {
        kind: 'codex_oauth',
        access,
        refresh: text(tokens?.refresh_token),
        issuedAt: epochSecondsIso(claims?.iat),
        accessExpiresAt: epochSecondsIso(claims?.exp),
        refreshExpiresAt: null,
      };
    }
  }

  const access = engine === ENGINE_CLAUDE ? anthropicKey(auth) : openAiKey(auth);
  if (!access) return null;
  return {
    kind: 'api_key',
    access,
    refresh: '',
    issuedAt: null,
    accessExpiresAt: null,
    refreshExpiresAt: null,
  };
}

export function credentialMetadata(identity: CredentialIdentity, key: KeyEntry): CredentialMetadata {
  return {
    credentialKind: identity.kind,
    fingerprintKid: key.kid,
    accessFingerprint: fingerprint(key, 'access', identity.kind, identity.access),
    refreshFingerprint: identity.refresh
      ? fingerprint(key, 'refresh', identity.kind, identity.refresh)
      : null,
    pairFingerprint: fingerprint(key, 'pair', identity.kind, identity.access, identity.refresh),
    credentialIssuedAt: identity.issuedAt,
    accessExpiresAt: identity.accessExpiresAt,
    refreshExpiresAt: identity.refreshExpiresAt,
  };
}

export function pairFingerprints(identity: CredentialIdentity, keyring: Keyring): Map<string, string> {
  return new Map(
    keyring.all().map((key) => [key.kid, fingerprint(key, 'pair', identity.kind, identity.access, identity.refresh)]),
  );
}

export function fingerprintMatches(stored: string | null | undefined, candidate: string | undefined): boolean {
  if (!stored || !candidate || !/^[a-f0-9]{64}$/i.test(stored) || !/^[a-f0-9]{64}$/i.test(candidate)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(candidate, 'hex'));
}

// Internal provider time is an admission gate, never proof: a candidate still
// needs live runner verification. Claude exposes expiry directly; Codex access
// JWTs expose issue/expiry claims. Missing data is intentionally incomparable.
export function compareCredentialFreshness(candidate: CredentialIdentity, current: CredentialIdentity): number | null {
  if (candidate.kind !== current.kind || candidate.kind === 'api_key') return null;
  if (candidate.kind === 'claude_oauth') {
    return compareTuple(
      [candidate.accessExpiresAt, candidate.refreshExpiresAt],
      [current.accessExpiresAt, current.refreshExpiresAt],
    );
  }
  return compareTuple(
    [candidate.issuedAt, candidate.accessExpiresAt],
    [current.issuedAt, current.accessExpiresAt],
  );
}

export function refreshCredentialExpired(identity: CredentialIdentity, now = Date.now()): boolean {
  if (!identity.refreshExpiresAt) return false;
  const expiry = Date.parse(identity.refreshExpiresAt);
  return Number.isFinite(expiry) && expiry <= now;
}

function compareTuple(a: Array<string | null>, b: Array<string | null>): number | null {
  if (!a[0] || !b[0]) return null;
  for (let i = 0; i < a.length; i += 1) {
    if (!a[i] || !b[i]) continue;
    const av = Date.parse(a[i]!);
    const bv = Date.parse(b[i]!);
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return null;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

function fingerprint(key: KeyEntry, component: string, kind: string, ...values: string[]): string {
  const framed = JSON.stringify(['auth-generation-v1', component, kind, ...values]);
  return createHmac('sha256', Buffer.from(key.key)).update(framed).digest('hex');
}

function jwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return record(parsed);
  } catch {
    return null;
  }
}

function epochSecondsIso(value: unknown): string | null {
  return typeof value === 'number' ? epochMillisIso(value * 1000) : null;
}

function epochMillisIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const min = Date.UTC(2000, 0, 1);
  const max = Date.UTC(2200, 0, 1);
  if (value < min || value > max) return null;
  return new Date(value).toISOString();
}

function anthropicKey(auth: Record<string, unknown>): string {
  const auths = record(auth.auths);
  const entry = record(auths?.['api.anthropic.com']);
  const tokens = record(auth.tokens);
  return firstText(entry?.token, auth.api_key, auth.anthropic_api_key, auth.ANTHROPIC_API_KEY, tokens?.anthropic_api_key);
}

function openAiKey(auth: Record<string, unknown>): string {
  const auths = record(auth.auths);
  const entry = record(auths?.['api.openai.com']);
  return firstText(entry?.token, auth.OPENAI_API_KEY);
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return '';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
