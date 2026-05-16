import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { adminSessions, type AdminUser, type AdminSession } from '../../../src/db/schema.js';
import { sha256 } from '../../../src/security/hash.js';
import { nowIso, isoOffsetSeconds } from '../../../src/util/timestamp.js';
import type { TestDb } from '../test-db.js';

export interface IssueSessionOverrides {
  ip?: string;
  userAgent?: string;
  /** Lifetime in seconds; defaults to 12h. */
  ttlSeconds?: number;
  /** Explicit raw token; defaults to a fresh 32-byte hex. */
  token?: string;
}

export interface IssueSessionResult {
  session: AdminSession;
  /** Raw cookie-value token. Stored only as `tokenHash = sha256(token)`. */
  token: string;
}

/**
 * Inserts an admin_sessions row for `user`. Returns the raw token (suitable
 * for the session cookie) and the persisted session row. Mirrors the format
 * the real login route writes so tests can drive `requireAdmin` end-to-end.
 */
export async function issueSession(
  db: TestDb,
  user: AdminUser,
  overrides: IssueSessionOverrides = {},
): Promise<IssueSessionResult> {
  const token = overrides.token ?? randomBytes(32).toString('hex');
  const tokenHash = sha256(token);
  const now = nowIso();
  const ttl = overrides.ttlSeconds ?? 60 * 60 * 12;
  const expiresAt = isoOffsetSeconds(ttl);

  await db.insert(adminSessions).values({
    userId: user.id,
    tokenHash,
    ip: overrides.ip ?? '127.0.0.1',
    userAgent: overrides.userAgent ?? 'test-agent/1.0',
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
  });

  const [session] = await db
    .select()
    .from(adminSessions)
    .where(eq(adminSessions.tokenHash, tokenHash))
    .limit(1);
  if (!session) throw new Error('issueSession: row not found after insert');
  return { session, token };
}
