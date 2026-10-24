import { eq, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import {
  adminEvents,
  adminPasskeys,
  adminPasswordResets,
  adminSessions,
  adminUsers,
} from '../../db/schema.js';
import { ConflictError, NotFoundError, UnauthorizedError } from '../../http/errors.js';
import type { OwnerMutationContext } from './runtime.js';
import type { StateRow } from './catalog.js';

export type AdminMetadata = StateRow<'adminUsers'>;
export function credentialDigest(verifier: string): string {
  return createHash('sha256').update(verifier).digest('hex');
}
export function requireCurrentUser(
  ctx: OwnerMutationContext,
  id: number,
  verifiedDigest?: string,
): Readonly<AdminMetadata> {
  const user = ctx.draft.table('adminUsers').get(id);
  if (!user) throw new NotFoundError('User not found', 'user_not_found');
  if (verifiedDigest !== undefined && (!user.active || user.credentialDigest !== verifiedDigest))
    throw new UnauthorizedError('Credentials changed during authentication', 'invalid_credentials');
  return user;
}
export function guardLastOwner(
  ctx: OwnerMutationContext,
  id: number,
  patch: { active?: number; accessLevel?: string },
): void {
  const users = ctx.draft.table('adminUsers').all();
  const current = users.find((user) => user.id === id);
  const admin = (role: string) => role === 'owner' || role === 'admin';
  if (
    current?.active === 1 &&
    admin(current.accessLevel) &&
    (patch.active === 0 || (patch.accessLevel !== undefined && !admin(patch.accessLevel)))
  ) {
    if (!users.some((user) => user.id !== id && user.active === 1 && admin(user.accessLevel)))
      throw new ConflictError('Cannot remove the last active admin', 'last_admin');
  }
}
export function revokeUserSessions(
  ctx: OwnerMutationContext,
  userId: number,
  keepTokenHash: string | null = null,
): void {
  const sessions = ctx.draft
    .table('adminSessions')
    .by('userId', userId)
    .filter((row) => row.tokenHash !== keepTokenHash);
  for (const session of sessions) ctx.draft.remove('adminSessions', session.id);
  if (sessions.length)
    ctx.write(async (tx) =>
      tx.delete(adminSessions).where(
        inArray(
          adminSessions.id,
          sessions.map((row) => row.id),
        ),
      ),
    );
}
export function expireUserResetTokens(ctx: OwnerMutationContext, userId: number, now: string): void {
  const tokens = ctx.draft
    .table('adminPasswordResets')
    .by('userId', userId)
    .filter((row) => row.usedAt === null);
  for (const token of tokens) ctx.draft.upsert('adminPasswordResets', { ...token, usedAt: now });
  if (tokens.length)
    ctx.write(async (tx) =>
      tx
        .update(adminPasswordResets)
        .set({ usedAt: now })
        .where(
          inArray(
            adminPasswordResets.id,
            tokens.map((row) => row.id),
          ),
        ),
    );
}
export function removeUserPasskeys(ctx: OwnerMutationContext, userId: number): void {
  const passkeys = ctx.draft.table('adminPasskeys').by('userId', userId);
  for (const passkey of passkeys) ctx.draft.remove('adminPasskeys', passkey.id);
  if (passkeys.length)
    ctx.write(async (tx) => tx.delete(adminPasskeys).where(eq(adminPasskeys.userId, userId)));
}
export function patchAdminUser(
  ctx: OwnerMutationContext,
  id: number,
  patch: Partial<typeof adminUsers.$inferInsert>,
): Readonly<AdminMetadata> {
  const current = requireCurrentUser(ctx, id);
  const next = {
    ...current,
    ...patch,
    ...(patch.passwordHash !== undefined ? { credentialDigest: credentialDigest(patch.passwordHash) } : {}),
  };
  ctx.draft.upsert('adminUsers', next);
  ctx.write(async (tx) => tx.update(adminUsers).set(patch).where(eq(adminUsers.id, id)));
  return ctx.draft.table('adminUsers').get(id)!;
}
export function adminAudit(
  ctx: OwnerMutationContext,
  type: string,
  payload: Record<string, unknown> | (() => Record<string, unknown>),
  createdAt = new Date().toISOString(),
  hostId: number | null = null,
): void {
  ctx.write(async (tx) => {
    const result = await tx
      .insert(adminEvents)
      .values({ type, hostId, payload: typeof payload === 'function' ? payload() : payload, createdAt });
    const id = Number(result[0]?.insertId);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Admin audit insert returned no identity');
    // Derived metadata, reconstructed from the durable log at boot; no K/V write.
    ctx.draft.upsert('versions', { name: 'owner_admin_event_id', version: String(id), updatedAt: createdAt });
  });
}

export type PasskeyPrincipal = AdminMetadata & {
  readonly passkeyProof: { readonly id: number; readonly credentialIdHash: string };
};
