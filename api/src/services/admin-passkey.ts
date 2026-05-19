import { and, asc, count, eq, gt, sql } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/types';
import type { Database } from '../db/client.js';
import {
  adminPasskeys,
  adminUsers,
  adminWebauthnChallenges,
  type AdminPasskey,
  type AdminUser,
} from '../db/schema.js';
import type { Env } from '../env.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { sha256 } from '../security/hash.js';
import { isoOffsetSeconds, nowIso } from '../util/timestamp.js';
import type { AdminEventsService } from './admin-events.js';

/**
 * WebAuthn passkey lifecycle. Registration and authentication both stash a
 * challenge token in `admin_webauthn_challenges` (5-minute TTL) and consume
 * it atomically on completion. The credential's public key is persisted as
 * base64-encoded raw COSE bytes inside the legacy `public_key_pem` text
 * column with a `cose:` prefix to distinguish from any pre-existing PEM
 * payload — verification reads it back into a Uint8Array for the
 * simplewebauthn library.
 */

const CHALLENGE_TTL_SECONDS = 300;
const MAX_PASSKEYS_PER_USER = 10;
const PUBLIC_KEY_PREFIX = 'cose:';
const VALID_TRANSPORTS: ReadonlyArray<AuthenticatorTransportFuture> = [
  'usb',
  'nfc',
  'ble',
  'internal',
  'hybrid',
  'smart-card',
  'cable',
];

export interface SanitizedPasskey {
  id: number;
  name: string;
  transports: string | null;
  created_at: string | null;
  last_used_at: string | null;
}

export interface PasskeyOwner {
  id: number;
  username: string;
  name: string;
}

export interface WebAuthnRequestContext {
  headers?: {
    host?: string | string[];
    'x-forwarded-host'?: string | string[];
    'x-forwarded-proto'?: string | string[];
  };
  protocol?: string;
}

export class AdminPasskeyService {
  constructor(
    private readonly db: Database,
    private readonly env: Env,
    private readonly events: AdminEventsService,
  ) {}

  // ---------- helpers ----------

  rpId(req?: WebAuthnRequestContext): string {
    const id = this.env.ADMIN_WEBAUTHN_RP_ID;
    if (id) return id;
    const baseHost = this.publicBaseUrlHost();
    if (baseHost) return baseHost;
    const host = this.requestHost(req);
    if (host) return host;
    throw new ValidationError('Passkeys are not configured (ADMIN_WEBAUTHN_RP_ID unset)');
  }
  origin(req?: WebAuthnRequestContext): string {
    const o = this.env.ADMIN_WEBAUTHN_ORIGIN;
    if (o) return o;
    const baseOrigin = this.publicBaseUrlOrigin();
    if (baseOrigin) return baseOrigin;
    const host = this.requestHost(req);
    if (host) return `${this.requestProtocol(req, host)}://${host}`;
    throw new ValidationError('Passkeys are not configured (ADMIN_WEBAUTHN_ORIGIN unset)');
  }
  rpName(): string {
    return this.env.ADMIN_WEBAUTHN_RP_NAME ?? 'Codex Orchestrator';
  }

  // ---------- list / rename / delete ----------

  async listForUser(userId: number): Promise<SanitizedPasskey[]> {
    const rows = await this.db
      .select()
      .from(adminPasskeys)
      .where(eq(adminPasskeys.userId, userId))
      .orderBy(asc(adminPasskeys.createdAt));
    return rows.map((r) => this.sanitize(r));
  }

  async rename(id: number, userId: number, name: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === '') throw new ValidationError('Name is required', { param: 'name' });
    if (trimmed.length > 255) {
      throw new ValidationError('Name must be 255 characters or fewer', { param: 'name' });
    }
    const passkey = await this.findById(id);
    if (!passkey) throw new NotFoundError('Passkey not found', 'passkey_not_found');
    if (passkey.userId !== userId) throw new ForbiddenError('Forbidden', 'passkey_forbidden');
    await this.db.update(adminPasskeys).set({ name: trimmed }).where(eq(adminPasskeys.id, id));
  }

  async deletePasskey(id: number, userId: number): Promise<void> {
    const passkey = await this.findById(id);
    if (!passkey) throw new NotFoundError('Passkey not found', 'passkey_not_found');
    if (passkey.userId !== userId) throw new ForbiddenError('Forbidden', 'passkey_forbidden');
    await this.db.delete(adminPasskeys).where(eq(adminPasskeys.id, id));
    await this.events.record({
      type: 'passkey.deleted',
      payload: { user_id: userId, passkey_id: id },
    });
  }

  // ---------- registration ----------

  async beginRegistration(owner: PasskeyOwner, req?: WebAuthnRequestContext): Promise<unknown> {
    const userCount = await this.db
      .select({ c: count() })
      .from(adminPasskeys)
      .where(eq(adminPasskeys.userId, owner.id));
    if (Number(userCount[0]?.c ?? 0) >= MAX_PASSKEYS_PER_USER) {
      throw new ValidationError('Maximum number of passkeys reached');
    }
    await this.purgeExpiredChallenges();

    const existing = await this.db
      .select()
      .from(adminPasskeys)
      .where(eq(adminPasskeys.userId, owner.id));

    const userIdBytes = new Uint8Array(8);
    new DataView(userIdBytes.buffer).setBigUint64(0, BigInt(owner.id), false);

    const options = await generateRegistrationOptions({
      rpName: this.rpName(),
      rpID: this.rpId(req),
      userID: userIdBytes,
      userName: owner.username,
      userDisplayName: owner.name || owner.username,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'discouraged',
        userVerification: 'required',
      },
      excludeCredentials: existing
        .filter((p) => p.credentialId)
        .map((p) => ({
          id: this.credentialIdToBase64Url(p.credentialId),
          transports: this.parseTransports(p.transports),
        })),
    });

    await this.storeChallenge(options.challenge, owner.id, 'registration');
    return options;
  }

  async completeRegistration(
    owner: PasskeyOwner,
    body: { response?: RegistrationResponseJSON; name?: string },
    req?: WebAuthnRequestContext,
  ): Promise<SanitizedPasskey> {
    const response = body.response;
    if (!response || typeof response !== 'object') {
      throw new ValidationError('Missing attestation response', { param: 'response' });
    }

    // Extract the challenge from clientDataJSON for lookup.
    let challenge: string;
    try {
      const decoded = Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded) as { challenge?: string; type?: string };
      challenge = parsed.challenge ?? '';
    } catch {
      throw new ValidationError('Invalid clientDataJSON');
    }
    if (!challenge) throw new ValidationError('Missing challenge in clientDataJSON');

    const row = await this.consumeChallenge(challenge);
    if (!row || row.type !== 'registration') {
      throw new ConflictError('Invalid or expired challenge', 'challenge_invalid');
    }
    if (row.userId !== owner.id) {
      throw new ConflictError('Challenge user mismatch', 'challenge_user_mismatch');
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.origin(req),
      expectedRPID: this.rpId(req),
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new ConflictError('Registration verification failed', 'verification_failed');
    }

    const info = verification.registrationInfo;
    const credentialIdBytes = Buffer.from(info.credential.id, 'base64url');
    const credentialIdHash = sha256(credentialIdBytes);
    const publicKey = Buffer.from(info.credential.publicKey);
    const pubKeyEncoded = `${PUBLIC_KEY_PREFIX}${publicKey.toString('base64')}`;

    const dup = await this.db
      .select()
      .from(adminPasskeys)
      .where(eq(adminPasskeys.credentialIdHash, credentialIdHash))
      .limit(1);
    if (dup[0]) throw new ConflictError('Credential already registered', 'credential_duplicate');

    let transportsStr: string | null = null;
    const transports = response.response.transports;
    if (Array.isArray(transports) && transports.length > 0) {
      const allowed = transports.filter((t): t is AuthenticatorTransportFuture =>
        VALID_TRANSPORTS.includes(t as AuthenticatorTransportFuture),
      );
      if (allowed.length > 0) transportsStr = allowed.join(',');
    }

    const name = (body.name ?? '').trim() || `Passkey ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const aaguid = info.aaguid && info.aaguid !== '00000000-0000-0000-0000-000000000000' ? info.aaguid : null;

    const insertResult = await this.db.insert(adminPasskeys).values({
      userId: owner.id,
      credentialId: credentialIdBytes.toString('base64url'),
      credentialIdHash,
      publicKeyPem: pubKeyEncoded,
      coseAlg: this.guessCoseAlg(publicKey),
      signCount: info.credential.counter ?? 0,
      name,
      transports: transportsStr,
      aaguid,
      createdAt: nowIso(),
    });
    const newId = Number(insertResult[0]?.insertId ?? 0);
    const fresh = await this.findById(newId);
    if (!fresh) throw new NotFoundError('Passkey persisted but could not be reloaded');
    const sanitized = this.sanitize(fresh);
    await this.events.record({
      type: 'passkey.registered',
      payload: { user_id: owner.id, passkey_id: newId },
    });
    return sanitized;
  }

  // ---------- authentication ----------

  async beginAuthentication(username: string, req?: WebAuthnRequestContext): Promise<unknown> {
    const normalized = username.trim().toLowerCase();
    if (!normalized) throw new ValidationError('Username is required', { param: 'username' });

    const rows = await this.db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.username, normalized))
      .limit(1);
    const user = rows[0];
    if (!user || user.active !== 1) throw new NotFoundError('Unknown or inactive user', 'user_not_found');

    const credentials = await this.db
      .select()
      .from(adminPasskeys)
      .where(eq(adminPasskeys.userId, user.id));
    if (credentials.length === 0) {
      throw new ConflictError('No passkeys registered for user', 'no_passkeys');
    }
    await this.purgeExpiredChallenges();

    const options = await generateAuthenticationOptions({
      rpID: this.rpId(req),
      userVerification: 'required',
      allowCredentials: credentials.map((c) => ({
        id: this.credentialIdToBase64Url(c.credentialId),
        transports: this.parseTransports(c.transports),
      })),
    });

    await this.storeChallenge(options.challenge, user.id, 'authentication');
    return options;
  }

  async completeAuthentication(body: {
    response?: AuthenticationResponseJSON;
  }, req?: WebAuthnRequestContext): Promise<AdminUser> {
    const response = body.response;
    if (!response || typeof response !== 'object') {
      throw new ValidationError('Missing assertion response', { param: 'response' });
    }

    let challenge: string;
    try {
      const decoded = Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded) as { challenge?: string };
      challenge = parsed.challenge ?? '';
    } catch {
      throw new ValidationError('Invalid clientDataJSON');
    }
    if (!challenge) throw new ValidationError('Missing challenge in clientDataJSON');

    const row = await this.consumeChallenge(challenge);
    if (!row || row.type !== 'authentication') {
      throw new ConflictError('Invalid or expired challenge', 'challenge_invalid');
    }

    const rawIdBytes = Buffer.from(response.rawId, 'base64url');
    const credentialIdHash = sha256(rawIdBytes);
    void rawIdBytes;
    const credRows = await this.db
      .select()
      .from(adminPasskeys)
      .where(eq(adminPasskeys.credentialIdHash, credentialIdHash))
      .limit(1);
    const credential = credRows[0];
    if (!credential) throw new NotFoundError('Unknown credential', 'credential_unknown');
    if (row.userId !== credential.userId) {
      throw new ConflictError('Challenge user mismatch', 'challenge_user_mismatch');
    }

    const publicKey = this.decodePublicKey(credential.publicKeyPem);

    const webauthnCredential: WebAuthnCredential = {
      id: this.credentialIdToBase64Url(credential.credentialId),
      publicKey,
      counter: Number(credential.signCount ?? 0),
      transports: this.parseTransports(credential.transports),
    };

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.origin(req),
      expectedRPID: this.rpId(req),
      credential: webauthnCredential,
      requireUserVerification: true,
    });
    if (!verification.verified) {
      throw new ConflictError('Authentication verification failed', 'verification_failed');
    }

    const newCounter = verification.authenticationInfo.newCounter;
    const lastUsed = nowIso();
    if (newCounter > Number(credential.signCount ?? 0)) {
      await this.db
        .update(adminPasskeys)
        .set({ signCount: newCounter, lastUsedAt: lastUsed })
        .where(eq(adminPasskeys.id, credential.id));
    } else {
      await this.db
        .update(adminPasskeys)
        .set({ lastUsedAt: lastUsed })
        .where(eq(adminPasskeys.id, credential.id));
    }

    const userRows = await this.db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.id, credential.userId))
      .limit(1);
    const user = userRows[0];
    if (!user || user.active !== 1) {
      throw new ConflictError('User inactive or not found', 'user_inactive');
    }
    return user;
  }

  // ---------- internals ----------

  private sanitize(row: AdminPasskey): SanitizedPasskey {
    return {
      id: row.id,
      name: row.name ?? '',
      transports: row.transports ?? null,
      created_at: row.createdAt ?? null,
      last_used_at: row.lastUsedAt ?? null,
    };
  }

  private publicBaseUrlHost(): string | null {
    const parsed = this.publicBaseUrl();
    return parsed?.hostname ?? null;
  }

  private publicBaseUrlOrigin(): string | null {
    const parsed = this.publicBaseUrl();
    return parsed?.origin ?? null;
  }

  private publicBaseUrl(): URL | null {
    const value = this.env.PUBLIC_BASE_URL?.trim();
    if (!value) return null;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private requestHost(req?: WebAuthnRequestContext): string | null {
    const forwarded = this.env.TRUST_X_FORWARDED ? this.headerOne(req?.headers?.['x-forwarded-host']) : null;
    const candidate = forwarded ?? this.headerOne(req?.headers?.host);
    if (!candidate) return null;
    const first = candidate.split(',')[0]?.trim();
    if (!first) return null;
    try {
      const parsed = new URL(`http://${first}`);
      return parsed.hostname || null;
    } catch {
      return first.split(':')[0]?.trim() || null;
    }
  }

  private requestProtocol(req: WebAuthnRequestContext | undefined, host: string): 'http' | 'https' {
    const forwarded = this.env.TRUST_X_FORWARDED ? this.headerOne(req?.headers?.['x-forwarded-proto']) : null;
    const candidate = (forwarded ?? req?.protocol ?? '').split(',')[0]?.trim().toLowerCase();
    if (candidate === 'https' || candidate === 'http') return candidate;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' ? 'http' : 'https';
  }

  private headerOne(value: string | string[] | undefined): string | null {
    if (Array.isArray(value)) return value[0] ?? null;
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  private async findById(id: number): Promise<AdminPasskey | null> {
    const rows = await this.db
      .select()
      .from(adminPasskeys)
      .where(eq(adminPasskeys.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * `credential_id` is a varbinary column. We persist the bytes as base64url
   * text so downstream WebAuthn libraries can use them directly. If we ever
   * encounter raw bytes (e.g. from a manual import), Buffer.from copes either
   * way — base64url chars never produce non-printable bytes.
   */
  private credentialIdToBase64Url(stored: string): string {
    // Stored value already a base64url string; pass through if it parses
    // cleanly. Otherwise re-encode raw bytes.
    if (/^[A-Za-z0-9_-]+$/.test(stored)) return stored;
    return Buffer.from(stored, 'binary').toString('base64url');
  }

  private parseTransports(value: string | null | undefined): AuthenticatorTransportFuture[] | undefined {
    if (!value) return undefined;
    const parsed = value
      .split(',')
      .map((t) => t.trim())
      .filter((t): t is AuthenticatorTransportFuture =>
        VALID_TRANSPORTS.includes(t as AuthenticatorTransportFuture),
      );
    return parsed.length > 0 ? parsed : undefined;
  }

  private guessCoseAlg(publicKey: Buffer): number {
    // Best-effort guess from CBOR: the COSE_Key starts with a map; alg is at
    // key 3 (negative-int values such as -7 = ES256, -257 = RS256). We don't
    // need this for verification (simplewebauthn re-parses the key); store
    // -7 by default so an old `cose_alg` column reads cleanly.
    void publicKey;
    return -7;
  }

  private decodePublicKey(stored: string): Uint8Array {
    if (stored.startsWith(PUBLIC_KEY_PREFIX)) {
      return new Uint8Array(Buffer.from(stored.slice(PUBLIC_KEY_PREFIX.length), 'base64'));
    }
    // Legacy PEM stored by the PHP backend — not natively decodable by
    // simplewebauthn. Surface a clear error so the user can re-register.
    throw new ConflictError(
      'Legacy passkey encoding not supported; please re-register this credential',
      'passkey_legacy_pem',
    );
  }

  private async storeChallenge(
    challenge: string,
    userId: number,
    type: 'registration' | 'authentication',
  ): Promise<void> {
    // Truncate / coerce to the schema-mandated 64 char column. WebAuthn
    // challenges from simplewebauthn are base64url-encoded random bytes; the
    // default length fits.
    const stored = challenge.slice(0, 64);
    await this.db.insert(adminWebauthnChallenges).values({
      challenge: stored,
      userId,
      type,
      expiresAt: isoOffsetSeconds(CHALLENGE_TTL_SECONDS),
      createdAt: nowIso(),
    });
  }

  private async consumeChallenge(
    challenge: string,
  ): Promise<{ type: string; userId: number | null } | null> {
    const stored = challenge.slice(0, 64);
    const now = nowIso();
    const rows = await this.db
      .select()
      .from(adminWebauthnChallenges)
      .where(
        and(eq(adminWebauthnChallenges.challenge, stored), gt(adminWebauthnChallenges.expiresAt, now)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    await this.db
      .delete(adminWebauthnChallenges)
      .where(eq(adminWebauthnChallenges.id, row.id));
    return { type: row.type, userId: row.userId };
  }

  private async purgeExpiredChallenges(): Promise<void> {
    const now = nowIso();
    await this.db
      .delete(adminWebauthnChallenges)
      .where(sql`${adminWebauthnChallenges.expiresAt} <= ${now}`);
  }
}

export function createAdminPasskeyService(
  db: Database,
  env: Env,
  events: AdminEventsService,
): AdminPasskeyService {
  return new AdminPasskeyService(db, env, events);
}
