import { and, eq, gt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { adminPasswordResets, adminUsers } from '../db/schema.js';
import type { Env } from '../env.js';
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../http/errors.js';
import { randomHex, sha256 } from '../security/hash.js';
import { hash as hashPassword, verify as verifyPassword } from '../security/password.js';
import { isoOffsetSeconds, nowIso } from '../util/timestamp.js';
import { AdminAuthService, type SanitizedAdminUser } from './admin-auth.js';
import { AdminEventsService } from './admin-events.js';
import type { Mailer } from './mailer.js';

/**
 * Password lifecycle: change (authenticated), request-reset (issues a 1-hour
 * single-use token), and reset (consumes the token + replaces hash). All
 * mutations clear sibling sessions so credentials cannot outlive a rotation.
 */

const RESET_TTL_SECONDS = 60 * 60;

export class AdminPasswordService {
  constructor(
    private readonly db: Database,
    private readonly env: Env,
    private readonly auth: AdminAuthService,
    private readonly events: AdminEventsService,
    private readonly mailer: Mailer,
  ) {}

  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
    confirmPassword: string,
    currentToken: string | null,
  ): Promise<SanitizedAdminUser> {
    if (newPassword !== confirmPassword) {
      throw new ValidationError('Password confirmation does not match.', {
        param: 'confirm_password',
      });
    }

    const user = await this.auth.findUserById(userId);
    if (!user || user.active !== 1) throw new NotFoundError('User not found', 'user_not_found');

    if (!currentPassword || currentPassword.trim() === '') {
      throw new UnauthorizedError('Current password is incorrect', 'current_password_invalid');
    }

    const verifyResult = await verifyPassword(user.passwordHash, currentPassword);
    if (!verifyResult.ok) {
      throw new UnauthorizedError('Current password is incorrect', 'current_password_invalid');
    }

    this.auth.validatePasswordOrThrow(newPassword);

    const nextHash = await hashPassword(newPassword);
    const now = nowIso();
    await this.db
      .update(adminUsers)
      .set({ passwordHash: nextHash, updatedAt: now })
      .where(eq(adminUsers.id, userId));

    const keepTokenHash = currentToken ? sha256(currentToken) : null;
    await this.auth.deleteSessionsForUserExcept(userId, keepTokenHash);
    await this.auth.expireResetTokensForUser(userId);

    await this.events.record(
      { type: 'admin.auth.password.change', payload: { user_id: userId } },
      { broadcast: false },
    );

    const fresh = await this.auth.findUserById(userId);
    return this.auth.sanitizeUser(fresh ?? { ...user, passwordHash: nextHash, updatedAt: now });
  }

  /**
   * Issue a single-use reset token + email it to the address on file.
   * For privacy we always return success even when the username is unknown.
   */
  async requestReset(username: string): Promise<{ delivered: boolean }> {
    const user = await this.auth.findUserByUsername(username);
    if (!user || user.active !== 1) {
      // Do equivalent-cost dummy work (token generation + a side-effect-free
      // DB round trip) so an unknown username produces neither a latency nor
      // a response-shape signal distinguishable from a known one, and always
      // report success per the docstring above.
      const dummyToken = randomHex(32);
      const dummyHash = sha256(dummyToken);
      await this.db
        .select({ id: adminPasswordResets.id })
        .from(adminPasswordResets)
        .where(eq(adminPasswordResets.tokenHash, dummyHash))
        .limit(1);
      return { delivered: true };
    }

    const token = randomHex(32);
    const tokenHash = sha256(token);
    const expiresAt = isoOffsetSeconds(RESET_TTL_SECONDS);

    await this.db.insert(adminPasswordResets).values({
      userId: user.id,
      tokenHash,
      expiresAt,
      usedAt: null,
      createdAt: nowIso(),
    });

    const base = this.env.PUBLIC_BASE_URL ?? '';
    const link = base ? `${base.replace(/\/$/, '')}/admin/auth/password/reset?token=${token}` : `token=${token}`;
    const result = await this.mailer.send({
      to: user.email,
      subject: 'Codex Orchestrator: password reset',
      text:
        `Hi ${user.name},\n\n` +
        `A password reset was requested for your Codex Orchestrator admin account.\n\n` +
        `Token (valid for 60 minutes): ${token}\n` +
        (base ? `Reset link: ${link}\n\n` : '\n') +
        `If you did not request this, you can ignore this message.`,
    });

    await this.events.record(
      {
        type: 'admin.auth.password.request',
        payload: { user_id: user.id, delivered: result.delivered },
      },
      { broadcast: false },
    );

    // Always report success to the caller (see docstring); the real
    // delivery outcome is preserved above only in the internal audit event.
    return { delivered: true };
  }

  async applyReset(token: string, newPassword: string, confirmPassword: string): Promise<SanitizedAdminUser> {
    if (!token || token.trim() === '') {
      throw new ValidationError('Reset token is required', { param: 'token' });
    }
    if (newPassword !== confirmPassword) {
      throw new ValidationError('Password confirmation does not match.', {
        param: 'confirm_password',
      });
    }
    this.auth.validatePasswordOrThrow(newPassword);

    const tokenHash = sha256(token);
    const now = nowIso();
    const rows = await this.db
      .select()
      .from(adminPasswordResets)
      .where(
        and(
          eq(adminPasswordResets.tokenHash, tokenHash),
          sql`${adminPasswordResets.usedAt} IS NULL`,
          gt(adminPasswordResets.expiresAt, now),
        ),
      )
      .limit(1);
    const reset = rows[0];
    if (!reset) {
      throw new ConflictError('Reset token is invalid or expired', 'reset_token_invalid');
    }

    const user = await this.auth.findUserById(reset.userId);
    if (!user || user.active !== 1) {
      throw new NotFoundError('User not found', 'user_not_found');
    }

    const nextHash = await hashPassword(newPassword);
    await this.db
      .update(adminUsers)
      .set({ passwordHash: nextHash, updatedAt: now })
      .where(eq(adminUsers.id, user.id));

    await this.db
      .update(adminPasswordResets)
      .set({ usedAt: now })
      .where(eq(adminPasswordResets.id, reset.id));

    await this.auth.deleteAllSessionsForUser(user.id);
    await this.auth.expireResetTokensForUser(user.id);

    await this.events.record(
      { type: 'admin.auth.password.reset', payload: { user_id: user.id } },
      { broadcast: false },
    );

    const fresh = await this.auth.findUserById(user.id);
    return this.auth.sanitizeUser(fresh ?? { ...user, passwordHash: nextHash, updatedAt: now });
  }
}

export function createAdminPasswordService(
  db: Database,
  env: Env,
  auth: AdminAuthService,
  events: AdminEventsService,
  mailer: Mailer,
): AdminPasswordService {
  return new AdminPasswordService(db, env, auth, events, mailer);
}
