import { randomBytes, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, inArray, or } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { AGENT_MESSAGING_ENABLED_KEY, AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { relayIdleProof } from '../../../src/services/agent-messaging/relay-idle.js';
import { invalidateFleetEngineState } from '../../../src/services/engine-switch.js';
import { ENGINES } from '../../../src/util/engine.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { preparePeerBatch } from '../../../src/services/agent-messaging/peer-batch.js';
import { relayLongPoll } from '../../../src/http/relay-long-poll.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { sha256 } from '../../../src/security/hash.js';
import { SERVER_ADDRESS_ID } from '../../../src/services/agent-messaging/groups.js';
import { markPersistentHost, persistRelayUsers } from '../../helpers/persistent-host.js';

// Every bus transaction starts with the exclusive row lock on the enable flag; production relays polled it ~50 times a
// second to find nothing. These tests pin what an idle relay poll may skip (the lock) and what it may never skip.
const config = readDbConfig();
const SETTLE_MS = 1_500;

describe.skipIf(!config)(
  'relay claim polling against the exclusive enable-flag lock',
  { timeout: 60_000 },
  () => {
    // Two connections: a handful of polls that pinned them while waiting for the flag would starve every other query,
    // which is how an unrelated bootstrap request stalled in production.
    const pool = mysql.createPool({ ...config, connectionLimit: 2 });
    const queries: string[] = [];
    const db = drizzle(pool, { schema, mode: 'default', logger: { logQuery(query) { queries.push(query); } } });
    const fqdn = `relay-idle-poll-${randomUUID()}.test`;
    let service: AgentMessagingService;
    let host: typeof schema.hosts.$inferSelect;
    let priorFlag: string | undefined;
    const holders: mysql.Connection[] = [];
    let createdServer = false;

    beforeAll(async () => {
      const now = new Date().toISOString();
      await db.insert(schema.hosts).values({
        fqdn,
        apiKey: randomBytes(32).toString('hex'),
        status: 'active',
        secure: 1,
        engines: ENGINES.join(','),
        agentMessagingEnabled: 1,
        createdAt: now,
        updatedAt: now,
      });
      host = (await db.select().from(schema.hosts).where(eq(schema.hosts.fqdn, fqdn)))[0]!;
      await markPersistentHost(db, host.id);
      priorFlag = (
        await db.select().from(schema.versions).where(eq(schema.versions.name, AGENT_MESSAGING_ENABLED_KEY))
      )[0]?.version;
      for (const engine of ENGINES) {
        await db
          .insert(schema.versions)
          .values({ name: `${engine}_engine_disabled`, version: '0', updatedAt: now })
          .onDuplicateKeyUpdate({ set: { version: '0' } });
      }
      invalidateFleetEngineState(db);
      service = persistRelayUsers(db, new AgentMessagingService(db, loadTestEnv(), testKeyring()));
    });

    beforeEach(async () => {
      await setFlag('1');
    });

    afterAll(async () => {
      for (const holder of holders.splice(0)) await holder.end().catch(() => undefined);
      if (host) {
        const addresses = await db
          .select({ id: schema.agentBusAddresses.id })
          .from(schema.agentBusAddresses)
          .where(eq(schema.agentBusAddresses.hostId, host.id));
        const ids = addresses.map((a) => a.id);
        if (ids.length) {
          await db
            .delete(schema.agentBusMessages)
            .where(inArray(schema.agentBusMessages.targetAddressId, ids));
          await db
            .delete(schema.agentBusMessages)
            .where(inArray(schema.agentBusMessages.senderAddressId, ids));
        }
        if (ids.length) {
          await db
            .delete(schema.agentBusConversations)
            .where(
              or(
                inArray(schema.agentBusConversations.addressAId, ids),
                inArray(schema.agentBusConversations.addressBId, ids),
              ),
            );
        }
        await db.delete(schema.logs).where(eq(schema.logs.hostId, host.id));
        await db.delete(schema.agentBusRelays).where(eq(schema.agentBusRelays.hostId, host.id));
        await db.delete(schema.agentSessions).where(eq(schema.agentSessions.hostId, host.id));
        await db.delete(schema.agentBusAddresses).where(eq(schema.agentBusAddresses.hostId, host.id));
        await db.delete(schema.hosts).where(eq(schema.hosts.id, host.id));
      }
      if (priorFlag !== undefined) await setFlag(priorFlag);
      if (createdServer) await db.delete(schema.agentBusAddresses).where(eq(schema.agentBusAddresses.id, SERVER_ADDRESS_ID));
      await pool.end();
    });

    async function setFlag(value: string): Promise<void> {
      await db
        .insert(schema.versions)
        .values({ name: AGENT_MESSAGING_ENABLED_KEY, version: value, updatedAt: new Date().toISOString() })
        .onDuplicateKeyUpdate({ set: { version: value } });
    }

    /** Holds the flag row exclusively from a connection outside the service's pool, like an in-flight bus writer or toggle. */
    async function holdFlagLock(newValue?: string): Promise<{ release: () => Promise<void> }> {
      const conn = await mysql.createConnection({ ...config });
      holders.push(conn);
      await conn.beginTransaction();
      await conn.query('SELECT version FROM versions WHERE name = ? FOR UPDATE', [
        AGENT_MESSAGING_ENABLED_KEY,
      ]);
      if (newValue !== undefined)
        await conn.query('UPDATE versions SET version = ? WHERE name = ?', [
          newValue,
          AGENT_MESSAGING_ENABLED_KEY,
        ]);
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          await conn.commit();
          await conn.end();
          holders.splice(holders.indexOf(conn), 1);
        },
      };
    }

    /** Resolves with the outcome if `promise` settles within `ms`, otherwise with 'pending'. */
    async function settledWithin<T>(
      promise: Promise<T>,
      ms: number,
    ): Promise<{ value: T } | { error: unknown } | 'pending'> {
      const outcome = promise.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      return await Promise.race([
        outcome,
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms)),
      ]);
    }

    async function register(label: string, upstreamSessionId?: string) {
      const sessionId = randomUUID();
      const bridgeToken = randomBytes(32).toString('base64url');
      const username = `relay-idle-${label}-${randomUUID().slice(0, 8)}`;
      const result = await service.registerSession(host, {
        engine: 'claude',
        username,
        cwd: `/tmp/${username}`,
        upstreamSessionId,
        invocationKind: 'interactive',
        sessionId,
        bridgeToken,
        adapterProtocol: 'test-live-v1',
        adapterCapabilities: { test: true, execution_contract_version: 2 },
      });
      const address = result.address as Record<string, unknown>;
      return {
        sessionId,
        bridgeToken,
        username,
        address: String(address.address),
        addressId: String(address.id),
      };
    }

    /** An offline address with a native transcript, so relay mail to it is claimable, plus the relay that serves it. */
    async function offlineTargetWithRelay(label: string) {
      const target = await register(label, randomUUID());
      await service.finishSession(target.sessionId, target.bridgeToken, 'completed');
      const relay = await service.registerRelay(host, {
        username: target.username,
        instanceId: randomUUID(),
        wrapperVersion: 'test',
        capabilities: { execution_contract_version: 2 },
      });
      return { target, relayId: String(relay.relay_id), token: String(relay.relay_token) };
    }

    async function messageRow(id: string) {
      return (await db.select().from(schema.agentBusMessages).where(eq(schema.agentBusMessages.id, id)))[0]!;
    }

    async function serverAddress() {
      if (!(await db.select().from(schema.agentBusAddresses).where(eq(schema.agentBusAddresses.id, SERVER_ADDRESS_ID)))[0]) {
        const now = new Date().toISOString();
        await db.insert(schema.agentBusAddresses).values({ id: SERVER_ADDRESS_ID, address: `agent:${SERVER_ADDRESS_ID}`,
          hostId: 0, engine: 'server', username: 'Server', cwd: '/', cwdHash: sha256('/'), continuity: 'server',
          readiness: 'offline', lastSeenAt: now, createdAt: now, updatedAt: now });
        createdServer = true;
      }
      return (await db.select().from(schema.agentBusAddresses).where(eq(schema.agentBusAddresses.id, SERVER_ADDRESS_ID)))[0]!;
    }

    async function queuedBatch(label: string) {
      const source = await register(`${label}-source`);
      const relay = await offlineTargetWithRelay(label);
      const originals: string[] = [];
      for (let i = 0; i < 2; i++) {
        const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
          to: relay.target.address, content: `${label}-${i}`, clientMessageId: randomUUID(),
        });
        originals.push(String((sent.message as Record<string, unknown>).id));
      }
      await db.update(schema.agentBusMessages).set({ createdAt: new Date(Date.now() - 120000).toISOString() })
        .where(inArray(schema.agentBusMessages.id, originals));
      const server = await serverAddress();
      const [targetRow] = await db.select().from(schema.agentBusAddresses).where(eq(schema.agentBusAddresses.id, relay.target.addressId));
      await service.coordinationTransaction(null, null, tx => preparePeerBatch(tx, targetRow!, { keyring: testKeyring(), server: async () => server }));
      const [root] = await db.select().from(schema.agentBusMessages).where(inArray(schema.agentBusMessages.id,
        [(await messageRow(originals[0]!)).digestId!]));
      if (!root) throw new Error('Expected a peer-batch fixture');
      return { ...relay, source, originals, root };
    }

    it('restores an unpresented digest head so a dormant relay can claim originals in order', async () => {
      const batch = await queuedBatch('digest-head');
      const later = await service.sendMessage(batch.source.sessionId, batch.source.bridgeToken, {
        to: batch.target.address, content: 'later', clientMessageId: randomUUID(),
      });
      const expected = [...batch.originals, String((later.message as Record<string, unknown>).id)];
      const before = await Promise.all(batch.originals.map(messageRow));
      for (const id of expected) {
        const claimId = randomUUID();
        expect(await service.claimForRelay(batch.relayId, batch.token, claimId)).toMatchObject({ message_id: id });
        await service.acknowledgeRelayDelivery(batch.relayId, batch.token, id, { claimId, outcome: 'completed' });
      }
      expect(await messageRow(batch.root.id)).toMatchObject({ status: 'canceled', contentEnc: batch.root.contentEnc });
      for (let i = 0; i < before.length; i++) expect(await messageRow(before[i]!.id))
        .toMatchObject({ digestId: null, dispatchOrder: before[i]!.dispatchOrder, contentEnc: before[i]!.contentEnc });
    });

    it.each(['expired', 'dead', 'canceled'])('restores %s digest members even when no ordinary queued row remains', async status => {
      const batch = await queuedBatch(`terminal-${status}`);
      await db.update(schema.agentBusMessages).set({ status }).where(eq(schema.agentBusMessages.id, batch.root.id));
      expect(await service.relayIdle(batch.relayId, batch.token)).toBe(false);
      expect(await service.claimForRelay(batch.relayId, batch.token, randomUUID())).toMatchObject({ message_id: batch.originals[0] });
      expect(await messageRow(batch.root.id)).toMatchObject({ status });
      expect(await messageRow(batch.originals[1]!)).toMatchObject({ status: 'queued', digestId: null });
    });

    it.each(['acceptedAt', 'presentedAt', 'ambiguousAt'] as const)('never restores a digest with %s evidence', async marker => {
      const batch = await queuedBatch(`protected-${marker}`);
      await db.update(schema.agentBusMessages).set({ [marker]: new Date().toISOString() }).where(eq(schema.agentBusMessages.id, batch.root.id));
      const before = await messageRow(batch.root.id);
      expect(await service.claimForRelay(batch.relayId, batch.token, randomUUID())).toBeNull();
      expect(await messageRow(batch.root.id)).toEqual(before);
      for (const id of batch.originals) expect(await messageRow(id)).toMatchObject({ status: 'batched', digestId: batch.root.id });
    });

    it('preserves a live leased digest despite changed members and restores it only after lease expiry', async () => {
      const batch = await queuedBatch('live-lease');
      await db.update(schema.agentBusMessages).set({ status: 'leased', leaseOwner: 'session:prior', claimId: randomUUID(),
        leaseUntil: new Date(Date.now() + 60000).toISOString() }).where(eq(schema.agentBusMessages.id, batch.root.id));
      await db.update(schema.agentBusMessages).set({ status: 'canceled' }).where(eq(schema.agentBusMessages.id, batch.originals[0]!));
      const before = await messageRow(batch.root.id);
      expect(await service.claimForRelay(batch.relayId, batch.token, randomUUID())).toBeNull();
      expect(await messageRow(batch.root.id)).toEqual(before);
      expect(await messageRow(batch.originals[1]!)).toMatchObject({ status: 'batched', digestId: batch.root.id });
      await db.update(schema.agentBusMessages).set({ leaseUntil: '2000-01-01T00:00:00Z' }).where(eq(schema.agentBusMessages.id, batch.root.id));
      expect(await service.claimForRelay(batch.relayId, batch.token, randomUUID())).toMatchObject({ message_id: batch.originals[1] });
      expect(await messageRow(batch.originals[0]!)).toMatchObject({ status: 'canceled' });
    });

    it('expires batch members instead of restoring them after their own TTL', async () => {
      const batch = await queuedBatch('member-expiry');
      await db.update(schema.agentBusMessages).set({ expiresAt: '2000-01-01T00:00:00Z' }).where(eq(schema.agentBusMessages.id, batch.originals[0]!));
      expect(await service.claimForRelay(batch.relayId, batch.token, randomUUID())).toMatchObject({ message_id: batch.originals[1] });
      expect(await messageRow(batch.originals[0]!)).toMatchObject({ status: 'expired', digestId: batch.root.id });
    });

    it('preserves a batch when a new live session binds before the relay transaction', async () => {
      const batch = await queuedBatch('binding-race');
      const [address] = await db.select().from(schema.agentBusAddresses).where(eq(schema.agentBusAddresses.id, batch.target.addressId));
      const transaction = db.transaction.bind(db);
      const race = vi.spyOn(db, 'transaction').mockImplementationOnce(async (...args) => {
        const bound = await service.registerSession(host, { engine: 'claude', username: batch.target.username,
          cwd: `/tmp/${batch.target.username}`, upstreamSessionId: address!.lastUpstreamSessionId!, invocationKind: 'interactive',
          sessionId: randomUUID(), bridgeToken: randomBytes(32).toString('base64url'), adapterProtocol: 'test-live-v1',
          adapterCapabilities: { test: true, execution_contract_version: 2 } });
        expect((bound.address as Record<string, unknown>).id).toBe(batch.target.addressId);
        return transaction(...args);
      });
      try { expect(await service.claimForRelay(batch.relayId, batch.token, randomUUID())).toBeNull(); }
      finally { race.mockRestore(); }
      expect(await messageRow(batch.root.id)).toMatchObject({ status: 'queued' });
      for (const id of batch.originals) expect(await messageRow(id)).toMatchObject({ status: 'batched', digestId: batch.root.id });
    });

    it('does not acquire recovery locks for fifty unrelated dormant targets', async () => {
      const source = await register('fanout-source');
      const relay = await offlineTargetWithRelay('fanout');
      const claim = async () => {
        const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
          to: relay.target.address, content: 'ordinary work', clientMessageId: randomUUID(),
        });
        const id = String((sent.message as Record<string, unknown>).id), claimId = randomUUID();
        queries.length = 0;
        expect(await service.claimForRelay(relay.relayId, relay.token, claimId)).toMatchObject({ message_id: id });
        const locks = queries.filter(query => /from `agent_bus_addresses`.*for update/i.test(query)).length;
        await service.acknowledgeRelayDelivery(relay.relayId, relay.token, id, { claimId, outcome: 'completed' });
        return locks;
      };
      const baseline = await claim();
      const [template] = await db.select().from(schema.agentBusAddresses).where(eq(schema.agentBusAddresses.id, relay.target.addressId));
      await db.insert(schema.agentBusAddresses).values(Array.from({ length: 50 }, () => {
        const id = randomUUID(), cwd = `/tmp/${id}`;
        return { ...template!, id, address: `agent:${id}`, displayAlias: null, launchName: null,
          cwd, cwdHash: sha256(cwd), lastUpstreamSessionId: randomUUID() };
      }));
      expect(await claim()).toBe(baseline);
    });

    it('waits lock-free behind accepted FIFO work and wakes normal delivery after completion', async () => {
      const source = await register('fifo-accepted-source');
      const relay = await offlineTargetWithRelay('fifo-accepted');
      const send = async () => String(((await service.sendMessage(source.sessionId, source.bridgeToken, {
        to: relay.target.address, content: 'FIFO work', clientMessageId: randomUUID(),
      })).message as Record<string, unknown>).id);
      const first = await send(), firstClaim = randomUUID();
      await service.claimForRelay(relay.relayId, relay.token, firstClaim);
      await service.acknowledgeRelayDelivery(relay.relayId, relay.token, first, { claimId: firstClaim, outcome: 'accepted' });
      const second = await send();
      const lock = await holdFlagLock();
      const claim = service.claimForRelay(relay.relayId, relay.token, randomUUID());
      let outcome: Awaited<ReturnType<typeof settledWithin>>;
      try { outcome = await settledWithin(claim, SETTLE_MS); }
      finally { await lock.release(); await claim; }
      expect(outcome).toEqual({ value: null });
      expect(await messageRow(second)).toMatchObject({ status: 'queued', attempts: 0 });
      await service.acknowledgeRelayDelivery(relay.relayId, relay.token, first, { claimId: firstClaim, outcome: 'completed' });
      expect(await service.claimForRelay(relay.relayId, relay.token, randomUUID())).toMatchObject({ message_id: second });
    });

    it('keeps due followers idle behind a delayed FIFO head, then delivers the head first', async () => {
      const source = await register('fifo-delay-source');
      const relay = await offlineTargetWithRelay('fifo-delay');
      const send = async () => String(((await service.sendMessage(source.sessionId, source.bridgeToken, {
        to: relay.target.address, content: 'ordered', clientMessageId: randomUUID(),
      })).message as Record<string, unknown>).id);
      const first = await send(), second = await send();
      await db.update(schema.agentBusMessages).set({ nextAttemptAt: new Date(Date.now() + 60_000).toISOString() }).where(eq(schema.agentBusMessages.id, first));
      const lock = await holdFlagLock();
      const claim = service.claimForRelay(relay.relayId, relay.token, randomUUID());
      let outcome: Awaited<ReturnType<typeof settledWithin>>;
      try { outcome = await settledWithin(claim, SETTLE_MS); }
      finally { await lock.release(); await claim; }
      expect(outcome).toEqual({ value: null });
      expect(await messageRow(second)).toMatchObject({ status: 'queued', attempts: 0 });
      await db.update(schema.agentBusMessages).set({ nextAttemptAt: new Date(Date.now() - 1000).toISOString() }).where(eq(schema.agentBusMessages.id, first));
      expect(await service.claimForRelay(relay.relayId, relay.token, randomUUID())).toMatchObject({ message_id: first });
    });

    it('still expires a blocked follower without completing its accepted FIFO head', async () => {
      const source = await register('fifo-expiry-source');
      const relay = await offlineTargetWithRelay('fifo-expiry');
      const send = async () => String(((await service.sendMessage(source.sessionId, source.bridgeToken, {
        to: relay.target.address, content: 'expiry', clientMessageId: randomUUID(),
      })).message as Record<string, unknown>).id);
      const first = await send(), claimId = randomUUID();
      await service.claimForRelay(relay.relayId, relay.token, claimId);
      await service.acknowledgeRelayDelivery(relay.relayId, relay.token, first, { claimId, outcome: 'accepted' });
      const second = await send();
      await db.update(schema.agentBusMessages).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(schema.agentBusMessages.id, second));
      expect(await service.claimForRelay(relay.relayId, relay.token, randomUUID())).toBeNull();
      expect(await messageRow(first)).toMatchObject({ status: 'accepted' });
      expect(await messageRow(second)).toMatchObject({ status: 'expired' });
    });

    it('answers idle polls without waiting on the flag lock or pinning pool connections', async () => {
      // Six concurrent idle polls against a two-connection pool. One relay polled six times: relays are per user, and
      // only the daemon's user of a persistent host may run one (docs/host-runtime-policy.md).
      const relay = await offlineTargetWithRelay('idle');
      const relays = Array.from({ length: 6 }, () => relay);
      const lock = await holdFlagLock();
      try {
        const polls = relays.map((r) =>
          settledWithin(service.claimForRelay(r.relayId, r.token, randomUUID()), SETTLE_MS),
        );
        const victim = settledWithin(
          db.select({ version: schema.versions.version }).from(schema.versions).limit(1),
          SETTLE_MS,
        );
        for (const outcome of await Promise.all(polls)) expect(outcome).toEqual({ value: null });
        expect(await victim).not.toBe('pending');
      } finally {
        await lock.release();
      }
    });

    it('does not lock or modify accepted ordinary work while polling for another delivery', async () => {
      const source = await register('accepted-source');
      const { target, relayId, token } = await offlineTargetWithRelay('accepted');
      const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
        to: target.address, content: 'already accepted work', clientMessageId: randomUUID(),
      });
      const id = String((sent.message as Record<string, unknown>).id);
      await db.update(schema.agentBusMessages).set({ status: 'accepted', acceptedAt: new Date().toISOString() })
        .where(eq(schema.agentBusMessages.id, id));
      const before = await messageRow(id);
      const lock = await holdFlagLock();
      const claim = service.claimForRelay(relayId, token, randomUUID());
      let outcome: Awaited<ReturnType<typeof settledWithin>>;
      try { outcome = await settledWithin(claim, SETTLE_MS); }
      finally { await lock.release(); await claim; }
      expect(outcome).toEqual({ value: null });
      expect(await messageRow(id)).toEqual(before);
    });

    it('does not lock for an ordinary future retry but still expires it when due', async () => {
      const source = await register('backoff-source');
      const { target, relayId, token } = await offlineTargetWithRelay('backoff');
      const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
        to: target.address, content: 'retry later', clientMessageId: randomUUID(),
      });
      const id = String((sent.message as Record<string, unknown>).id);
      await db.update(schema.agentBusMessages).set({ nextAttemptAt: new Date(Date.now() + 60000).toISOString() })
        .where(eq(schema.agentBusMessages.id, id));
      const before = await messageRow(id);
      const lock = await holdFlagLock();
      const claim = service.claimForRelay(relayId, token, randomUUID());
      let outcome: Awaited<ReturnType<typeof settledWithin>>;
      try { outcome = await settledWithin(claim, SETTLE_MS); }
      finally { await lock.release(); await claim; }
      expect(outcome).toEqual({ value: null });
      expect(await messageRow(id)).toEqual(before);
      await db.update(schema.agentBusMessages).set({ expiresAt: '2000-01-01T00:00:00Z' })
        .where(eq(schema.agentBusMessages.id, id));
      expect(await service.claimForRelay(relayId, token, randomUUID())).toBeNull();
      expect(await messageRow(id)).toMatchObject({ status: 'expired' });
    });

    it('still retires a server publication whose retry is in the future', async () => {
      const source = await register('routine-source');
      const { target, relayId, token } = await offlineTargetWithRelay('routine');
      await serverAddress();
      const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
        to: target.address, content: 'placeholder', clientMessageId: randomUUID(),
      });
      const id = String((sent.message as Record<string, unknown>).id);
      const content = 'ROLE-UPDATE/1 role=developer version=2 previous=1 sha=0123456789ab\nInformational; no reply required.';
      await db.update(schema.agentBusMessages).set({ kind: 'publication', senderAddressId: SERVER_ADDRESS_ID,
        senderSessionId: null, workKind: null, executionContractVersion: 1, contentEnc: encrypt(content, testKeyring()),
        contentBytes: Buffer.byteLength(content), nextAttemptAt: new Date(Date.now() + 60000).toISOString() })
        .where(eq(schema.agentBusMessages.id, id));
      expect(await service.claimForRelay(relayId, token, randomUUID())).toBeNull();
      expect(await messageRow(id)).toMatchObject({ status: 'canceled', lastErrorCode: 'routine_notice_retired' });
    });

    it('rechecks retry and expiry deadlines during a real long poll without notifications', async () => {
      const source = await register('deadline-source');
      for (const mode of ['retry', 'expiry']) {
        const { target, relayId, token } = await offlineTargetWithRelay(`deadline-${mode}`);
        const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
          to: target.address, content: mode, clientMessageId: randomUUID(),
        });
        const id = String((sent.message as Record<string, unknown>).id), start = Date.now();
        await db.update(schema.agentBusMessages).set({
          nextAttemptAt: new Date(start + (mode === 'retry' ? 600 : 60000)).toISOString(),
          expiresAt: new Date(start + (mode === 'expiry' ? 600 : 60000)).toISOString(),
        }).where(eq(schema.agentBusMessages.id, id));
        const claimId = randomUUID();
        const result = await relayLongPoll(() => service.claimForRelay(relayId, token, claimId),
          start + (mode === 'retry' ? 5000 : 3200), () => false, undefined,
          { key: `${relayId}:${sha256(token)}`, check: () => service.relayIdle(relayId, token) });
        if (mode === 'retry') {
          expect(result).toMatchObject({ message_id: id });
          expect(Date.now() - start).toBeLessThan(4000);
        } else {
          expect(result).toBeNull();
          expect(await messageRow(id)).toMatchObject({ status: 'expired' });
        }
      }
    });

    it('still reports a disabled service to an idle poll', async () => {
      const { relayId, token } = await offlineTargetWithRelay('disabled');
      await setFlag('0');
      await expect(service.claimForRelay(relayId, token, randomUUID())).rejects.toMatchObject({
        code: 'agent_messaging_disabled',
      });
    });

    it('makes a poll with queued work wait for the flag lock, then claim it', async () => {
      const source = await register('work-source');
      const { target, relayId, token } = await offlineTargetWithRelay('work');
      const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
        to: target.address,
        content: 'wake up',
        clientMessageId: randomUUID(),
      });
      const id = String((sent.message as Record<string, unknown>).id);
      const lock = await holdFlagLock();
      let claim: Promise<unknown> | undefined;
      try {
        claim = service.claimForRelay(relayId, token, randomUUID());
        const early = await settledWithin(claim, SETTLE_MS);
        expect(early).toBe('pending');
      } finally {
        await lock.release();
      }
      await expect(claim).resolves.toMatchObject({ message_id: id });
      expect(await messageRow(id)).toMatchObject({ status: 'leased', attempts: 1 });
    });

    it('refuses, and does not lease, queued work when a disable commits while the poll waits', async () => {
      const source = await register('fence-source');
      const { target, relayId, token } = await offlineTargetWithRelay('fence');
      const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
        to: target.address,
        content: 'fenced',
        clientMessageId: randomUUID(),
      });
      const id = String((sent.message as Record<string, unknown>).id);
      const lock = await holdFlagLock('0');
      let claim: Promise<unknown> | undefined;
      try {
        claim = service.claimForRelay(relayId, token, randomUUID());
        expect(await settledWithin(claim, SETTLE_MS)).toBe('pending');
      } finally {
        await lock.release();
      }
      await expect(claim).rejects.toMatchObject({ code: 'agent_messaging_disabled' });
      expect(await messageRow(id)).toMatchObject({ status: 'queued', attempts: 0, leaseOwner: null });
    });

    it('still expires, requeues and dead-letters mail on a poll that finds only that work', async () => {
      const source = await register('maintenance-source');
      const { target, relayId, token } = await offlineTargetWithRelay('maintenance');
      const expiring = String(
        (
          (
            await service.sendMessage(source.sessionId, source.bridgeToken, {
              to: target.address,
              content: 'too late',
              clientMessageId: randomUUID(),
            })
          ).message as Record<string, unknown>
        ).id,
      );
      await db
        .update(schema.agentBusMessages)
        .set({ expiresAt: '2000-01-01T00:00:00Z' })
        .where(eq(schema.agentBusMessages.id, expiring));
      expect(await service.claimForRelay(relayId, token, randomUUID())).toBeNull();
      expect(await messageRow(expiring)).toMatchObject({ status: 'expired' });

      const leased = String(
        (
          (
            await service.sendMessage(source.sessionId, source.bridgeToken, {
              to: target.address,
              content: 'lease lost',
              clientMessageId: randomUUID(),
            })
          ).message as Record<string, unknown>
        ).id,
      );
      expect(await service.claimForRelay(relayId, token, randomUUID())).toMatchObject({
        message_id: leased,
        attempts: 1,
      });
      await db
        .update(schema.agentBusMessages)
        .set({ leaseUntil: '2000-01-01T00:00:00Z' })
        .where(eq(schema.agentBusMessages.id, leased));
      expect(await service.claimForRelay(relayId, token, randomUUID())).toMatchObject({
        message_id: leased,
        attempts: 2,
      });
    });

    it.each(['accepted', 'batched'])('still discards a %s presence notice whose session ended', async status => {
      const source = await register('notice-source');
      const { target, relayId, token } = await offlineTargetWithRelay('notice');
      const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
        to: target.address,
        content: 'welcome back',
        clientMessageId: randomUUID(),
      });
      const id = String((sent.message as Record<string, unknown>).id);
      await db
        .update(schema.agentBusMessages)
        .set({ kind: 'presence_notice', status, targetSessionId: target.sessionId })
        .where(eq(schema.agentBusMessages.id, id));
      expect(await service.claimForRelay(relayId, token, randomUUID())).toBeNull();
      expect(await messageRow(id)).toMatchObject({
        status: 'canceled',
        lastErrorCode: 'presence_notice_session_ended',
      });
    });

    it('shares only what relayIdle proves: idle exactly when a claim would be, lock-free, consuming nothing', async () => {
      // Parallel daemon slots share a true answer from relayIdle; anything else must reach claimForRelay's own fences.
      const source = await register('share-source');
      const { target, relayId, token } = await offlineTargetWithRelay('share');
      const lock = await holdFlagLock();
      try {
        expect(await settledWithin(service.relayIdle(relayId, token), SETTLE_MS)).toEqual({ value: true });
      } finally {
        await lock.release();
      }
      const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
        to: target.address,
        content: 'shared wake',
        clientMessageId: randomUUID(),
      });
      const id = String((sent.message as Record<string, unknown>).id);
      expect(await service.relayIdle(relayId, token)).toBe(false);
      expect(await messageRow(id)).toMatchObject({ status: 'queued', attempts: 0, leaseOwner: null });
      await expect(service.claimForRelay(relayId, token, randomUUID())).resolves.toMatchObject({ message_id: id });
      // A leased row can still need the locked path (expiry requeue), so it is never idle.
      expect(await service.relayIdle(relayId, token)).toBe(false);

      await service.stopRelay(relayId, token);
      await expect(service.relayIdle(relayId, token)).rejects.toMatchObject({
        code: 'agent_messaging_relay_unauthorized',
      });
      const other = await offlineTargetWithRelay('share-disabled');
      await setFlag('0');
      await expect(service.relayIdle(other.relayId, other.token)).rejects.toMatchObject({
        code: 'agent_messaging_disabled',
      });
    });

    it('certifies an idle relay poll in a single statement', async () => {
      const { relayId, token } = await offlineTargetWithRelay('one-statement');
      // The first proof also reads the relay's immutable host/user once; every later one is a single statement.
      expect(await relayIdleProof(db, relayId, token)).toBe(true);
      const query = vi.spyOn(pool, 'query');
      const execute = vi.spyOn(pool, 'execute');
      try {
        expect(await service.claimForRelay(relayId, token, randomUUID())).toBeNull();
        expect(query.mock.calls.length + execute.mock.calls.length).toBe(1);
      } finally {
        query.mockRestore();
        execute.mockRestore();
      }
    });

    it('never certifies a state the full relay path would act on or refuse', async () => {
      const source = await register('proof-source');
      const { target, relayId, token } = await offlineTargetWithRelay('proof');
      expect(await relayIdleProof(db, relayId, token)).toBe(true);
      expect(await relayIdleProof(db, relayId, 'wrong-token')).toBe(false);
      expect(await relayIdleProof(db, 'not-a-uuid', token)).toBe(false);
      const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
        to: target.address,
        content: 'proof wake',
        clientMessageId: randomUUID(),
      });
      const id = String((sent.message as Record<string, unknown>).id);
      expect(await relayIdleProof(db, relayId, token)).toBe(false);
      await expect(service.claimForRelay(relayId, token, randomUUID())).resolves.toMatchObject({ message_id: id });
      // A lease can still expire into a requeue, so leased work is never idle.
      expect(await relayIdleProof(db, relayId, token)).toBe(false);
      await db
        .update(schema.agentBusMessages)
        .set({ status: 'completed', leaseUntil: null })
        .where(eq(schema.agentBusMessages.id, id));
      expect(await relayIdleProof(db, relayId, token)).toBe(true);
      const expiring = String(
        ((await service.sendMessage(source.sessionId, source.bridgeToken, {
          to: target.address,
          content: 'expires',
          clientMessageId: randomUUID(),
        })).message as Record<string, unknown>).id,
      );
      await db
        .update(schema.agentBusMessages)
        .set({ expiresAt: '2000-01-01T00:00:00Z', nextAttemptAt: '2999-01-01T00:00:00Z' })
        .where(eq(schema.agentBusMessages.id, expiring));
      expect(await relayIdleProof(db, relayId, token)).toBe(false);
      expect(await service.claimForRelay(relayId, token, randomUUID())).toBeNull();
      expect(await messageRow(expiring)).toMatchObject({ status: 'expired' });
      expect(await relayIdleProof(db, relayId, token)).toBe(true);

      await setFlag('0');
      expect(await relayIdleProof(db, relayId, token)).toBe(false);
      await expect(service.claimForRelay(relayId, token, randomUUID())).rejects.toMatchObject({
        code: 'agent_messaging_disabled',
      });
      await setFlag('1');
      await service.stopRelay(relayId, token);
      expect(await relayIdleProof(db, relayId, token)).toBe(false);
      await expect(service.claimForRelay(relayId, token, randomUUID())).rejects.toMatchObject({
        code: 'agent_messaging_relay_unauthorized',
      });
    });

    it('answers self from a consistent snapshot without waiting on the bus mutex', async () => {
      const s = await register('self-snapshot', randomUUID());
      const before = await service.self(s.sessionId, s.bridgeToken);
      const lock = await holdFlagLock();
      try {
        expect(await settledWithin(service.self(s.sessionId, s.bridgeToken), SETTLE_MS)).toEqual({ value: before });
      } finally {
        await lock.release();
      }
      await setFlag('0');
      await expect(service.self(s.sessionId, s.bridgeToken)).rejects.toMatchObject({ code: 'agent_messaging_disabled' });
    });
  },
);
