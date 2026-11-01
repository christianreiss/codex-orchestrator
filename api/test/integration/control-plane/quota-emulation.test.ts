import { DEFAULT_QUOTA_POLICY } from '../../../src/services/quota-policy.js';
import { stageSessionFinish } from '../../../src/control-plane/state/session-lifecycle.js';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { createOwnedControlPlane } from '../../../src/control-plane/bootstrap.js';
import { registerOwnedMessagingSession } from '../../../src/control-plane/state/session-registration.js';
import { mutateOwnerState } from '../../../src/control-plane/state/runtime.js';
import { stageUpdate } from '../../../src/control-plane/state/rows.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { stageEmulation } from '../../../src/services/quota-emulation.js';
import { quotaSnapshot } from '../../../src/services/quota-observation.js';
import { retryEmulatedWork } from '../../../src/services/quota-emulation-work.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const config = readDbConfig();
describe.skipIf(!config)('emulated quota ownership on MySQL', () => {
  it(
    'persists observation deltas, holds follow-up work and resumes its exact native session only when enabled',
    { timeout: 90000 },
    async () => {
      const pool = mysql.createPool({ ...config!, connectionLimit: 4 }),
        db = drizzle(pool, { schema, mode: 'default' }),
        keyring = testKeyring();
      const now = new Date().toISOString(),
        suffix = randomUUID(),
        ids: string[] = [],
        addresses: string[] = [],
        messageIds: string[] = [];
      const keys = ['agent_messaging_enabled', 'quota_emulation_codex'];
      const old = await db.select().from(schema.versions).where(inArray(schema.versions.name, keys));
      const emulation = { enabled: true, window_hours: 5, action: 'hard_stop', auto_resume: false };
      await db
        .insert(schema.versions)
        .values(
          keys.map((name) => ({
            name,
            version: name === keys[0] ? '1' : JSON.stringify(emulation),
            updatedAt: now,
          })),
        )
        .onDuplicateKeyUpdate({ set: { updatedAt: now } });
      for (const name of keys)
        await db
          .update(schema.versions)
          .set({ version: name === keys[0] ? '1' : JSON.stringify(emulation) })
          .where(eq(schema.versions.name, name));
      const [created] = await db.insert(schema.hosts).values({
        fqdn: `quota-${suffix}.test`,
        apiKey: `quota-fixture-${suffix}`,
        secure: 1,
        engines: 'codex',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const hostId = Number(created.insertId),
        [host] = await db.select().from(schema.hosts).where(eq(schema.hosts.id, hostId));
      const [account] = await db.insert(schema.providerAccounts).values({
        engine: 'codex',
        label: `quota-${suffix}`,
        state: 'enabled',
        createdAt: now,
        updatedAt: now,
      });
      const accountId = Number(account.insertId);
      let owner: Awaited<ReturnType<typeof createOwnedControlPlane>> | undefined;
      try {
        owner = await createOwnedControlPlane({
          pool,
          handle: db,
          env: { ...loadTestEnv(), DB_DATABASE: String(config!.database) },
          keyring,
          error: (error) => {
            throw error;
          },
        });
        const bus = new AgentMessagingService(db, loadTestEnv(), keyring);
        const tokens: string[] = [];
        for (let n = 0; n < 2; n++) {
          const id = randomUUID(),
            token = `quota-bridge-${randomUUID()}-${randomUUID()}`,
            native = randomUUID(),
            instance = randomUUID();
          ids.push(id);
          tokens.push(token);
          await registerOwnedMessagingSession(
            owner.runtime,
            host!,
            {
              sessionId: id,
              bridgeToken: token,
              engine: 'codex',
              username: 'fixture',
              cwd: '/fixture',
              invocationKind: 'interactive',
              upstreamSessionId: native,
              adapterProtocol: 'codex-queue-v1',
              adapterCapabilities: { execution_contract_version: 2, control_state_protocol: 1 },
            },
            loadTestEnv(),
          );
          addresses.push(owner.runtime.state.snapshot().sessions.get(id)!.agentBusAddressId!);
          await mutateOwnerState(owner.runtime, {
            kind: 'fixture.native',
            payload: { id },
            prepare(ctx) {
              stageUpdate(ctx, 'agentSessions', id, { providerAccountId: accountId });
              const row = {
                sessionId: id,
                instanceId: instance,
                bindingGeneration: 1,
                requestId: null,
                clientMessageId: null,
                actorId: null,
                status: 'ready',
                updatedAt: now,
              };
              ctx.draft.upsert('agentNativeControls', row);
              ctx.write((tx) => tx.insert(schema.agentNativeControls).values(row));
              return null;
            },
          });
          owner.presence.attach({
            connectionId: randomUUID(),
            hostId,
            username: 'fixture',
            scope: { topic: 'session', session_id: id, binding_generation: 1, native_instance_id: instance },
          });
        }
        const observe = async (used: number, time: string) => {
          const values = {
            accountId,
            status: 'ok',
            fetchedAt: time,
            nextEligibleAt: time,
            createdAt: time,
            primaryUsedPercent: used,
            primaryLimitSeconds: 604800,
            primaryResetAt: new Date(Date.now() + 86400000).toISOString(),
          };
          // Keep the provider reset fixed across samples.
          values.primaryResetAt = new Date(Date.parse(now) + 86400000).toISOString();
          await mutateOwnerState(owner!.runtime, {
            kind: 'fixture.observation',
            payload: { used, time },
            prepare(ctx) {
              stageEmulation(ctx, 'codex', values);
              ctx.write(async (tx) => {
                const [r] = await tx.insert(schema.chatgptUsageSnapshots).values(values);
                const [row] = await tx
                  .select()
                  .from(schema.chatgptUsageSnapshots)
                  .where(eq(schema.chatgptUsageSnapshots.id, Number(r.insertId)));
                ctx.draft.upsert('chatgptUsageSnapshots', row!);
              });
              return null;
            },
          });
        };
        await observe(20, new Date(Date.parse(now) - 1000).toISOString());
        await observe(24, now);
        expect((await quotaSnapshot(db, accountId, 'codex'))?.short?.used_percent).toBeGreaterThan(100);
        const [persisted] = await db
          .select()
          .from(schema.quotaEmulationStates)
          .where(eq(schema.quotaEmulationStates.accountId, accountId));
        expect(persisted?.consumedPercent).toBe(4);
        const sent = await bus.sendMessage(ids[0]!, tokens[0]!, {
          to: `agent:${addresses[1]}`,
          content: 'Continue the authorized fixture task',
          kind: 'request',
          clientMessageId: randomUUID(),
        });
        const messageId = String((sent.message as { id: string }).id);
        messageIds.push(messageId);
        expect(await bus.claimForSession(ids[1]!, tokens[1]!, randomUUID())).toBeNull();
        const wait = owner.runtime.state.snapshot().messages.get(messageId)!.quotaEmulationWait!;
        expect(wait.account_id).toBe(accountId);
        await expect(retryEmulatedWork(db, messageId, 'fixture')).rejects.toMatchObject({
          code: 'quota_emulation_limit',
        });
        const reset = new Date(Date.now() - 1000).toISOString();
        await mutateOwnerState(owner.runtime, {
          kind: 'fixture.reset',
          payload: { reset },
          prepare(ctx) {
            stageUpdate(ctx, 'quotaEmulationStates', accountId, { resetsAt: reset });
            stageUpdate(ctx, 'agentBusMessages', messageId, {
              nextAttemptAt: reset,
              quotaEmulationWait: { ...wait, reset_at: reset },
            });
            return null;
          },
        });
        expect(await bus.claimForSession(ids[1]!, tokens[1]!, randomUUID())).toBeNull();
        await mutateOwnerState(owner.runtime, {
          kind: 'fixture.resume-on',
          payload: {},
          prepare(ctx) {
            stageUpdate(ctx, 'versions', 'quota_emulation_codex', {
              version: JSON.stringify({ ...emulation, auto_resume: true }),
            });
            return null;
          },
        });
        const claim = randomUUID();
        const delivery = await bus.claimForSession(ids[1]!, tokens[1]!, claim);
        expect(delivery).toMatchObject({ message_id: messageId, claim_id: claim });
        const leased = owner.runtime.state.snapshot().messages.get(messageId)!;
        expect(leased.deliveryUpstreamSessionId).toBe(wait.native_session_id);
        expect(leased.quotaEmulationWait).toBeNull();
        await bus.acknowledgeSessionDelivery(ids[1]!, tokens[1]!, messageId, {
          claimId: claim,
          outcome: 'accepted',
        });
        expect(await bus.claimForSession(ids[1]!, tokens[1]!, randomUUID())).toBeNull();
        await bus.acknowledgeSessionDelivery(ids[1]!, tokens[1]!, messageId, {
          claimId: claim,
          outcome: 'completed',
          taskResult: { status: 'succeeded', summary: 'Verified fixture action' },
        });
        await observe(28, new Date(Date.parse(now) + 1000).toISOString());
        const next = await bus.sendMessage(ids[0]!, tokens[0]!, {
          to: `agent:${addresses[1]}`,
          content: 'Next authorized fixture task',
          kind: 'request',
          clientMessageId: randomUUID(),
        });
        const nextId = String((next.message as { id: string }).id);
        messageIds.push(nextId);
        await mutateOwnerState(owner.runtime, {
          kind: 'fixture.resume-off',
          payload: {},
          prepare(ctx) {
            stageUpdate(ctx, 'versions', 'quota_emulation_codex', { version: JSON.stringify(emulation) });
            return null;
          },
        });
        expect(await bus.claimForSession(ids[1]!, tokens[1]!, randomUUID())).toBeNull();
        const nextWait = owner.runtime.state.snapshot().messages.get(nextId)!.quotaEmulationWait!;
        await mutateOwnerState(owner.runtime, {
          kind: 'fixture.manual-reset',
          payload: {},
          prepare(ctx) {
            stageUpdate(ctx, 'quotaEmulationStates', accountId, { resetsAt: reset });
            stageUpdate(ctx, 'agentBusMessages', nextId, {
              nextAttemptAt: reset,
              quotaEmulationWait: { ...nextWait, reset_at: reset },
            });
            return null;
          },
        });
        expect(await bus.claimForSession(ids[1]!, tokens[1]!, randomUUID())).toBeNull();
        await mutateOwnerState(owner.runtime, {
          kind: 'fixture.unlimited',
          payload: {},
          prepare(ctx) {
            stageUpdate(ctx, 'versions', 'quota_emulation_codex', {
              version: JSON.stringify({ ...emulation, auto_resume: true }),
            });
            const row = {
              name: `quota_policy_account_${accountId}`,
              version: JSON.stringify({ ...DEFAULT_QUOTA_POLICY, unlimited: true }),
              updatedAt: now,
            };
            ctx.draft.upsert('versions', row);
            ctx.write((tx) => tx.insert(schema.versions).values(row));
            return null;
          },
        });
        expect(await bus.claimForSession(ids[1]!, tokens[1]!, randomUUID())).toBeNull();
        await mutateOwnerState(owner.runtime, {
          kind: 'fixture.metered',
          payload: {},
          prepare(ctx) {
            stageUpdate(ctx, 'versions', 'quota_emulation_codex', { version: JSON.stringify(emulation) });
            ctx.draft.remove('versions', `quota_policy_account_${accountId}`);
            ctx.write((tx) =>
              tx.delete(schema.versions).where(eq(schema.versions.name, `quota_policy_account_${accountId}`)),
            );
            return null;
          },
        });
        await retryEmulatedWork(db, nextId, 'fixture');
        expect(owner.runtime.state.snapshot().messages.get(nextId)?.quotaEmulationWait?.manual_resume).toBe(
          true,
        );
        const manualClaim = randomUUID();
        expect(await bus.claimForSession(ids[1]!, tokens[1]!, manualClaim)).toMatchObject({
          message_id: nextId,
        });
        await bus.acknowledgeSessionDelivery(ids[1]!, tokens[1]!, nextId, {
          claimId: manualClaim,
          outcome: 'accepted',
        });
        await bus.acknowledgeSessionDelivery(ids[1]!, tokens[1]!, nextId, {
          claimId: manualClaim,
          outcome: 'completed',
          taskResult: { status: 'succeeded', summary: 'Manually resumed only the held work' },
        });
        await observe(32, new Date(Date.parse(now) + 2000).toISOString());
        const last = await bus.sendMessage(ids[0]!, tokens[0]!, {
          to: `agent:${addresses[1]}`,
          content: 'A final task that the operator cancels',
          kind: 'request',
          clientMessageId: randomUUID(),
        });
        const lastId = String((last.message as { id: string }).id);
        messageIds.push(lastId);
        expect(await bus.claimForSession(ids[1]!, tokens[1]!, randomUUID())).toBeNull();
        expect(owner.runtime.state.snapshot().messages.get(lastId)?.quotaEmulationWait).not.toBeNull();
        await mutateOwnerState(owner.runtime, {
          kind: 'fixture.user-stop',
          payload: {},
          prepare(ctx) {
            stageSessionFinish(
              ctx,
              { ...ctx.snapshot.sessions.get(ids[1]!)! },
              'completed',
              new Date().toISOString(),
              'user_stop',
            );
            return null;
          },
        });
        expect(owner.runtime.state.snapshot().messages.get(lastId)?.status).toBe('canceled');
        // A restart must hydrate the same consumed budget and the accepted delivery.
        await owner.close();
        owner = undefined;
        owner = await createOwnedControlPlane({
          pool,
          handle: drizzle(pool, { schema, mode: 'default' }),
          env: { ...loadTestEnv(), DB_DATABASE: String(config!.database) },
          keyring,
          error: (error) => {
            throw error;
          },
        });
        expect(
          owner.runtime.state.snapshot().table('quotaEmulationStates').get(accountId)?.consumedPercent,
        ).toBe(4);
        expect(owner.runtime.state.snapshot().messages.get(messageId)?.taskResultStatus).toBe('succeeded');
      } finally {
        await owner?.close();
        await db
          .delete(schema.agentTaskResults)
          .where(inArray(schema.agentTaskResults.messageId, messageIds));
        await db
          .delete(schema.agentBusMessages)
          .where(inArray(schema.agentBusMessages.targetAddressId, addresses));
        await db
          .delete(schema.agentBusConversations)
          .where(eq(schema.agentBusConversations.createdByAddressId, addresses[0] ?? ''));
        await db.delete(schema.agentNativeControls).where(inArray(schema.agentNativeControls.sessionId, ids));
        await db.delete(schema.agentNameLeases).where(inArray(schema.agentNameLeases.sessionId, ids));
        await db
          .update(schema.agentNamePool)
          .set({ currentSessionId: null })
          .where(inArray(schema.agentNamePool.currentSessionId, ids));
        await db.delete(schema.agentSessions).where(inArray(schema.agentSessions.id, ids));
        await db.delete(schema.agentBusAddresses).where(inArray(schema.agentBusAddresses.id, addresses));
        await db
          .delete(schema.chatgptUsageSnapshots)
          .where(eq(schema.chatgptUsageSnapshots.accountId, accountId));
        await db
          .delete(schema.quotaEmulationStates)
          .where(eq(schema.quotaEmulationStates.accountId, accountId));
        await db.delete(schema.providerAccounts).where(eq(schema.providerAccounts.id, accountId));
        await db.delete(schema.hosts).where(eq(schema.hosts.id, hostId));
        await db.delete(schema.versions).where(eq(schema.versions.name, `quota_policy_account_${accountId}`));
        for (const name of keys) {
          const row = old.find((r) => r.name === name);
          if (row)
            await db
              .update(schema.versions)
              .set({ version: row.version })
              .where(eq(schema.versions.name, name));
          else await db.delete(schema.versions).where(eq(schema.versions.name, name));
        }
        await pool.end();
      }
    },
  );
});
