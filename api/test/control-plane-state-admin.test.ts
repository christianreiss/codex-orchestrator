import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandExecutor, type CommandReceipt, type OutboxIntent } from '../src/control-plane/commands.js';
import { DeadlineQueue } from '../src/control-plane/deadlines.js';
import type { PersistenceTransaction } from '../src/control-plane/persistence.js';
import {
  OwnerStateSnapshot,
  OwnerStateStore,
  type PreparedOwnerState,
} from '../src/control-plane/state/store.js';
import {
  bindOwnerRuntime,
  mutateOwnerState,
  withOwnerRequestScope,
  setOwnerRequestPrincipal,
  type OwnerRuntime,
} from '../src/control-plane/state/runtime.js';
import { resolveOwnerAdmin } from '../src/control-plane/state/admission.js';
import { patchAdminUser, type PasskeyPrincipal } from '../src/control-plane/state/admin.js';
import type { StateSeed } from '../src/control-plane/state/catalog.js';
import * as schema from '../src/db/schema.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { AdminAuthService } from '../src/services/admin-auth.js';
import { AdminUsersService } from '../src/services/admin-users.js';
import { AdminPasswordService } from '../src/services/admin-password.js';
import type { AdminEventsService } from '../src/services/admin-events.js';
import type { Mailer } from '../src/services/mailer.js';
import { hash } from '../src/security/password.js';
import { sha256 } from '../src/security/hash.js';
import { createDbFake } from './helpers/db-fake.js';

const epoch = '12345678-1234-1234-1234-123456789012';
const now = '2026-10-24T00:00:00Z';
const future = '2099-01-01T00:00:00Z';
const env = {
  ADMIN_SESSION_COOKIE: 'admin',
  ADMIN_SESSION_TTL_MINUTES: 60,
  PUBLIC_BASE_URL: 'https://example.test',
} as Env;
const queues: DeadlineQueue[] = [];
afterEach(() => {
  for (const queue of queues.splice(0)) queue.close();
});
function user(id: number, passwordHash = 'stored-verifier'): schema.AdminUser {
  return {
    id,
    name: `Owner ${id}`,
    username: `owner${id}`,
    email: `owner${id}@example.test`,
    passwordHash,
    accessLevel: 'owner',
    active: 1,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
function session(id: number, userId: number, token: string): schema.AdminSession {
  return {
    id,
    userId,
    tokenHash: sha256(token),
    ip: null,
    userAgent: null,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: future,
  };
}
function harness(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables = new Map(
    Object.entries(seed).map(([name, rows]) => [
      (schema as unknown as Record<string, unknown>)[name],
      structuredClone(rows),
    ]),
  );
  const fake = createDbFake(tables);
  const db = fake as unknown as Database;
  const select = vi.spyOn(fake, 'select');
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch, sequence: 0n }, seed as StateSeed));
  const deadlines = new DeadlineQueue((error) => {
    throw error;
  });
  queues.push(deadlines);
  const receipts = new Map<string, CommandReceipt>();
  const effects: OutboxIntent[] = [];
  let failCommit = false;
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state,
    assertOwner() {},
    loseOwner(error) {
      throw error;
    },
    committed() {},
    notificationError(error) {
      throw error;
    },
    persistence: {
      async receipt(principal, id) {
        return receipts.get(`${principal}:${id}`);
      },
      async transaction(run) {
        const before = new Map([...fake.tables].map(([key, value]) => [key, structuredClone(value)]));
        try {
          await run(fake as unknown as PersistenceTransaction);
        } catch (error) {
          fake.tables.clear();
          for (const [key, value] of before) fake.tables.set(key, value);
          throw error;
        }
      },
      async record(_tx, receipt, outbox) {
        if (failCommit) throw new Error('simulated persistence failure');
        receipts.set(`${receipt.principal}:${receipt.id}`, receipt);
        effects.push(...outbox);
      },
    },
  });
  const runtime: OwnerRuntime = {
    state,
    deadlines,
    assertOwner() {},
    execute: (command) => executor.execute(command),
  };
  bindOwnerRuntime(db, runtime);
  const events = { record: vi.fn(async () => undefined) } as unknown as AdminEventsService;
  const mailer = { send: vi.fn(async () => ({ delivered: true })) } as unknown as Mailer;
  const auth = new AdminAuthService(db, env);
  return {
    db,
    fake,
    select,
    runtime,
    effects,
    receipts,
    events,
    mailer,
    auth,
    users: new AdminUsersService(db, auth, events),
    passwords: new AdminPasswordService(db, env, auth, events, mailer),
    fail() {
      failCommit = true;
    },
  };
}

describe('owner admin lifecycle', () => {
  it('serializes the first-owner claim without migration-table reads', async () => {
    const h = harness();
    const outcomes = await Promise.allSettled(
      [1, 2].map((id) =>
        h.users.createFirstOwner({
          name: `Owner ${id}`,
          username: `owner${id}`,
          email: `owner${id}@example.test`,
          password: 'a-long-test-password',
        }),
      ),
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(h.runtime.state.snapshot().table('adminUsers').size).toBe(1);
    expect(h.select).not.toHaveBeenCalled();
    expect(h.fake.tables.get(schema.adminEvents)).toHaveLength(1);
  });

  it('creates and revokes sessions with no admission SQL', async () => {
    const existing = user(1);
    const h = harness({ adminUsers: [existing] });
    const created = await h.auth.createSession(existing, null, null, 'admin.auth.login');
    const context = resolveOwnerAdmin(h.db, sha256(created.token));
    expect(context?.user.id).toBe(1);
    expect(context?.user).not.toHaveProperty('passwordHash');
    await h.auth.logoutByToken(created.token);
    expect(resolveOwnerAdmin(h.db, sha256(created.token))).toBeNull();
    expect(h.select).not.toHaveBeenCalled();
  });

  it('rejects an asynchronously verified stale credential after reset', async () => {
    const existing = user(1);
    const h = harness({ adminUsers: [existing] });
    await mutateOwnerState(h.runtime, {
      kind: 'test.password.rotate',
      payload: {},
      prepare(ctx) {
        patchAdminUser(ctx, 1, { passwordHash: 'new-verifier', updatedAt: now });
        return null;
      },
    });
    await expect(h.auth.createSession(existing, null, null, 'admin.auth.login')).rejects.toThrow(
      'Credentials changed',
    );
    expect(h.runtime.state.snapshot().adminSessions.size).toBe(0);
  });

  it('allows only one of two concurrent last-owner demotions', async () => {
    const h = harness({ adminUsers: [user(1), user(2)] });
    const outcomes = await Promise.allSettled(
      [1, 2].map((id) => h.users.update(id, { access_level: 'viewer' })),
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      h.runtime.state
        .snapshot()
        .table('adminUsers')
        .all()
        .filter((row) => row.accessLevel === 'owner'),
    ).toHaveLength(1);
    expect(h.select).not.toHaveBeenCalled();
  });

  it('atomically revokes sessions with deactivation and audit', async () => {
    const h = harness({ adminUsers: [user(1), user(2)], adminSessions: [session(1, 2, 'second')] });
    await h.users.update(2, { active: false });
    expect(resolveOwnerAdmin(h.db, sha256('second'))).toBeNull();
    expect(h.runtime.state.snapshot().adminSessions.size).toBe(0);
    expect(h.fake.tables.get(schema.adminEvents)?.at(-1)?.type).toBe('user.updated');
  });

  it('does not publish a revoked user or session when persistence fails', async () => {
    const h = harness({ adminUsers: [user(1), user(2)], adminSessions: [session(1, 2, 'second')] });
    h.fail();
    await expect(h.users.update(2, { active: false })).rejects.toThrow('persistence failure');
    expect(resolveOwnerAdmin(h.db, sha256('second'))?.user.active).toBe(1);
    expect(h.fake.tables.get(schema.adminSessions)).toHaveLength(1);
    expect(h.runtime.state.revision().sequence).toBe(0n);
  });

  it('stores reset delivery intent atomically without sending email before commit', async () => {
    const h = harness({ adminUsers: [user(1)] });
    expect(await h.passwords.requestReset('owner1')).toEqual({ delivered: true });
    expect(h.mailer.send).not.toHaveBeenCalled();
    expect(h.effects[0]?.kind).toBe('admin.password.reset.email');
    expect(h.runtime.state.snapshot().table('adminPasswordResets').size).toBe(1);
    const effect = h.runtime.state.snapshot().table('controlPlaneOutbox').all()[0];
    expect(effect?.status).toBe('pending');
    expect(effect).not.toHaveProperty('payloadEnc');
    expect(h.select).not.toHaveBeenCalled();
  });

  it('consumes a reset once, revokes sessions/passkeys, and keeps verifier cold', async () => {
    const existing = user(1, await hash('before-reset-password'));
    const h = harness({
      adminUsers: [existing],
      adminSessions: [session(1, 1, 'old')],
      adminPasswordResets: [
        {
          id: 1,
          userId: 1,
          tokenHash: sha256('reset-token'),
          expiresAt: future,
          usedAt: null,
          createdAt: now,
        },
      ],
      adminPasskeys: [{ id: 1, userId: 1, credentialIdHash: 'key' }],
    });
    await h.passwords.applyReset('reset-token', 'after-reset-password', 'after-reset-password');
    expect(h.runtime.state.snapshot().adminSessions.size).toBe(0);
    expect(h.runtime.state.snapshot().table('adminPasskeys').size).toBe(0);
    expect(h.runtime.state.snapshot().table('adminPasswordResets').get(1)?.usedAt).not.toBeNull();
    expect(h.runtime.state.snapshot().table('adminUsers').get(1)).not.toHaveProperty('passwordHash');
    await expect(
      h.passwords.applyReset('reset-token', 'after-reset-password', 'after-reset-password'),
    ).rejects.toThrow('invalid or expired');
  });

  it('rechecks passkey revocation between verification and session minting', async () => {
    const h = harness({ adminUsers: [user(1)] });
    const principal = {
      ...h.runtime.state.snapshot().table('adminUsers').get(1)!,
      passkeyProof: { id: 4, credentialIdHash: 'revoked' },
    } as PasskeyPrincipal;
    await expect(h.auth.createSession(principal, null, null, 'admin.auth.passkey')).rejects.toThrow(
      'Passkey revoked',
    );
  });

  it('captures and revalidates request authority before queued mutations', async () => {
    const h = harness({ adminUsers: [user(1)] });
    let valid = true;
    await expect(
      withOwnerRequestScope(() => {
        setOwnerRequestPrincipal({
          principal: 'admin:1',
          revalidate() {
            if (!valid) throw new Error('revoked');
          },
        });
        const operation = mutateOwnerState(h.runtime, {
          kind: 'test.queued',
          payload: {},
          prepare() {
            return null;
          },
        });
        valid = false;
        return operation;
      }),
    ).rejects.toThrow('revoked');
    expect(h.runtime.state.revision().sequence).toBe(0n);
  });
});
