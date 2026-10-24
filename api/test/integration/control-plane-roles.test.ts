import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, inArray } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { getTestDb } from '../helpers/test-db.js';
import { testKeyring } from '../helpers/test-keyring.js';
import { ControlPlaneOwnership } from '../../src/control-plane/owner.js';
import { OwnerPersistence } from '../../src/control-plane/persistence.js';
import { CommandExecutor } from '../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../src/control-plane/deadlines.js';
import { ConnectionPresence, bindOwnerPresence } from '../../src/control-plane/presence.js';
import { hydrateOwnerState } from '../../src/control-plane/state/hydrate.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../src/control-plane/state/runtime.js';
import { RolesService } from '../../src/services/roles.js';
import { SettingsService } from '../../src/services/settings.js';
import { sha256 } from '../../src/security/hash.js';
const handle = await getTestDb();
describe.skipIf(!handle)('owner role lifecycle on MySQL', () => {
  afterAll(async () => {
    await handle?.pool.end();
  });
  it('preserves publication, assignments and proposal decisions across hydration for all engines', async () => {
    const suffix = randomUUID(),
      slug = 'role-' + suffix,
      now = new Date().toISOString(),
      owner = new ControlPlaneOwnership(handle!.pool, 'owner_refactor_test'),
      deadlines = new DeadlineQueue((e) => {
        throw e;
      }),
      presence = new ConnectionPresence((e) => {
        throw e;
      }),
      receipts: string[] = [],
      sessions: Array<{ id: string; addressId: string; token: string; engine: string }> = [];
    let hostId = 0,
      roleId = '',
      drain: (() => Promise<void>) | undefined;
    const oldFlags = await handle!.db
      .select()
      .from(schema.versions)
      .where(inArray(schema.versions.name, ['roles_enabled', 'agent_messaging_enabled']));
    try {
      const key = randomUUID(),
        [inserted] = await handle!.db
          .insert(schema.hosts)
          .values({
            fqdn: slug + '.test',
            apiKey: key,
            secure: 1,
            status: 'active',
            engines: 'codex,claude,grok',
            createdAt: now,
            updatedAt: now,
          })
          .$returningId();
      hostId = inserted!.id;
      for (const engine of ['codex', 'claude', 'grok']) {
        const id = randomUUID(),
          addressId = randomUUID(),
          token = randomUUID();
        sessions.push({ id, addressId, token, engine });
        await handle!.db.insert(schema.agentBusAddresses).values({
          id: addressId,
          address: 'agent:' + addressId,
          hostId,
          engine,
          username: 'root',
          cwd: '/roles',
          cwdHash: sha256('/roles'),
          currentSessionId: id,
          bindingGeneration: 1,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        });
        await handle!.db.insert(schema.agentSessions).values({
          id,
          hostId,
          engine,
          username: 'root',
          cwd: '/roles',
          invocationKind: 'native',
          status: 'ready',
          agentBusAddressId: addressId,
          bindingGeneration: 1,
          hostAuthFingerprint: sha256(key),
          bridgeTokenHash: sha256(token),
          bridgeExpiresAt: '2099-01-01T00:00:00.000Z',
          startedAt: now,
          heartbeatAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
      for (const name of ['roles_enabled', 'agent_messaging_enabled'])
        await handle!.db
          .insert(schema.versions)
          .values({ name, version: '1', updatedAt: now })
          .onDuplicateKeyUpdate({ set: { version: '1', updatedAt: now } });
      await owner.acquire();
      const { store } = await owner.hydrate((connection, epoch) =>
        hydrateOwnerState(drizzle(connection, { schema, mode: 'default' }), { epoch, sequence: 0n }),
      );
      owner.ready();
      const executor = new CommandExecutor({
        state: store,
        persistence: new OwnerPersistence(owner, testKeyring()),
        assertOwner: () => owner.assertReady(),
        loseOwner: (e) => owner.lose(e),
        committed: (r) => {
          receipts.push(r.id);
        },
        notificationError: (e) => {
          throw e;
        },
      });
      drain = () => executor.drain();
      const runtime: OwnerRuntime = {
        state: store,
        deadlines,
        assertOwner: () => owner.assertReady(),
        execute: (c) => executor.execute(c),
      };
      bindOwnerRuntime(handle!.db, runtime);
      bindOwnerPresence(runtime, presence);
      const roles = new RolesService({
          db: handle!.db,
          settings: new SettingsService(handle!.db),
          notifyOwned() {},
        }),
        actor = { kind: 'admin' as const, admin_user_id: 7 },
        manifest = `---\nname: ${slug}\nlabel: Reviewer\n---\nReview carefully.`;
      await roles.createRole({ slug, display_name: 'Owner role', summary: 'Atomic role lifecycle' }, actor);
      roleId = store
        .snapshot()
        .table('agentRoles')
        .all()
        .find((r) => r.slug === slug)!.id;
      await roles.saveDraft(
        slug,
        { manifest, files: [{ path: 'guide.md', content: 'Detailed guide', load: 'core' }] },
        actor,
      );
      await roles.publishDraft(slug, {}, actor);
      for (const session of sessions) {
        const activated = await roles.activate(session.id, session.token, {
          role: slug,
          reason: 'Operator assigned',
          client_request_id: randomUUID(),
        });
        expect(activated.role.version).toBe(1);
        expect(activated.core_files?.[0]?.text).toBe('Detailed guide');
      }
      const source = sessions[0]!,
        proposal = await roles.propose(source.id, source.token, {
          kind: 'file_add',
          title: 'Add reference',
          rationale: 'Reusable content',
          ops: [{ op: 'put', path: 'reference.md', content: 'Reference text' }],
          client_request_id: randomUUID(),
        });
      const prior = store.revision().sequence;
      const result = await roles.decide(
        proposal.proposal.id,
        { verdict: 'accept', reason: 'Reviewed', expected_version: proposal.proposal.version },
        actor,
      );
      expect('proposal' in result && result.proposal.status).toBe('applied');
      expect(store.revision().sequence).toBe(prior + 1n);
      const calls = vi.spyOn(handle!.db, 'select');
      for (const session of sessions)
        expect((await roles.current(session.id, session.token, {})).active).toBe(true);
      await roles.catalog();
      await roles.listAdmin();
      expect(calls).not.toHaveBeenCalled();
      calls.mockRestore();
      const before = store.snapshot();
      await executor.drain();
      await owner.close();
      const restarted = new ControlPlaneOwnership(handle!.pool, 'owner_refactor_test');
      try {
        await restarted.acquire();
        const after = await restarted.hydrate((connection, epoch) =>
          hydrateOwnerState(drizzle(connection, { schema, mode: 'default' }), { epoch, sequence: 0n }),
        );
        for (const table of [
          'agentRoles',
          'agentRoleVersions',
          'agentRoleAssignments',
          'agentRoleProposals',
        ] as const)
          for (const row of before
            .table(table)
            .all()
            .filter((r) => (table === 'agentRoles' ? r.id === roleId : 'roleId' in r && r.roleId === roleId)))
            expect(after.store.snapshot().table(table).get(row.id)).toEqual(row);
      } finally {
        await restarted.close();
      }
    } finally {
      await drain?.();
      presence.close();
      deadlines.close();
      await owner.close();
      if (roleId) {
        const versions = await handle!.db
            .select()
            .from(schema.agentRoleVersions)
            .where(eq(schema.agentRoleVersions.roleId, roleId)),
          proposals = await handle!.db
            .select()
            .from(schema.agentRoleProposals)
            .where(eq(schema.agentRoleProposals.roleId, roleId));
        if (versions.length)
          await handle!.db.delete(schema.agentRoleVersionFiles).where(
            inArray(
              schema.agentRoleVersionFiles.versionId,
              versions.map((v) => v.id),
            ),
          );
        if (proposals.length)
          await handle!.db.delete(schema.agentRoleProposalEvents).where(
            inArray(
              schema.agentRoleProposalEvents.proposalId,
              proposals.map((p) => p.id),
            ),
          );
        for (const table of [
          schema.agentRoleAssignments,
          schema.agentRoleProposals,
          schema.agentRoleVersions,
        ])
          await handle!.db.delete(table).where(eq(table.roleId, roleId));
        await handle!.db.delete(schema.agentRoles).where(eq(schema.agentRoles.id, roleId));
      }
      if (hostId) {
        await handle!.db.delete(schema.agentSessions).where(eq(schema.agentSessions.hostId, hostId));
        await handle!.db.delete(schema.agentBusAddresses).where(eq(schema.agentBusAddresses.hostId, hostId));
        await handle!.db.delete(schema.hosts).where(eq(schema.hosts.id, hostId));
      }
      for (const name of ['roles_enabled', 'agent_messaging_enabled']) {
        const prior = oldFlags.find((r) => r.name === name);
        if (prior) await handle!.db.update(schema.versions).set(prior).where(eq(schema.versions.name, name));
        else await handle!.db.delete(schema.versions).where(eq(schema.versions.name, name));
      }
      if (receipts.length)
        await handle!.db
          .delete(schema.controlPlaneCommandReceipts)
          .where(inArray(schema.controlPlaneCommandReceipts.requestId, receipts));
    }
  }, 60000);
});
