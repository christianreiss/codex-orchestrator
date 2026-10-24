import { projectAdminUserDeletion } from '../control-plane/state/deletion.js';
import { mutateOwnerState, ownerRuntimeFor, type OwnerRuntime } from '../control-plane/state/runtime.js';
import { adminAudit, credentialDigest, expireUserResetTokens, guardLastOwner, patchAdminUser, requireCurrentUser, revokeUserSessions, removeUserPasskeys } from '../control-plane/state/admin.js';
import type { Json } from '../control-plane/commands.js';
import { and, asc, count, eq, ne, or } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { adminPasswordResets, adminSessions, adminUsers, schemaMigrations, type AdminUser } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { hash as hashPassword } from '../security/password.js';
import { nowIso } from '../util/timestamp.js';
import {
  AdminAuthService,
  ROLE_OWNER,
  ROLE_ADMIN,
  VALID_ACCESS_LEVELS,
  type AccessLevel,
  type SanitizedAdminUser,
} from './admin-auth.js';
import { AdminEventsService } from './admin-events.js';

/**
 * Admin user CRUD. Validation lives here (uniqueness, role validity,
 * "first user must be owner/admin", "cannot remove the last admin"). Side
 * effects: emit audit + WS events; expire sessions/reset tokens when a
 * password rotates or a user is deleted.
 */

export interface CreateUserInput {
  name: string;
  username: string;
  email: string;
  password: string;
  access_level: string;
  active?: boolean;
}

export interface UpdateUserInput {
  name?: string;
  username?: string;
  email?: string;
  password?: string;
  access_level?: string;
  active?: boolean;
}

const USERNAME_PATTERN = /^[a-z0-9._-]{3,64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Subset of Database used by guardLastAdmin/countActiveAdminsExcluding,
// satisfied by both a plain Database handle and a transaction handle.
type DbLike = Pick<Database, 'select'>;

function normalizeUsername(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('Username is required', { param: 'username' });
  const value = raw.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(value)) {
    throw new ValidationError('Username must be 3-64 chars (letters, numbers, . _ -)', {
      param: 'username',
    });
  }
  return value;
}

function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('Email is required', { param: 'email' });
  const value = raw.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(value)) throw new ValidationError('Invalid email', { param: 'email' });
  return value;
}

function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ValidationError('Name is required', { param: 'name' });
  }
  return raw.trim();
}

function normalizeBool(value: unknown, fallback = true): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  }
  return fallback;
}

export class AdminUsersService {
  private firstOwnerClaim: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly auth: AdminAuthService,
    private readonly events: AdminEventsService,
  ) {}

  async list(): Promise<SanitizedAdminUser[]> {
    const owner = ownerRuntimeFor(this.db);
    if (owner) { owner.assertOwner(); return [...owner.state.snapshot().table('adminUsers').all()].sort((a, b) => a.username.localeCompare(b.username)).map(row => this.auth.sanitizeUser(row)); }
    const rows = await this.db.select().from(adminUsers).orderBy(asc(adminUsers.username));
    return rows.map((r) => this.auth.sanitizeUser(r));
  }

  async create(input: CreateUserInput): Promise<SanitizedAdminUser> {
    const name = normalizeName(input.name);
    const username = normalizeUsername(input.username);
    const email = normalizeEmail(input.email);
    const accessLevel = this.validateAccessLevel(input.access_level);
    const active = normalizeBool(input.active, true);
    const password = typeof input.password === 'string' ? input.password : '';

    const userCount = await this.auth.countUsers();
    if (userCount === 0) {
      if (accessLevel !== ROLE_OWNER && accessLevel !== ROLE_ADMIN) {
        throw new ValidationError('First user must be an admin', { param: 'access_level' });
      }
      if (!active) {
        throw new ValidationError('First user must be active', { param: 'active' });
      }
    }

    this.auth.validatePasswordOrThrow(password);

    const runtime = ownerRuntimeFor(this.db);
    if (runtime) runtime.assertOwner();
    const usernameDup = runtime ? runtime.state.snapshot().table('adminUsers').by('username', username)[0] : await this.auth.findUserByUsername(username);
    if (usernameDup) throw new ConflictError('Username already exists', 'username_taken');
    const emailDup = await this.findUserByEmail(email);
    if (emailDup) throw new ConflictError('Email already exists', 'email_taken');

    const now = nowIso();
    const hash = await hashPassword(password);

    const owner = ownerRuntimeFor(this.db);
    if (owner) return this.createOwned(owner, { name, username, email, passwordHash: hash, accessLevel, active: active ? 1 : 0, createdAt: now, updatedAt: now, lastLoginAt: null }, false);
    const result = await this.db.insert(adminUsers).values({
      name,
      username,
      email,
      passwordHash: hash,
      accessLevel,
      active: active ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    });
    const insertedId = Number(result[0]?.insertId ?? 0);
    const created = await this.auth.findUserById(insertedId);
    if (!created) throw new NotFoundError('User not found after create', 'user_not_found');

    const sanitized = this.auth.sanitizeUser(created);
    await this.events.record({ type: 'user.created', payload: { user: sanitized } });
    return sanitized;
  }

  /**
   * Atomically claims an empty installation. The in-process queue prevents
   * request races in one API worker; the locked migration-ledger row provides
   * the cross-worker serialization point without adding bootstrap schema.
   */
  async createFirstOwner(
    input: Omit<CreateUserInput, 'access_level' | 'active'>,
  ): Promise<SanitizedAdminUser> {
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      const name = normalizeName(input.name); const username = normalizeUsername(input.username); const email = normalizeEmail(input.email);
      this.auth.validatePasswordOrThrow(input.password);
      const passwordHash = await hashPassword(input.password); const now = nowIso();
      return this.createOwned(owner, { name, username, email, passwordHash, accessLevel: ROLE_OWNER, active: 1, createdAt: now, updatedAt: now, lastLoginAt: null }, true);
    }
    const previous = this.firstOwnerClaim;
    let release!: () => void;
    this.firstOwnerClaim = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const name = normalizeName(input.name);
      const username = normalizeUsername(input.username);
      const email = normalizeEmail(input.email);
      const password = typeof input.password === 'string' ? input.password : '';
      this.auth.validatePasswordOrThrow(password);
      const passwordHash = await hashPassword(password);
      let insertedId = 0;

      await this.db.transaction(async (tx) => {
        await tx.select({ version: schemaMigrations.version }).from(schemaMigrations).limit(1).for('update');
        const totals = await tx.select({ c: count() }).from(adminUsers);
        if (Number(totals[0]?.c ?? 0) !== 0) {
          throw new ConflictError('The first owner has already been claimed', 'first_owner_claimed');
        }
        const now = nowIso();
        const result = await tx.insert(adminUsers).values({
          name,
          username,
          email,
          passwordHash,
          accessLevel: ROLE_OWNER,
          active: 1,
          createdAt: now,
          updatedAt: now,
        });
        insertedId = Number(result[0]?.insertId ?? 0);
      });

      const created = await this.auth.findUserById(insertedId);
      if (!created) throw new NotFoundError('User not found after create', 'user_not_found');
      const sanitized = this.auth.sanitizeUser(created);
      await this.events.record({ type: 'user.created', payload: { user: sanitized, bootstrap: true } });
      return sanitized;
    } finally {
      release();
    }
  }

  async update(id: number, input: UpdateUserInput): Promise<SanitizedAdminUser> {
    const runtime = ownerRuntimeFor(this.db);
    if (runtime) runtime.assertOwner();
    const user = runtime ? runtime.state.snapshot().table('adminUsers').get(id) : await this.auth.findUserById(id);
    if (!user) throw new NotFoundError('User not found', 'user_not_found');

    const patch: Partial<{
      name: string;
      username: string;
      email: string;
      passwordHash: string;
      accessLevel: string;
      active: number;
      updatedAt: string;
    }> = {};

    if (Object.prototype.hasOwnProperty.call(input, 'name')) patch.name = normalizeName(input.name);
    if (Object.prototype.hasOwnProperty.call(input, 'username')) {
      const username = normalizeUsername(input.username);
      const dup = runtime ? runtime.state.snapshot().table('adminUsers').by('username', username)[0] : await this.auth.findUserByUsername(username);
      if (dup && dup.id !== id) throw new ConflictError('Username already exists', 'username_taken');
      patch.username = username;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'email')) {
      const email = normalizeEmail(input.email);
      const dup = await this.findUserByEmail(email);
      if (dup && dup.id !== id) throw new ConflictError('Email already exists', 'email_taken');
      patch.email = email;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'access_level')) {
      patch.accessLevel = this.validateAccessLevel(input.access_level);
    }
    if (Object.prototype.hasOwnProperty.call(input, 'active')) {
      patch.active = normalizeBool(input.active, true) ? 1 : 0;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'password') && typeof input.password === 'string') {
      this.auth.validatePasswordOrThrow(input.password);
      patch.passwordHash = await hashPassword(input.password);
    }

    if (Object.keys(patch).length === 0) {
      if (!runtime) await this.guardLastAdmin(this.db, user, patch);
      return this.auth.sanitizeUser(user);
    }

    patch.updatedAt = nowIso();
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      const result = await mutateOwnerState(owner, { kind: 'admin.user.update', responseAuthorization:'commit', payload: { id, ...patch, passwordHash: patch.passwordHash ? credentialDigest(patch.passwordHash) : null }, prepare: ctx => {
        requireCurrentUser(ctx, id);
        guardLastOwner(ctx, id, patch);
        const users = ctx.draft.table('adminUsers');
        if (patch.username && users.by('username', patch.username).some(row => row.id !== id)) throw new ConflictError('Username already exists', 'username_taken');
        if (patch.email && users.by('email', patch.email).some(row => row.id !== id)) throw new ConflictError('Email already exists', 'email_taken');
        const next = patchAdminUser(ctx, id, patch);
        if (patch.passwordHash !== undefined || patch.active === 0) revokeUserSessions(ctx, id);
        if (patch.passwordHash !== undefined) expireUserResetTokens(ctx, id, patch.updatedAt!);
        const sanitized = this.auth.sanitizeUser(next);
        adminAudit(ctx, 'user.updated', { user: sanitized });
        return sanitized as unknown as Json;
      } });
      return result as unknown as SanitizedAdminUser;
    }
    // Guard-and-write atomically: without this, two concurrent requests that
    // each demote/deactivate a *different* admin can both see "one other
    // admin still active" and both pass the check, leaving zero active
    // admins. Running the guard's locking read and the patch write inside
    // the same transaction serializes concurrent guard checks against the
    // true post-write state.
    await this.db.transaction(async (tx) => {
      await this.guardLastAdmin(tx, user, patch);
      await tx.update(adminUsers).set(patch).where(eq(adminUsers.id, id));
    });

    if (patch.passwordHash !== undefined) {
      await this.auth.deleteAllSessionsForUser(id);
      await this.auth.expireResetTokensForUser(id);
    } else if (patch.active === 0) {
      await this.auth.deleteAllSessionsForUser(id);
    }

    const fresh = await this.auth.findUserById(id);
    if (!fresh) throw new NotFoundError('User not found after update', 'user_not_found');
    const sanitized = this.auth.sanitizeUser(fresh);
    await this.events.record({ type: 'user.updated', payload: { user: sanitized } });
    return sanitized;
  }

  async remove(id: number): Promise<void> {
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      await mutateOwnerState(owner, { kind: 'admin.user.remove', responseAuthorization:'commit', payload: { id }, prepare(ctx) {
        const user = requireCurrentUser(ctx, id); guardLastOwner(ctx, id, { active: 0 });
        revokeUserSessions(ctx, id); expireUserResetTokens(ctx, id, nowIso()); removeUserPasskeys(ctx, id);
        projectAdminUserDeletion(ctx.draft, id);
        ctx.draft.remove('adminUsers', id);
        ctx.write(async tx => tx.delete(adminUsers).where(eq(adminUsers.id, id)));
        adminAudit(ctx, 'user.deleted', { user_id: id, username: user.username });
        return null;
      } });
      return;
    }
    const user = await this.auth.findUserById(id);
    if (!user) throw new NotFoundError('User not found', 'user_not_found');

    await this.db.transaction(async (tx) => {
      await this.guardLastAdmin(tx, user, { active: 0 }, true);
      await tx.delete(adminUsers).where(eq(adminUsers.id, id));
    });

    await this.auth.deleteAllSessionsForUser(id);
    await this.auth.expireResetTokensForUser(id);

    await this.events.record({
      type: 'user.deleted',
      payload: { user_id: id, username: user.username },
    });
  }

  /**
   * Wipe every admin user EXCEPT the actor (passed by id). If the actor is
   * not part of the table for some reason, falls back to wiping everything.
   */
  async wipe(actorId: number | null): Promise<{ removed: number }> {
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      const result = await mutateOwnerState(owner, { kind: 'admin.users.wipe', payload: { actorId }, prepare(ctx) {
        const now = nowIso();
        const users = ctx.draft.table('adminUsers').all().filter(row => row.id !== actorId);
        for (const user of users) {
          revokeUserSessions(ctx, user.id); expireUserResetTokens(ctx, user.id, now); removeUserPasskeys(ctx, user.id);
          projectAdminUserDeletion(ctx.draft, user.id);
          ctx.draft.remove('adminUsers', user.id);
          ctx.write(async tx => tx.delete(adminUsers).where(eq(adminUsers.id, user.id)));
        }
        adminAudit(ctx, 'admin.user.wipe', { removed: users.length, actor_id: actorId });
        return { removed: users.length };
      } });
      return result as { removed: number };
    }
    const now = nowIso();
    if (actorId && Number.isFinite(actorId)) {
      // Expire reset tokens for everyone other than actor, drop their sessions.
      await this.db
        .update(adminPasswordResets)
        .set({ usedAt: now })
        .where(ne(adminPasswordResets.userId, actorId));
      await this.db.delete(adminSessions).where(ne(adminSessions.userId, actorId));
      const result = await this.db.delete(adminUsers).where(ne(adminUsers.id, actorId));
      const removed = Number(result[0]?.affectedRows ?? 0);
      await this.events.record({ type: 'admin.user.wipe', payload: { removed, actor_id: actorId } });
      return { removed };
    }

    await this.db.update(adminPasswordResets).set({ usedAt: now });
    await this.db.delete(adminSessions);
    const result = await this.db.delete(adminUsers);
    const removed = Number(result[0]?.affectedRows ?? 0);
    await this.events.record({ type: 'admin.user.wipe', payload: { removed } });
    return { removed };
  }

  private async createOwned(owner: OwnerRuntime, values: Omit<AdminUser, 'id'>, bootstrap: boolean): Promise<SanitizedAdminUser> {
    let created: SanitizedAdminUser | undefined;
    const result = await mutateOwnerState(owner, { kind: bootstrap ? 'admin.owner.claim' : 'admin.user.create', payload: { username: values.username, email: values.email, accessLevel: values.accessLevel, active: values.active, credentialDigest: credentialDigest(values.passwordHash) }, prepare: ctx => {
      const users = ctx.draft.table('adminUsers');
      if (bootstrap && users.size !== 0) throw new ConflictError('The first owner has already been claimed', 'first_owner_claimed');
      if (!users.size && (values.active !== 1 || ![ROLE_OWNER, ROLE_ADMIN].includes(values.accessLevel))) throw new ValidationError('First user must be an active admin', { param: 'access_level' });
      if (users.by('username', values.username).length) throw new ConflictError('Username already exists', 'username_taken');
      if (users.by('email', values.email).length) throw new ConflictError('Email already exists', 'email_taken');
      ctx.write(async tx => {
        const insert = await tx.insert(adminUsers).values(values); const id = Number(insert[0]?.insertId);
        if (!Number.isSafeInteger(id) || id < 1) throw new Error('Admin user insert returned no identity');
        const row = { ...values, id, credentialDigest: credentialDigest(values.passwordHash) };
        ctx.draft.upsert('adminUsers', row); created = this.auth.sanitizeUser(row);
      });
      adminAudit(ctx, 'user.created', () => ({ user: created, ...(bootstrap ? { bootstrap: true } : {}) }), values.createdAt);
      return () => created as unknown as Json;
    } });
    return result as unknown as SanitizedAdminUser;
  }

  // ---------- helpers ----------

  private validateAccessLevel(raw: unknown): string {
    if (typeof raw !== 'string' || !VALID_ACCESS_LEVELS.includes(raw as AccessLevel)) {
      throw new ValidationError('Invalid access level', { param: 'access_level' });
    }
    return raw;
  }

  private async findUserByEmail(email: string): Promise<Omit<AdminUser, 'passwordHash'> | null> {
    const owner = ownerRuntimeFor(this.db);
    if (owner) { owner.assertOwner(); return owner.state.snapshot().table('adminUsers').by('email', email)[0] ?? null; }
    const rows = await this.db.select().from(adminUsers).where(eq(adminUsers.email, email)).limit(1);
    return rows[0] ?? null;
  }

  private async guardLastAdmin(
    tx: DbLike,
    user: Omit<AdminUser, 'passwordHash'>,
    patch: { accessLevel?: string; active?: number },
    deleting = false,
  ): Promise<void> {
    const wasOwnerLike = user.accessLevel === ROLE_OWNER || user.accessLevel === ROLE_ADMIN;
    const wasActive = user.active === 1;
    if (!wasOwnerLike || !wasActive) return;

    const nextRole = patch.accessLevel ?? user.accessLevel;
    const nextActive = patch.active === undefined ? wasActive : patch.active === 1;
    const stillAdmin = (nextRole === ROLE_OWNER || nextRole === ROLE_ADMIN) && nextActive;
    if (!deleting && stillAdmin) return;

    const adminsActive = await this.countActiveAdminsExcluding(tx, user.id);
    if (adminsActive === 0) {
      throw new ValidationError('At least one active admin is required', {
        param: 'access_level',
      });
    }
  }

  private async countActiveAdminsExcluding(tx: DbLike, excludeId: number): Promise<number> {
    // Lock every currently-active owner/admin row (not just the "other"
    // ones) for the lifetime of the caller's transaction, then exclude
    // `excludeId` in JS. Locking the full set (rather than just the rows
    // that exclude `excludeId`) serializes concurrent guard checks against
    // the true post-write state: a second transaction demoting/deactivating
    // a *different* admin will block on this locking read until the first
    // transaction commits, and will then observe the updated row set
    // instead of a stale one -- preventing two concurrent demotions from
    // both seeing "one other admin still active" and leaving zero admins.
    const rows = await tx
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(
        and(
          eq(adminUsers.active, 1),
          or(eq(adminUsers.accessLevel, ROLE_OWNER), eq(adminUsers.accessLevel, ROLE_ADMIN)),
        ),
      )
      .for('update');
    return rows.filter((r) => r.id !== excludeId).length;
  }
}

export function createAdminUsersService(
  db: Database,
  auth: AdminAuthService,
  events: AdminEventsService,
): AdminUsersService {
  return new AdminUsersService(db, auth, events);
}
