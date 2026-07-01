import { and, count, eq, gt, ne, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../db/client.js';
import {
  adminEvents,
  adminPasskeys,
  adminPasswordResets,
  adminSessions,
  adminUsers,
  type AdminUser,
  type AdminSession,
} from '../db/schema.js';
import type { Env } from '../env.js';
import { ForbiddenError, UnauthorizedError } from '../http/errors.js';
import { randomHex, sha256 } from '../security/hash.js';
import { verify as verifyPassword } from '../security/password.js';
import { isoOffsetSeconds, nowIso } from '../util/timestamp.js';
import type { AuthFailureTracker } from './auth-failure-tracker.js';

/**
 * Admin authentication service. Owns the login/logout dispatch and the
 * session lifecycle: minting a 64-hex token, persisting its sha256 to
 * `admin_sessions`, setting the HttpOnly cookie. Password verification goes
 * through `security/password.ts`, which transparently handles bcrypt/phpass
 * legacy hashes and returns an argon2 rehash on success — we write it back
 * here so the user upgrades on the next login.
 */

export const ROLE_OWNER = 'owner';
export const ROLE_ADMIN = 'admin';
export const ROLE_VIEWER = 'viewer';
// Legacy roles (kept for matrix dispatch when reading existing rows)
export const ROLE_FLEET = 'fleet_operator';
export const ROLE_TRUSTED = 'trusted_user';
export const ROLE_USER = 'user';

export const VALID_ACCESS_LEVELS = [
  ROLE_OWNER,
  ROLE_ADMIN,
  ROLE_VIEWER,
  ROLE_FLEET,
  ROLE_TRUSTED,
  ROLE_USER,
] as const;

export type AccessLevel = (typeof VALID_ACCESS_LEVELS)[number];

export interface SanitizedAdminUser {
  id: number;
  name: string;
  username: string;
  email: string;
  access_level: string;
  active: boolean;
  last_login_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface SessionResult {
  token: string;
  expires_at: string;
  user: SanitizedAdminUser;
}

const SESSION_TTL_MIN_SECONDS = 300;
const SESSION_TTL_MAX_SECONDS = 7 * 24 * 60 * 60;
const PASSWORD_MIN_LENGTH = 12;

export class AdminAuthService {
  constructor(
    private readonly db: Database,
    private readonly env: Env,
    private readonly failures?: AuthFailureTracker,
  ) {}

  // ---------- public helpers ----------

  sessionCookieName(): string {
    return this.env.ADMIN_SESSION_COOKIE ?? 'codex_admin_session';
  }

  sessionTtlSeconds(): number {
    const minutes = this.env.ADMIN_SESSION_TTL_MINUTES ?? 12 * 60;
    const seconds = Math.max(0, minutes) * 60;
    return Math.min(SESSION_TTL_MAX_SECONDS, Math.max(SESSION_TTL_MIN_SECONDS, seconds));
  }

  passwordMinLength(): number {
    return PASSWORD_MIN_LENGTH;
  }

  validRole(role: string): role is AccessLevel {
    return (VALID_ACCESS_LEVELS as readonly string[]).includes(role);
  }

  sanitizeUser(row: AdminUser): SanitizedAdminUser {
    return {
      id: row.id,
      name: row.name,
      username: row.username,
      email: row.email,
      access_level: row.accessLevel,
      active: row.active === 1,
      last_login_at: row.lastLoginAt ?? null,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  validatePasswordOrThrow(password: string): void {
    if (typeof password !== 'string' || password.length < this.passwordMinLength()) {
      const err = new UnauthorizedError(
        `Password must be at least ${this.passwordMinLength()} characters.`,
        'password_too_short',
      );
      // Use 422 for validation
      (err as unknown as { status: number }).status = 422;
      throw err;
    }
  }

  // ---------- queries ----------

  async countUsers(): Promise<number> {
    const rows = await this.db.select({ c: count() }).from(adminUsers);
    return Number(rows[0]?.c ?? 0);
  }

  async countAdmins(onlyActive = true): Promise<number> {
    const clauses = [eq(adminUsers.accessLevel, ROLE_OWNER)];
    if (onlyActive) clauses.push(eq(adminUsers.active, 1));
    const rows = await this.db
      .select({ c: count() })
      .from(adminUsers)
      .where(and(...clauses));
    const owners = Number(rows[0]?.c ?? 0);

    // Also count rows with legacy ROLE_ADMIN that are active (so countAdmins
    // continues to reflect "has someone who can manage users").
    const clauses2 = [eq(adminUsers.accessLevel, ROLE_ADMIN)];
    if (onlyActive) clauses2.push(eq(adminUsers.active, 1));
    const rows2 = await this.db
      .select({ c: count() })
      .from(adminUsers)
      .where(and(...clauses2));
    return owners + Number(rows2[0]?.c ?? 0);
  }

  async isEnforced(): Promise<boolean> {
    return (await this.countAdmins(true)) > 0;
  }

  async findUserByUsername(username: string): Promise<AdminUser | null> {
    const normalized = username.trim().toLowerCase();
    if (!normalized) return null;
    const rows = await this.db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.username, normalized))
      .limit(1);
    return rows[0] ?? null;
  }

  async findUserById(id: number): Promise<AdminUser | null> {
    if (!Number.isFinite(id) || id <= 0) return null;
    const rows = await this.db.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async hasPasskey(userId: number): Promise<boolean> {
    if (!userId) return false;
    const rows = await this.db
      .select({ c: count() })
      .from(adminPasskeys)
      .where(eq(adminPasskeys.userId, userId));
    return Number(rows[0]?.c ?? 0) > 0;
  }

  async anyPasskeyRegistered(): Promise<boolean> {
    const rows = await this.db.select({ c: count() }).from(adminPasskeys);
    return Number(rows[0]?.c ?? 0) > 0;
  }

  // ---------- login flows ----------

  async login(
    username: string,
    password: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<SessionResult> {
    if (!password || password.trim() === '') {
      await this.failures?.recordFailure(ip, 'missing_password');
      throw new UnauthorizedError('Invalid credentials', 'invalid_credentials');
    }
    const user = await this.findUserByUsername(username);
    if (!user || user.active !== 1) {
      await this.failures?.recordFailure(ip, 'invalid_username');
      throw new UnauthorizedError('Invalid credentials', 'invalid_credentials');
    }
    if (await this.hasPasskey(user.id)) {
      throw new ForbiddenError('Passkey login required for this user', 'passkey_required');
    }

    const verifyResult = await verifyPassword(user.passwordHash, password);
    if (!verifyResult.ok) {
      await this.failures?.recordFailure(ip, 'invalid_password');
      throw new UnauthorizedError('Invalid credentials', 'invalid_credentials');
    }

    let updatedHash = user.passwordHash;
    if (verifyResult.rehash) {
      updatedHash = verifyResult.rehash;
      await this.db
        .update(adminUsers)
        .set({ passwordHash: updatedHash, updatedAt: nowIso() })
        .where(eq(adminUsers.id, user.id));
    }

    return this.createSession({ ...user, passwordHash: updatedHash }, ip, userAgent, 'admin.auth.login');
  }

  async resolveLoginMethod(username: string): Promise<'password' | 'passkey'> {
    const user = await this.findUserByUsername(username);
    if (!user) return 'password';
    return (await this.hasPasskey(user.id)) ? 'passkey' : 'password';
  }

  async createSession(
    user: AdminUser,
    ip: string | null,
    userAgent: string | null,
    eventType: string,
  ): Promise<SessionResult> {
    const token = randomHex(32);
    const tokenHash = sha256(token);
    const expiresAt = isoOffsetSeconds(this.sessionTtlSeconds());
    const created = nowIso();

    await this.db.insert(adminSessions).values({
      userId: user.id,
      tokenHash,
      ip,
      userAgent: userAgent ? userAgent.slice(0, 255) : null,
      createdAt: created,
      lastSeenAt: created,
      expiresAt,
    });

    await this.db
      .update(adminUsers)
      .set({ lastLoginAt: created, updatedAt: created })
      .where(eq(adminUsers.id, user.id));

    await this.db.insert(adminEvents).values({
      type: eventType,
      hostId: null,
      payload: { user_id: user.id, username: user.username },
      createdAt: created,
    });

    return {
      token,
      expires_at: expiresAt,
      user: this.sanitizeUser({ ...user, lastLoginAt: created }),
    };
  }

  async logoutByToken(token: string | null | undefined): Promise<void> {
    if (!token) return;
    const tokenHash = sha256(token);
    await this.db.delete(adminSessions).where(eq(adminSessions.tokenHash, tokenHash));
    await this.db.insert(adminEvents).values({
      type: 'admin.auth.logout',
      hostId: null,
      payload: {},
      createdAt: nowIso(),
    });
  }

  // ---------- cookie helpers ----------

  applySessionCookie(reply: FastifyReply, token: string, expiresAt: string): void {
    const expires = new Date(expiresAt);
    reply.setCookie(this.sessionCookieName(), token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isSecureRequest(reply),
      expires: Number.isFinite(expires.getTime()) ? expires : undefined,
    });
  }

  clearSessionCookie(reply: FastifyReply): void {
    reply.clearCookie(this.sessionCookieName(), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isSecureRequest(reply),
    });
  }

  private isSecureRequest(reply: FastifyReply): boolean {
    const protocol = reply.request.protocol;
    return protocol === 'https';
  }

  readTokenFromRequest(req: FastifyRequest): string | null {
    const raw = req.cookies?.[this.sessionCookieName()];
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  }

  // ---------- session invalidation on password change ----------

  async deleteSessionsForUserExcept(userId: number, keepTokenHash: string | null): Promise<void> {
    if (keepTokenHash) {
      await this.db
        .delete(adminSessions)
        .where(
          and(eq(adminSessions.userId, userId), ne(adminSessions.tokenHash, keepTokenHash)),
        );
    } else {
      await this.db.delete(adminSessions).where(eq(adminSessions.userId, userId));
    }
  }

  async deleteAllSessionsForUser(userId: number): Promise<void> {
    await this.db.delete(adminSessions).where(eq(adminSessions.userId, userId));
  }

  async expireResetTokensForUser(userId: number): Promise<void> {
    const now = nowIso();
    await this.db
      .update(adminPasswordResets)
      .set({ usedAt: now })
      .where(
        and(eq(adminPasswordResets.userId, userId), sql`${adminPasswordResets.usedAt} IS NULL`),
      );
  }

  async purgeExpiredSessions(): Promise<void> {
    const now = nowIso();
    await this.db.delete(adminSessions).where(sql`${adminSessions.expiresAt} <= ${now}`);
  }

  // ---------- session resolution (for routes that bypass requireAdmin) ----------

  async resolveSession(
    token: string | null | undefined,
  ): Promise<{ session: AdminSession; user: AdminUser } | null> {
    if (!token) return null;
    const tokenHash = sha256(token);
    const now = nowIso();
    const rows = await this.db
      .select({ session: adminSessions, user: adminUsers })
      .from(adminSessions)
      .innerJoin(adminUsers, eq(adminSessions.userId, adminUsers.id))
      .where(and(eq(adminSessions.tokenHash, tokenHash), gt(adminSessions.expiresAt, now)))
      .limit(1);
    const row = rows[0];
    if (!row || row.user.active !== 1) return null;
    return row;
  }
}

export function createAdminAuthService(
  db: Database,
  env: Env,
  failures?: AuthFailureTracker,
): AdminAuthService {
  return new AdminAuthService(db, env, failures);
}
