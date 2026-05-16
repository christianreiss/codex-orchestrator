import { eq } from 'drizzle-orm';
import { adminUsers, type AdminUser } from '../../../src/db/schema.js';
import { hash } from '../../../src/security/password.js';
import { nowIso } from '../../../src/util/timestamp.js';
import type { TestDb } from '../test-db.js';
import { issueSession } from './admin-sessions.js';
import type { FastifyInstance } from 'fastify';

export interface MakeAdminUserOverrides {
  name?: string;
  username?: string;
  email?: string;
  password?: string; // plaintext; will be argon2id-hashed
  passwordHash?: string; // pre-hashed override (skips hashing)
  accessLevel?: string;
  active?: number;
}

export interface MakeAdminUserResult {
  user: AdminUser;
  password: string;
}

/**
 * Inserts an admin_users row with an argon2id password hash. Pass `password`
 * to override the default test password; pass `passwordHash` to use a
 * pre-computed hash (useful for testing legacy bcrypt/phpass rehash paths).
 */
export async function makeAdminUser(
  db: TestDb,
  overrides: MakeAdminUserOverrides = {},
): Promise<MakeAdminUserResult> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const password = overrides.password ?? 'correct-horse-battery-staple';
  const passwordHash = overrides.passwordHash ?? (await hash(password));
  const now = nowIso();

  await db.insert(adminUsers).values({
    name: overrides.name ?? 'Test Admin',
    username: overrides.username ?? `admin-${suffix}`,
    email: overrides.email ?? `admin-${suffix}@example.test`,
    passwordHash,
    accessLevel: overrides.accessLevel ?? 'owner',
    active: overrides.active ?? 1,
    createdAt: now,
    updatedAt: now,
  });

  // We can't reliably read insertId across drivers without typing gymnastics;
  // re-select by unique username instead.
  const username = overrides.username ?? `admin-${suffix}`;
  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.username, username)).limit(1);
  if (!user) throw new Error('makeAdminUser: row not found after insert');
  return { user, password };
}

/**
 * Convenience: create + immediately log in. Returns the session cookie
 * string in the form `name=value`, suitable to inject via headers.cookie.
 *
 * Note: This issues the session row directly (does not exercise the login
 * route); use a real login route via inject() if you want to test that.
 */
export interface LoginAsResult {
  user: AdminUser;
  password: string;
  cookie: string;
  token: string;
}

export async function loginAs(
  _app: FastifyInstance,
  db: TestDb,
  overrides: MakeAdminUserOverrides = {},
): Promise<LoginAsResult> {
  const { user, password } = await makeAdminUser(db, overrides);
  const { token } = await issueSession(db, user);
  const cookieName = (_app.env?.ADMIN_SESSION_COOKIE as string | undefined) ?? 'codex_admin_session';
  return { user, password, token, cookie: `${cookieName}=${token}` };
}
