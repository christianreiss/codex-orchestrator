import { randomBytes, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, inArray, or } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { AGENT_MESSAGING_ENABLED_KEY, AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { invalidateFleetEngineState } from '../../../src/services/engine-switch.js';
import { ENGINES } from '../../../src/util/engine.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

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
    const db = drizzle(pool, { schema, mode: 'default' });
    const fqdn = `relay-idle-poll-${randomUUID()}.test`;
    let service: AgentMessagingService;
    let host: typeof schema.hosts.$inferSelect;
    let priorFlag: string | undefined;
    const holders: mysql.Connection[] = [];

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
      service = new AgentMessagingService(db, loadTestEnv(), testKeyring());
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

    it('answers idle polls without waiting on the flag lock or pinning pool connections', async () => {
      const relays = await Promise.all(
        Array.from({ length: 6 }, (_, i) => offlineTargetWithRelay(`idle-${i}`)),
      );
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

    it('still discards an accepted presence notice whose session ended', async () => {
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
        .set({ kind: 'presence_notice', status: 'accepted', targetSessionId: target.sessionId })
        .where(eq(schema.agentBusMessages.id, id));
      expect(await service.claimForRelay(relayId, token, randomUUID())).toBeNull();
      expect(await messageRow(id)).toMatchObject({
        status: 'canceled',
        lastErrorCode: 'presence_notice_session_ended',
      });
    });
  },
);
