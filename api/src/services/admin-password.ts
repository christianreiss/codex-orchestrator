import { randomUUID } from 'node:crypto';
import { mutateOwnerState, ownerRuntimeFor } from '../control-plane/state/runtime.js';
import { adminAudit, credentialDigest, expireUserResetTokens, patchAdminUser, requireCurrentUser, revokeUserSessions, removeUserPasskeys } from '../control-plane/state/admin.js';
import type { Json } from '../control-plane/commands.js';
import { and, eq, gt, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { adminPasskeys, adminPasswordResets, adminUsers } from '../db/schema.js';
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
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      const keepTokenHash = currentToken ? sha256(currentToken) : null;
      const result = await mutateOwnerState(owner, { kind: 'admin.password.change', responseAuthorization:'commit', payload: { userId, credentialDigest: credentialDigest(nextHash), keepTokenHash }, prepare: ctx => {
        requireCurrentUser(ctx, userId, credentialDigest(user.passwordHash));
        const next = patchAdminUser(ctx, userId, { passwordHash: nextHash, updatedAt: now });
        revokeUserSessions(ctx, userId, keepTokenHash); expireUserResetTokens(ctx, userId, now);
        adminAudit(ctx, 'admin.auth.password.change', { user_id: userId });
        return this.auth.sanitizeUser(next) as unknown as Json;
      } });
      return result as unknown as SanitizedAdminUser;
    }
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
   * For privacy we always return success even when the username/email is unknown.
   */
  async requestReset(identifier: string): Promise<{ delivered: boolean }> {
    const normalized = identifier.trim().toLowerCase();
    const owner = ownerRuntimeFor(this.db);
    if (owner) owner.assertOwner();
    const ownedUsers = owner?.state.snapshot().table('adminUsers');
    const userRows = owner
      ? [...(ownedUsers!.by('username', normalized).length ? ownedUsers!.by('username', normalized) : ownedUsers!.by('email', normalized))]
      : normalized ? await this.db
          .select()
          .from(adminUsers)
          .where(or(eq(adminUsers.username, normalized), eq(adminUsers.email, normalized)))
          .limit(1)
      : [];
    const user = userRows[0] ?? null;
    if (!user || user.active !== 1) {
      // Do equivalent-cost dummy work (token generation + a side-effect-free
      // DB round trip) so an unknown username produces neither a latency nor
      // a response-shape signal distinguishable from a known one, and always
      // report success per the docstring above.
      const dummyToken = randomHex(32);
      const dummyHash = sha256(dummyToken);
      if (owner) { void dummyHash; return { delivered: true }; }
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

    const base = this.env.PUBLIC_BASE_URL ?? '';
    const link = base ? `${base.replace(/\/$/, '')}/admin/password/reset?token=${token}` : `token=${token}`;
    const email = { to: user.email, subject: 'Codex Orchestrator: password reset', text:
      `Hi ${user.name},\n\nA password reset was requested for your Codex Orchestrator admin account.\n\nToken (valid for 60 minutes): ${token}\n` +
      (base ? `Reset link: ${link}\n\n` : '\n') + `If you did not request this, you can ignore this message.` };
    const effectId = randomUUID();
    if (owner) {
      await mutateOwnerState(owner, { kind: 'admin.password.reset.issue', payload: { userId: user.id, tokenHash }, prepare(ctx) {
        const current = requireCurrentUser(ctx, user.id);
        if (!current.active || current.email !== user.email) throw new ConflictError('User changed during reset request', 'user_changed');
        const values = { userId: user.id, tokenHash, expiresAt, usedAt: null, createdAt: nowIso() };
        ctx.write(async tx => {
          const inserted = await tx.insert(adminPasswordResets).values(values); const id = Number(inserted[0]?.insertId);
          if (!Number.isSafeInteger(id) || id < 1) throw new Error('Reset token insert returned no identity');
          ctx.draft.upsert('adminPasswordResets', { ...values, id });
        });
        adminAudit(ctx, 'admin.auth.password.request', { user_id: user.id, delivery_pending: true });
        ctx.effect({ id: effectId, kind: 'admin.password.reset.email', target: String(user.id), payload: email, availableAt: nowIso() });
        return null;
      } });
    } else await this.db.insert(adminPasswordResets).values({ userId: user.id, tokenHash, expiresAt, usedAt: null, createdAt: nowIso() });

    if (owner) return { delivered: true };
    const result = await this.mailer.send(email);

    if (!owner) await this.events.record(
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
    const owner = ownerRuntimeFor(this.db);
    if (owner) owner.assertOwner();
    const rows = owner ? owner.state.snapshot().table('adminPasswordResets').by('tokenHash', tokenHash).filter(row => row.usedAt === null && row.expiresAt > now) : await this.db
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
    if (owner) {
      const result = await mutateOwnerState(owner, { kind: 'admin.password.reset.consume', responseAuthorization:'commit', payload: { tokenHash, credentialDigest: credentialDigest(nextHash) }, prepare: ctx => {
        const current = ctx.draft.table('adminPasswordResets').get(reset.id);
        const at = nowIso();
        if (!current || current.usedAt !== null || current.expiresAt <= at || current.tokenHash !== tokenHash) throw new ConflictError('Reset token is invalid or expired', 'reset_token_invalid');
        const target = requireCurrentUser(ctx, current.userId);
        if (!target.active) throw new NotFoundError('User not found', 'user_not_found');
        const next = patchAdminUser(ctx, target.id, { passwordHash: nextHash, updatedAt: at });
        revokeUserSessions(ctx, target.id); expireUserResetTokens(ctx, target.id, at); removeUserPasskeys(ctx, target.id);
        adminAudit(ctx, 'admin.auth.password.reset', { user_id: target.id });
        return this.auth.sanitizeUser(next) as unknown as Json;
      } });
      return result as unknown as SanitizedAdminUser;
    }
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
    await this.db.delete(adminPasskeys).where(eq(adminPasskeys.userId, user.id));

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
