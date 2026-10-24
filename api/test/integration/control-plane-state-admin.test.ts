import { HostManagementService } from '../../src/services/host-management.js';
import { InsecureWindowAdminService } from '../../src/services/insecure-window-admin.js';
import { createInsecureWindowService } from '../../src/services/insecure-window.js';
import { makeAdminEventsWriter } from '../../src/services/admin-events-writer.js';
import { requestHost } from '../../src/control-plane/state/admission.js';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, inArray } from 'drizzle-orm';
import { getTestDb } from '../helpers/test-db.js';
import { testKeyring } from '../helpers/test-keyring.js';
import * as schema from '../../src/db/schema.js';
import { ControlPlaneOwnership } from '../../src/control-plane/owner.js';
import { OwnerPersistence } from '../../src/control-plane/persistence.js';
import { CommandExecutor, type OutboxIntent } from '../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../src/control-plane/deadlines.js';
import { hydrateOwnerState } from '../../src/control-plane/state/hydrate.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../src/control-plane/state/runtime.js';
import { resolveOwnerAdmin } from '../../src/control-plane/state/admission.js';
import { AdminAuthService } from '../../src/services/admin-auth.js';
import { AdminUsersService } from '../../src/services/admin-users.js';
import { AdminPasswordService } from '../../src/services/admin-password.js';
import type { AdminEventsService } from '../../src/services/admin-events.js';
import type { Mailer } from '../../src/services/mailer.js';
import type { Env } from '../../src/env.js';
import { sha256 } from '../../src/security/hash.js';
import { ConnectionPresence, bindOwnerPresence } from '../../src/control-plane/presence.js';

const handle = await getTestDb();
describe.skipIf(!handle)('owner admin lifecycle against real MySQL', () => {
  afterAll(async () => {
    await handle?.pool.end();
  });
  it('commits identities, sessions, revocations, reset and audit together and rehydrates after restart', async () => {
    const suffix = randomUUID().slice(0, 8);
    const owner = new ControlPlaneOwnership(handle!.pool, 'owner_refactor_test');
    const deadlines = new DeadlineQueue((error) => {
      throw error;
    });
    const hosts: number[] = [];
    const users: number[] = [];
    const commandIds: string[] = [];
    const effects: OutboxIntent[] = [];
    const env = {
      ADMIN_SESSION_COOKIE: 'admin',
      ADMIN_SESSION_TTL_MINUTES: 60,
      PUBLIC_BASE_URL: 'https://example.test',
    } as Env;
    let closeCommands: (() => Promise<void>) | undefined;
    try {
      await owner.acquire();
      const { store } = await owner.hydrate((connection, epoch) =>
        hydrateOwnerState(drizzle(connection, { schema, mode: 'default' }), { epoch, sequence: 0n }),
      );
      owner.ready();
      const persistence = new OwnerPersistence(owner, testKeyring());
      const executor = new CommandExecutor({
        state: store,
        persistence,
        assertOwner: () => owner.assertReady(),
        loseOwner: (error) => owner.lose(error),
        committed(receipt, outbox) {
          commandIds.push(receipt.id);
          effects.push(...outbox);
        },
        notificationError(error) {
          throw error;
        },
      });
      closeCommands = () => executor.drain();
      const runtime: OwnerRuntime = {
        state: store,
        deadlines,
        assertOwner: () => owner.assertReady(),
        execute: (command) => executor.execute(command),
      };
      bindOwnerRuntime(handle!.db, runtime);
      bindOwnerPresence(
        runtime,
        new ConnectionPresence((error) => {
          throw error;
        }),
      );
      const events = { record: vi.fn() } as unknown as AdminEventsService;
      const mailer = { send: vi.fn() } as unknown as Mailer;
      const auth = new AdminAuthService(handle!.db, env);
      const service = new AdminUsersService(handle!.db, auth, events);
      const password = new AdminPasswordService(handle!.db, env, auth, events, mailer);
      const first = await service.create({
        name: 'Owner fixture',
        username: `owner-${suffix}`,
        email: `owner-${suffix}@example.test`,
        password: 'fixture-password-long',
        access_level: 'owner',
      });
      users.push(first.id);
      const second = await service.create({
        name: 'Second fixture',
        username: `second-${suffix}`,
        email: `second-${suffix}@example.test`,
        password: 'fixture-password-long',
        access_level: 'owner',
      });
      users.push(second.id);
      const authenticated = await auth.login(first.username, 'fixture-password-long', null, null);
      expect(resolveOwnerAdmin(handle!.db, sha256(authenticated.token))?.user.id).toBe(first.id);
      expect(store.snapshot().table('adminUsers').get(first.id)).not.toHaveProperty('passwordHash');
      await password.requestReset(first.username);
      const intent = effects.find((effect) => effect.kind === 'admin.password.reset.email');
      expect(intent).toBeDefined();
      expect(mailer.send).not.toHaveBeenCalled();
      const text = (intent!.payload as { text: string }).text;
      const token = text.match(/Token \(valid for 60 minutes\): ([a-f0-9]+)/)?.[1];
      expect(token).toBeDefined();
      const [storedEffect] = await handle!.db
        .select()
        .from(schema.controlPlaneOutbox)
        .where(eq(schema.controlPlaneOutbox.id, intent!.id));
      expect(storedEffect?.payloadEnc).toMatch(/^sbox:v1:/);
      expect(storedEffect?.payloadEnc).not.toContain(token!);
      await password.applyReset(token!, 'replacement-password-long', 'replacement-password-long');
      expect(resolveOwnerAdmin(handle!.db, sha256(authenticated.token))).toBeNull();
      await expect(
        password.applyReset(token!, 'replacement-password-long', 'replacement-password-long'),
      ).rejects.toThrow('invalid or expired');
      const next = await auth.login(first.username, 'replacement-password-long', null, null);
      await service.update(first.id, { active: false });
      expect(resolveOwnerAdmin(handle!.db, sha256(next.token))).toBeNull();
      expect(
        await handle!.db.select().from(schema.adminSessions).where(eq(schema.adminSessions.userId, first.id)),
      ).toHaveLength(0);
      const hostService = new HostManagementService({
        db: handle!.db,
        env,
        keyring: testKeyring(),
        events: makeAdminEventsWriter(handle!.db),
      });
      const windowAdmin = new InsecureWindowAdminService({
        db: handle!.db,
        env,
        events: makeAdminEventsWriter(handle!.db),
      });
      const windows = createInsecureWindowService({ db: handle!.db, env });
      const createdHost = await hostService.register({
        fqdn: `owner-${suffix}.integration.test`,
        secure: false,
        engines: ['codex'],
      });
      hosts.push(createdHost.host.id);
      expect(store.snapshot().hosts.get(createdHost.host.id)?.credentialLookupHash).toBe(
        sha256(createdHost.apiKeyPlain),
      );
      await windowAdmin.disable(createdHost.host.id);
      await expect(
        windows.enforce(
          requestHost(store.snapshot().hosts.get(createdHost.host.id)!, createdHost.apiKeyPlain),
          'retrieve',
        ),
      ).rejects.toThrow('pending');
      const pending = store
        .snapshot()
        .table('insecureAuthRequests')
        .by('hostId', createdHost.host.id)
        .find((row) => row.status === 'pending')!;
      const decisions = await Promise.allSettled([
        windowAdmin.approve(pending.id, 10),
        windowAdmin.deny(pending.id),
      ]);
      expect(decisions.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
      expect(store.snapshot().table('insecureAuthRequests').get(pending.id)?.status).toBe('approved');
      const rotatedHost = await hostService.register({
        fqdn: createdHost.host.fqdn,
        secure: true,
        engines: ['codex'],
      });
      expect(store.snapshot().hosts.get(createdHost.host.id)?.authFingerprint).toBe(
        sha256(sha256(rotatedHost.apiKeyPlain)),
      );
      expect(
        (await handle!.db.select().from(schema.hosts).where(eq(schema.hosts.id, createdHost.host.id)))[0]
          ?.apiKeyHash,
      ).toBe(sha256(rotatedHost.apiKeyPlain));
      await executor.drain();
      await owner.close();
      const replacement = new ControlPlaneOwnership(handle!.pool, 'owner_refactor_test');
      try {
        await replacement.acquire();
        const loaded = await replacement.hydrate((connection, epoch) =>
          hydrateOwnerState(drizzle(connection, { schema, mode: 'default' }), { epoch, sequence: 0n }),
        );
        expect(loaded.store.snapshot().table('adminUsers').get(first.id)?.active).toBe(0);
        expect(loaded.store.snapshot().adminSessions.by('userId', first.id)).toHaveLength(0);
        expect(loaded.store.snapshot().table('controlPlaneOutbox').get(intent!.id)?.status).toBe('pending');
      } finally {
        await replacement.close();
      }
    } finally {
      await closeCommands?.();
      deadlines.close();
      await owner.close();
      if (hosts.length) {
        await handle!.db.delete(schema.installTokens).where(inArray(schema.installTokens.hostId, hosts));
        await handle!.db
          .delete(schema.insecureAuthRequests)
          .where(inArray(schema.insecureAuthRequests.hostId, hosts));
        await handle!.db.delete(schema.hosts).where(inArray(schema.hosts.id, hosts));
      }
      if (users.length) {
        await handle!.db.delete(schema.adminSessions).where(inArray(schema.adminSessions.userId, users));
        await handle!.db
          .delete(schema.adminPasswordResets)
          .where(inArray(schema.adminPasswordResets.userId, users));
        await handle!.db.delete(schema.adminUsers).where(inArray(schema.adminUsers.id, users));
      }
      if (effects.length)
        await handle!.db.delete(schema.controlPlaneOutbox).where(
          inArray(
            schema.controlPlaneOutbox.id,
            effects.map((effect) => effect.id),
          ),
        );
      if (commandIds.length)
        await handle!.db
          .delete(schema.controlPlaneCommandReceipts)
          .where(inArray(schema.controlPlaneCommandReceipts.requestId, commandIds));
    }
  }, 60_000);
});
