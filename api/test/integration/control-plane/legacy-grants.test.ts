import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createOwnedControlPlane } from '../../../src/control-plane/bootstrap.js';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/mysql2';
import { and, eq, inArray } from 'drizzle-orm';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { installSqlBudget } from '../../helpers/sql-budget.js';
import * as schema from '../../../src/db/schema.js';
import { ControlPlaneOwnership } from '../../../src/control-plane/owner.js';
import { OwnerPersistence } from '../../../src/control-plane/persistence.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { ConnectionPresence, bindOwnerPresence } from '../../../src/control-plane/presence.js';
import {
  captureLegacyDrainManifest,
  LegacyDrainRegistry,
  type LegacyDrainRecord,
} from '../../../src/control-plane/legacy-drain.js';
import { hydrateOwnerState } from '../../../src/control-plane/state/hydrate.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { AgentCoordination } from '../../../src/services/agent-coordination/index.js';
import type { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { sha256 } from '../../../src/security/hash.js';

const handle = await getTestDb();
describe.skipIf(!handle)('captured legacy resource grants on real MySQL', () => {
  afterAll(async () => {
    await handle?.pool.end();
  });
  it(
    'renews only the captured owner, excludes a competitor, commits release and preserves it across restart',
    { timeout: 90000 },
    async () => {
      const suffix = randomUUID(),
        now = new Date().toISOString(),
        key = 'fixture-' + suffix;
      const ids = [randomUUID(), randomUUID()],
        addresses = [randomUUID(), randomUUID()],
        instances = [randomUUID(), randomUUID()];
      const tokens = ids.map((id) => 'bridge-' + id),
        grantId = randomUUID(),
        path = '/fixture/' + suffix;
      const commands: string[] = [];
      const captureDirectory=process.env.OWNER_CAPTURE_TEST_DIRECTORY;
      const cloneId=randomUUID(),worktreeId=randomUUID();
      const flags = ['agent_messaging_enabled', 'agent_coordination_enabled'];
      const previous = await handle!.db
        .select()
        .from(schema.versions)
        .where(inArray(schema.versions.name, flags));
      const [inserted] = await handle!.db
        .insert(schema.hosts)
        .values({
          fqdn: `drain-${suffix}.test`,
          apiKey: key,
          apiKeyHash: sha256(key),
          secure: 1,
          status: 'active',
          engines: 'codex',
          createdAt: now,
          updatedAt: now,
        });
      const hostId = Number(inserted.insertId);
      let active: Awaited<ReturnType<typeof start>> | undefined;
      let manifest: LegacyDrainRecord[] | undefined;
      const budget = installSqlBudget(handle!.pool);
      async function start() {
        if(captureDirectory){
          const db=drizzle(handle!.pool,{schema,mode:'default'});
          const boot=await createOwnedControlPlane({pool:handle!.pool,handle:db,env:{...loadTestEnv(),DB_DATABASE:'owner_refactor_test',DATA_ROOT:captureDirectory},keyring:testKeyring(),committed:receipt=>{commands.push(receipt.id);},error:error=>{throw error;}});
          const service=new AgentCoordination(db,loadTestEnv(),testKeyring(),{} as AgentMessagingService);
          expect(boot.legacyDrain.gitRegistration(worktreeId,ids[0]!,1)).toBe(true);
          return {runtime:boot.runtime,service,presence:boot.presence,registry:boot.legacyDrain,close:boot.close};
        }

        const ownership = new ControlPlaneOwnership(handle!.pool, 'owner_refactor_test');
        const deadlines = new DeadlineQueue((error) => {
          throw error;
        });
        await ownership.acquire();
        const hydrated = await ownership.hydrate(async (connection, epoch) => {
          const db = drizzle(connection, { schema, mode: 'default' });
          const before = await hydrateOwnerState(db, { epoch, sequence: 0n }, { keyring: testKeyring() });
          manifest ??= captureLegacyDrainManifest(before.store.snapshot(), Date.now(), {
            resourceClaimIds: [grantId],
          });
          await db
            .update(schema.agentResourceClaims)
            .set({ state: 'uncertain', uncertaintyReason: 'owner_restart' })
            .where(
              and(eq(schema.agentResourceClaims.id, grantId), eq(schema.agentResourceClaims.state, 'active')),
            );
          return hydrateOwnerState(db, { epoch, sequence: 0n }, { keyring: testKeyring() });
        });
        ownership.ready();
        const executor = new CommandExecutor({
          state: hydrated.store,
          persistence: new OwnerPersistence(ownership, testKeyring()),
          assertOwner: () => ownership.assertReady(),
          loseOwner: (error) => ownership.lose(error),
          notificationError: (error) => {
            throw error;
          },
          committed: (receipt) => {
            commands.push(receipt.id);
          },
        });
        const runtime: OwnerRuntime = {
          state: hydrated.store,
          deadlines,
          assertOwner: () => ownership.assertReady(),
          execute: (command) => executor.execute(command),
        };
        const db = drizzle(handle!.pool, { schema, mode: 'default' });
        bindOwnerRuntime(db, runtime);
        const presence = new ConnectionPresence((error) => {
          throw error;
        });
        bindOwnerPresence(runtime, presence);
        const registry = new LegacyDrainRegistry(runtime, manifest!, { session: 600000, relay: 600000 });
        const service = new AgentCoordination(db, loadTestEnv(), testKeyring(), {} as AgentMessagingService);
        return {
          runtime,
          service,
          presence,
          registry,
          async close() {
            await executor.drain();
            registry.close();
            presence.close();
            deadlines.close();
            await ownership.close();
          },
        };
      }
      try {
        for (const name of flags)
          await handle!.db
            .insert(schema.versions)
            .values({ name, version: '1', updatedAt: now })
            .onDuplicateKeyUpdate({ set: { version: '1' } });
        for (let n = 0; n < 2; n++) {
          await handle!.db
            .insert(schema.agentSessions)
            .values({
              id: ids[n]!,
              hostId,
              agentBusAddressId: addresses[n]!,
              engine: 'codex',
              username: 'fixture',
              cwd: path,
              invocationKind: 'interactive',
              status: 'idle',
              bindingGeneration: 1,
              hostAuthFingerprint: sha256(sha256(key)),
              bridgeTokenHash: sha256(tokens[n]!),
              bridgeExpiresAt: new Date(Date.now() + 600000).toISOString(),
              startedAt: now,
              heartbeatAt: now,
              createdAt: now,
              updatedAt: now,
              adapterCapabilities: { scope_protocol_version: 1, ...(n ? { control_state_protocol: 1 } : {}) },
            });
          await handle!.db
            .insert(schema.agentBusAddresses)
            .values({
              id: addresses[n]!,
              address: `agent:${addresses[n]}`,
              hostId,
              engine: 'codex',
              username: 'fixture',
              cwd: path,
              cwdHash: sha256(path),
              currentSessionId: ids[n]!,
              bindingGeneration: 1,
              lastSeenAt: now,
              createdAt: now,
              updatedAt: now,
            });
          await handle!.db
            .insert(schema.agentNativeControls)
            .values({
              sessionId: ids[n]!,
              instanceId: instances[n]!,
              bindingGeneration: 1,
              status: 'ready',
              updatedAt: now,
            });
        }
        await handle!.db
          .insert(schema.agentResourceClaims)
          .values({
            id: grantId,
            sessionId: ids[0]!,
            generation: 1,
            requestId: randomUUID(),
            purpose: 'operation running at cutover',
            resources: [{ kind: 'path', host_id: hostId, path }],
            state: 'active',
            blockers: [],
            ownershipMode: 'timed',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            createdAt: now,
            updatedAt: now,
          });
        if(captureDirectory){
          await handle!.db.insert(schema.gitClones).values({id:cloneId,hostId,cloneKey:sha256(path+'/.git'),cloneDir:path+'/.git',repoRoot:path,firstSeenAt:now,lastSeenAt:now,createdAt:now,updatedAt:now});
          await handle!.db.insert(schema.gitWorktrees).values({id:worktreeId,cloneId,hostId,worktreePath:path,worktreeHash:sha256(path),username:'fixture',engine:'codex',agentBusAddressId:addresses[0],agentSessionId:ids[0],agentBindingGeneration:1,status:'active',ownershipMode:'timed',registeredAt:now,heartbeatAt:now,expiresAt:new Date(Date.now()+60000).toISOString(),createdAt:now,updatedAt:now});
          await writeFile(join(captureDirectory,'ready'),JSON.stringify({grantId,worktreeId}));
          const deadline=Date.now()+60000;
          for(;;){try{await access(join(captureDirectory,'.control-plane-legacy-drain.json'));break;}catch{if(Date.now()>=deadline)throw new Error('External Python capture did not complete');await new Promise(resolve=>setTimeout(resolve,100));}}
        }
        active = await start();
        expect(active.runtime.state.snapshot().claims.get(grantId)?.state).toBe('uncertain');
        const recovered = await active.service.claims.status(ids[0]!, tokens[0]!, {
          claim_id: grantId,
          renew: true,
        });
        expect(recovered).toMatchObject({ state: 'active', ownership_mode: 'timed' });
        budget.reset();
        for (let n = 0; n < 10; n++)
          await active.service.claims.status(ids[0]!, tokens[0]!, { claim_id: grantId, renew: true });
        expect(budget.snapshot()).toEqual([]);
        active.presence.attach({
          connectionId: randomUUID(),
          hostId,
          username: 'fixture',
          scope: {
            topic: 'session',
            session_id: ids[1]!,
            binding_generation: 1,
            native_instance_id: instances[1]!,
          },
        });
        const competing = await active.service.claims.acquire(ids[1]!, tokens[1]!, {
          client_request_id: randomUUID(),
          purpose: 'competing operation',
          resources: [{ kind: 'path', host_id: hostId, path }],
        });
        expect(competing.state).toBe('waiting');
        await active.service.claims.release(ids[0]!, tokens[0]!, {
          claim_id: grantId,
          outcome: 'completed',
          reason: 'original operation ended',
        });
        const [persisted] = await handle!.db
          .select()
          .from(schema.agentResourceClaims)
          .where(eq(schema.agentResourceClaims.id, grantId));
        expect(persisted?.state).toBe('released');
        expect(
          (await active.service.claims.status(ids[1]!, tokens[1]!, { claim_id: competing.id, renew: true }))
            .state,
        ).toBe('active');
        await active.close();
        active = await start();
        expect(active.runtime.state.snapshot().claims.get(grantId)?.state).toBe('released');
        expect(active.registry.resourceClaim(grantId, ids[0]!, 1)).toBe(false);
      } finally {
        await active?.close();
        budget.restore();
        await handle!.db.delete(schema.gitWorktrees).where(eq(schema.gitWorktrees.id,worktreeId));
        await handle!.db.delete(schema.gitClones).where(eq(schema.gitClones.id,cloneId));
        await handle!.db
          .delete(schema.agentResourceClaims)
          .where(inArray(schema.agentResourceClaims.sessionId, ids));
        const scopes = await handle!.db
          .select({ id: schema.agentScopeMembers.scopeId })
          .from(schema.agentScopeMembers)
          .where(inArray(schema.agentScopeMembers.sessionId, ids));
        await handle!.db
          .delete(schema.agentScopeMembers)
          .where(inArray(schema.agentScopeMembers.sessionId, ids));
        await handle!.db.delete(schema.agentScopeEvents).where(inArray(schema.agentScopeEvents.actor, ids));
        for (const { id } of scopes) {
          const remaining = await handle!.db
            .select({ id: schema.agentScopeMembers.id })
            .from(schema.agentScopeMembers)
            .where(eq(schema.agentScopeMembers.scopeId, id))
            .limit(1);
          if (!remaining.length)
            await handle!.db.delete(schema.agentScopes).where(eq(schema.agentScopes.id, id));
        }
        await handle!.db
          .delete(schema.agentNativeControls)
          .where(inArray(schema.agentNativeControls.sessionId, ids));
        await handle!.db.delete(schema.agentSessions).where(inArray(schema.agentSessions.id, ids));
        await handle!.db
          .delete(schema.agentBusAddresses)
          .where(inArray(schema.agentBusAddresses.id, addresses));
        await handle!.db.delete(schema.hosts).where(eq(schema.hosts.id, hostId));
        if (commands.length)
          await handle!.db
            .delete(schema.controlPlaneCommandReceipts)
            .where(inArray(schema.controlPlaneCommandReceipts.requestId, commands));
        for (const name of flags) {
          const old = previous.find((row) => row.name === name);
          if (old)
            await handle!.db
              .update(schema.versions)
              .set({ version: old.version })
              .where(eq(schema.versions.name, name));
          else await handle!.db.delete(schema.versions).where(eq(schema.versions.name, name));
        }
      }
    },
  );
});
