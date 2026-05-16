import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { versions } from '../db/schema.js';
import type { Keyring } from '../security/keyring.js';
import { encrypt, decrypt, isEnvelope } from '../security/secret-box.js';
import { nowIso } from '../util/timestamp.js';

/**
 * Joplin configuration is persisted as a single JSON blob in the `versions`
 * table under the key `joplin_config`. The blob holds the URL plus the
 * connection credentials (the upstream Joplin Server takes email + password,
 * but the public contract treats those as opaque secrets — they are encrypted
 * with sbox:v1 and never leave this module in plaintext on the wire).
 */

export const JOPLIN_CONFIG_KEY = 'joplin_config';

export interface JoplinConfig {
  url: string;
  email: string;
  password: string;
  enabled: boolean;
  syncIntervalMinutes: number;
  verifiedAt: string | null;
  verifiedFingerprint: string | null;
}

export const EMPTY_CONFIG: JoplinConfig = {
  url: '',
  email: '',
  password: '',
  enabled: false,
  syncIntervalMinutes: 15,
  verifiedAt: null,
  verifiedFingerprint: null,
};

interface StoredBlob {
  url?: string;
  email?: string;
  password?: string;
  enabled?: boolean;
  sync_interval_minutes?: number;
  verified_at?: string | null;
  verified_fingerprint?: string | null;
}

function normaliseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function fromStored(blob: StoredBlob): JoplinConfig {
  return {
    url: normaliseUrl(String(blob.url ?? '')),
    email: String(blob.email ?? '').trim(),
    password: String(blob.password ?? ''),
    enabled: Boolean(blob.enabled),
    syncIntervalMinutes:
      typeof blob.sync_interval_minutes === 'number' && blob.sync_interval_minutes >= 1
        ? Math.min(1440, Math.floor(blob.sync_interval_minutes))
        : 15,
    verifiedAt: blob.verified_at ?? null,
    verifiedFingerprint: blob.verified_fingerprint ?? null,
  };
}

function toStored(config: JoplinConfig): StoredBlob {
  return {
    url: normaliseUrl(config.url),
    email: config.email.trim(),
    password: config.password,
    enabled: config.enabled,
    sync_interval_minutes: config.syncIntervalMinutes,
    verified_at: config.verifiedAt,
    verified_fingerprint: config.verifiedFingerprint,
  };
}

/** Read the Joplin config, decrypting if necessary. Empty config if missing. */
export async function readJoplinConfig(db: Database, keyring: Keyring): Promise<JoplinConfig> {
  const rows = await db
    .select({ version: versions.version })
    .from(versions)
    .where(eq(versions.name, JOPLIN_CONFIG_KEY))
    .limit(1);
  const raw = rows[0]?.version;
  if (!raw) return { ...EMPTY_CONFIG };
  let plaintext: string;
  try {
    plaintext = isEnvelope(raw) ? decrypt(raw, keyring) : raw;
  } catch {
    return { ...EMPTY_CONFIG };
  }
  let parsed: StoredBlob;
  try {
    parsed = JSON.parse(plaintext) as StoredBlob;
  } catch {
    return { ...EMPTY_CONFIG };
  }
  return fromStored(parsed);
}

/** Encrypt and persist the config. Replaces any prior row. */
export async function writeJoplinConfig(
  db: Database,
  keyring: Keyring,
  config: JoplinConfig,
): Promise<void> {
  const payload = JSON.stringify(toStored(config));
  const enc = encrypt(payload, keyring);
  const updatedAt = nowIso();
  await db
    .insert(versions)
    .values({ name: JOPLIN_CONFIG_KEY, version: enc, updatedAt })
    .onDuplicateKeyUpdate({ set: { version: enc, updatedAt } });
}

/** Stable fingerprint used to decide if a stored verification still applies. */
export function fingerprint(config: Pick<JoplinConfig, 'url' | 'email' | 'password'>): string | null {
  const url = normaliseUrl(config.url);
  const email = config.email.trim();
  if (!url || !email || !config.password) return null;
  // sha256 to keep parity with the PHP legacy fingerprint shape
  const enc = new TextEncoder();
  const buf = enc.encode(url + '\n' + email + '\n' + config.password);
  return hashHex(buf);
}

function hashHex(buf: Uint8Array): string {
  // Pure-Node sha256 via webcrypto subtle is async; the PHP fingerprint is a
  // synchronous helper, so we keep the same here using node:crypto.
  // Lazily required to keep this file ESM-friendly under tests.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(buf).digest('hex');
}

/** Mask a secret for display. Returns "" for empty, otherwise "…last4". */
export function maskSecret(value: string): string {
  const v = value.trim();
  if (!v) return '';
  if (v.length <= 4) return '****';
  return '…' + v.slice(-4);
}

/** Public-facing shape (token never returned in plaintext). */
export interface JoplinConfigStateDto {
  enabled: boolean;
  url: string;
  email: string;
  password_set: boolean;
  password_hint: string;
  sync_interval_minutes: number;
  config_complete: boolean;
  verified_connection: boolean;
  verified_at: string | null;
  can_activate: boolean;
  activation_reason: string;
}

export function toDto(config: JoplinConfig): JoplinConfigStateDto {
  const url = normaliseUrl(config.url);
  const email = config.email.trim();
  const passwordSet = config.password.trim() !== '';
  const intervalValid = config.syncIntervalMinutes >= 1 && config.syncIntervalMinutes <= 1440;
  const configComplete = url !== '' && email !== '' && passwordSet && intervalValid;
  const expected = fingerprint(config);
  const verifiedConnection =
    configComplete &&
    expected !== null &&
    config.verifiedFingerprint !== null &&
    expected === config.verifiedFingerprint;

  let reason = 'ready';
  if (!url) reason = 'missing_url';
  else if (!email) reason = 'missing_email';
  else if (!passwordSet) reason = 'missing_password';
  else if (!intervalValid) reason = 'invalid_interval';
  else if (!verifiedConnection) reason = 'verification_required';

  return {
    enabled: config.enabled,
    url,
    email,
    password_set: passwordSet,
    password_hint: maskSecret(config.password),
    sync_interval_minutes: config.syncIntervalMinutes,
    config_complete: configComplete,
    verified_connection: verifiedConnection,
    verified_at: verifiedConnection ? config.verifiedAt : null,
    can_activate: reason === 'ready',
    activation_reason: reason,
  };
}
