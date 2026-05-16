/**
 * Unit coverage for AdminUsersService — focused on the validators (username
 * shape, email shape, role enum) which are pure. The CRUD paths themselves
 * are exercised via the integration suite against an in-memory DB.
 */
import { describe, it, expect } from 'vitest';
import { AdminUsersService } from '../../../src/services/admin-users.js';
import { AdminAuthService } from '../../../src/services/admin-auth.js';
import { AdminEventsService } from '../../../src/services/admin-events.js';
import type { Database } from '../../../src/db/client.js';
import type { Env } from '../../../src/env.js';

function makeService(): AdminUsersService {
  const auth = new AdminAuthService({} as Database, {} as Env);
  const events = new AdminEventsService({} as Database);
  return new AdminUsersService({} as Database, auth, events);
}

describe('AdminUsersService normalizers (via create input pre-validation)', () => {
  // Reach into private validation by attempting a create with a clearly broken
  // shape; the underlying normalizer throws ValidationError before any DB
  // call, so we exercise the pure paths without needing a working DB.
  it('rejects an obviously short username', async () => {
    const svc = makeService();
    await expect(
      svc.create({
        name: 'Test',
        username: 'ab',
        email: 'test@example.test',
        password: 'password-long-enough',
        access_level: 'owner',
      }),
    ).rejects.toThrow(/3-64/);
  });

  it('rejects an invalid email', async () => {
    const svc = makeService();
    await expect(
      svc.create({
        name: 'Test',
        username: 'good_user',
        email: 'not-an-email',
        password: 'password-long-enough',
        access_level: 'owner',
      }),
    ).rejects.toThrow(/Invalid email/);
  });

  it('rejects an unknown access_level', async () => {
    const svc = makeService();
    await expect(
      svc.create({
        name: 'Test',
        username: 'good_user',
        email: 'good@example.test',
        password: 'password-long-enough',
        access_level: 'superuser',
      }),
    ).rejects.toThrow(/Invalid access level/);
  });

  it('rejects empty name with trimmed input', async () => {
    const svc = makeService();
    await expect(
      svc.create({
        name: '   ',
        username: 'good_user',
        email: 'good@example.test',
        password: 'password-long-enough',
        access_level: 'owner',
      }),
    ).rejects.toThrow(/Name is required/);
  });
});
