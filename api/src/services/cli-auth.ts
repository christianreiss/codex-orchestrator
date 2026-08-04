import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { cliAuthRequests } from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Keyring } from '../security/keyring.js';
import { encrypt, decryptOrNull } from '../security/secret-box.js';
import { sha256 } from '../security/hash.js';
import { nowIso, isoOffsetSeconds } from '../util/timestamp.js';
import { ApiError, ConflictError, NotFoundError } from '../http/errors.js';
import type { HostRegistrationService } from './host-registration.js';
import { wsPublisher } from '../ws/publisher.js';

/**
 * Device-code CLI login flow (`/cli/auth/*`).
 *   1. CLI calls POST /cli/auth/start with fqdn+secure → returns user_code +
 *      request_id; the wrapper polls /cli/auth/poll/:id every ~5 seconds.
 *   2. A signed-in admin opens /cli/auth/verify in a browser, types the
 *      user_code, then approves or denies.
 *   3. On approve, we register a host (re-using HostRegistrationService) and
 *      cache the plaintext API key encrypted with the keyring for the polling
 *      wrapper to consume in its very next poll.
 */

const TTL_SECONDS = 600;
const POLL_INTERVAL = 5;
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const DIGITS = '23456789';

export interface CliAuthStartResult {
  request_id: string;
  user_code: string;
  expires_in: number;
  poll_interval: number;
}

export type CliAuthPollResult =
  | { status: 'not_found' }
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'consumed' }
  | { status: 'approved'; api_key: string | null; fqdn: string; secure: boolean };

export interface CliAuthService {
  start(input: { fqdn: string; secure: boolean; ip: string | null; userAgent: string | null }): Promise<CliAuthStartResult>;
  poll(requestId: string): Promise<CliAuthPollResult>;
  lookup(userCode: string): Promise<{ id: number; fqdn: string; secure: boolean; ip: string | null; created_at: string; expires_at: string } | null>;
  approve(userCode: string, approvedByUserId: number, approvedByName: string | null): Promise<{ fqdn: string; host_id: number }>;
  deny(userCode: string): Promise<{ fqdn: string }>;
}

export interface CliAuthDeps {
  db: Database;
  keyring: Keyring;
  registration: HostRegistrationService;
}

export function createCliAuthService(deps: CliAuthDeps): CliAuthService {
  const { db, keyring, registration } = deps;

  return {
    async start({ fqdn, secure, ip, userAgent }) {
      const trimmed = fqdn.trim();
      if (!trimmed) {
        throw new ApiError('fqdn is required', { status: 422, code: 'validation_failed', param: 'fqdn' });
      }
      const requestId = randomBytes(32).toString('hex');
      const userCode = generateUserCode();
      const userCodeHash = sha256(userCode);
      const expiresAt = isoOffsetSeconds(TTL_SECONDS);
      const createdAt = nowIso();

      await db.insert(cliAuthRequests).values({
        requestId,
        requestIdEnc: encrypt(requestId, keyring),
        userCode,
        userCodeHash,
        fqdn: trimmed,
        secure: secure ? 1 : 0,
        status: 'pending',
        ip: ip ?? undefined,
        userAgent: userAgent ?? undefined,
        expiresAt,
        createdAt,
      });

      return { request_id: requestId, user_code: userCode, expires_in: TTL_SECONDS, poll_interval: POLL_INTERVAL };
    },

    async poll(requestId) {
      const rows = await db.select().from(cliAuthRequests).where(eq(cliAuthRequests.requestId, requestId)).limit(1);
      const row = rows[0];
      if (!row) return { status: 'not_found' };
      if (Date.parse(row.expiresAt) <= Date.now()) return { status: 'expired' };
      const status = row.status;
      if (status === 'pending') return { status: 'pending' };
      if (status === 'denied') return { status: 'denied' };
      if (status === 'approved') {
        if (row.consumedAt) return { status: 'consumed' };
        const result = await db
          .update(cliAuthRequests)
          .set({ consumedAt: nowIso() })
          .where(and(eq(cliAuthRequests.id, row.id), isNull(cliAuthRequests.consumedAt)));
        if (Number(result[0]?.affectedRows ?? 0) === 0) return { status: 'consumed' };
        const apiKey = decryptOrNull(row.apiKeyEnc ?? null, keyring);
        return { status: 'approved', api_key: apiKey, fqdn: row.fqdn, secure: row.secure === 1 };
      }
      return { status: 'pending' };
    },

    async lookup(userCode) {
      const code = userCode.toUpperCase().trim();
      if (!code) return null;
      const hash = sha256(code);
      const rows = await db
        .select()
        .from(cliAuthRequests)
        .where(and(eq(cliAuthRequests.userCodeHash, hash), gt(cliAuthRequests.expiresAt, nowIso())))
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        fqdn: r.fqdn,
        secure: r.secure === 1,
        ip: r.ip ?? null,
        created_at: r.createdAt,
        expires_at: r.expiresAt,
      };
    },

    async approve(userCode, approvedByUserId, approvedByName) {
      const code = userCode.toUpperCase().trim();
      if (!code) throw new ApiError('user_code is required', { status: 422, code: 'validation_failed' });
      const hash = sha256(code);
      const rows = await db.select().from(cliAuthRequests).where(eq(cliAuthRequests.userCodeHash, hash)).limit(1);
      const r = rows[0];
      if (!r) throw new NotFoundError('Login request not found or expired');
      if (Date.parse(r.expiresAt) <= Date.now()) {
        throw new ApiError('Login request has expired', { status: 410, code: 'expired' });
      }
      if (r.status !== 'pending') {
        throw new ConflictError('Login request already resolved');
      }

      const reg = await registration.registerOrRotate({ fqdn: r.fqdn, secure: r.secure === 1, createdBy: approvedByName ?? null });
      const apiKeyEnc = encrypt(reg.apiKey, keyring);
      await db
        .update(cliAuthRequests)
        .set({ status: 'approved', approvedByUserId, hostId: reg.host.id, apiKeyEnc, approvedAt: nowIso() })
        .where(eq(cliAuthRequests.id, r.id));

      wsPublisher.publish('insecure.approval.changed', { fqdn: r.fqdn, host_id: reg.host.id, kind: 'cli_auth' });
      return { fqdn: r.fqdn, host_id: reg.host.id };
    },

    async deny(userCode) {
      const code = userCode.toUpperCase().trim();
      if (!code) throw new ApiError('user_code is required', { status: 422, code: 'validation_failed' });
      const hash = sha256(code);
      const rows = await db.select().from(cliAuthRequests).where(eq(cliAuthRequests.userCodeHash, hash)).limit(1);
      const r = rows[0];
      if (!r) throw new NotFoundError('Login request not found or expired');
      await db
        .update(cliAuthRequests)
        .set({ status: 'denied', approvedAt: nowIso() })
        .where(eq(cliAuthRequests.id, r.id));
      wsPublisher.publish('insecure.approval.changed', { fqdn: r.fqdn, kind: 'cli_auth_denied' });
      return { fqdn: r.fqdn };
    },
  };
}

function generateUserCode(): string {
  let alpha = '';
  for (let i = 0; i < 4; i++) {
    alpha += ALPHA[randomBytes(1)[0]! % ALPHA.length];
  }
  let digits = '';
  for (let i = 0; i < 4; i++) {
    digits += DIGITS[randomBytes(1)[0]! % DIGITS.length];
  }
  return `${alpha}-${digits}`;
}
