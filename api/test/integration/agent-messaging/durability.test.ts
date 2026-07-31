import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  agentBusAddresses,
  agentBusConversations,
  agentBusMessages,
  agentBusRelays,
  agentSessions,
  hosts,
} from '../../../src/db/schema.js';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import type { Env } from '../../../src/env.js';
import {
  AGENT_MESSAGING_ENABLED_KEY,
  AgentMessagingService,
} from '../../../src/services/agent-messaging.js';
import { makeAdminEventsWriter } from '../../../src/services/admin-events-writer.js';
import { HostManagementService } from '../../../src/services/host-management.js';
import { createHostRegistrationService } from '../../../src/services/host-registration.js';
import type { Engine } from '../../../src/util/engine.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  join(HERE, '../../../src/db/migrations/0008_add_agent_portal.sql'),
  join(HERE, '../../../src/db/migrations/0014_add_agent_messaging.sql'),
];
const PREFIX = 'ztest-agent-messaging';
const HOST_FQDN = `${PREFIX}.example`;
const HOST_KEY = 'b'.repeat(64);
const handle = await getTestDb();

interface AgentIdentity {
  sessionId: string;
  bridgeToken: string;
  address: string;
  addressId: string;
  bindingGeneration: number;
  engine: Engine;
  username: string;
  cwd: string;
}

describe.skipIf(!handle)('agent messaging durability against a real database', { timeout: 120_000 }, () => {
  let db: TestDb;
  let env: Env;
  let service: AgentMessagingService;
  let host: typeof hosts.$inferSelect;

  const exec = async (query: string) => await db.execute(sql.raw(query));

  const cleanup = async (): Promise<void> => {
    const hostId = host?.id ?? 0;
    await exec(`DELETE FROM agent_bus_messages WHERE sender_address_id IN (
      SELECT id FROM agent_bus_addresses WHERE host_id = ${hostId}
    ) OR target_address_id IN (
      SELECT id FROM agent_bus_addresses WHERE host_id = ${hostId}
    )`);
    await exec(`DELETE FROM agent_bus_conversations WHERE address_a_id IN (
      SELECT id FROM agent_bus_addresses WHERE host_id = ${hostId}
    ) OR address_b_id IN (
      SELECT id FROM agent_bus_addresses WHERE host_id = ${hostId}
    )`);
    await exec(`DELETE FROM agent_bus_relays WHERE host_id = ${hostId}`);
    await exec(`DELETE FROM agent_sessions WHERE host_id = ${hostId}`);
    await exec(`DELETE FROM agent_bus_addresses WHERE host_id = ${hostId}`);
    await exec(`DELETE FROM install_tokens WHERE host_id = ${hostId}`);
    await exec(`DELETE FROM admin_events WHERE host_id = ${hostId}`);
    await exec(`DELETE FROM logs WHERE host_id = ${hostId}`);
    await exec(
      `INSERT INTO versions (name, version, updated_at)
       VALUES ('${AGENT_MESSAGING_ENABLED_KEY}', '0', '1970-01-01T00:00:00.000Z')
       ON DUPLICATE KEY UPDATE version = '0', updated_at = VALUES(updated_at)`,
    );
  };

  beforeAll(async () => {
    db = handle!.db;
    for (const migration of MIGRATIONS) {
      for (const statement of splitSqlStatements(readFileSync(migration, 'utf8'))) {
        await exec(statement);
      }
    }
    await exec(`DELETE FROM hosts WHERE fqdn = '${HOST_FQDN}'`);
    const now = new Date().toISOString();
    await exec(
      `INSERT INTO hosts (
         fqdn, api_key, status, secure, engines, agent_messaging_enabled, created_at, updated_at
       ) VALUES (
         '${HOST_FQDN}', '${HOST_KEY}', 'active', 1, 'codex,claude', 1, '${now}', '${now}'
       )`,
    );
    const rows = await db.select().from(hosts).where(eq(hosts.fqdn, HOST_FQDN)).limit(1);
    host = rows[0]!;
    env = { ...loadTestEnv(), AGENT_PORTAL_BRIDGE_TTL_SECONDS: 900 } as Env;
    service = new AgentMessagingService(db, env, testKeyring());
  });

  beforeEach(async () => {
    await cleanup();
    await exec(
      `INSERT INTO versions (name, version, updated_at)
       VALUES ('${AGENT_MESSAGING_ENABLED_KEY}', '1', '2026-07-31T00:00:00.000Z')
       ON DUPLICATE KEY UPDATE version = '1', updated_at = VALUES(updated_at)`,
    );
    await db.update(hosts).set({ agentMessagingEnabled: 1, secure: 1, status: 'active' }).where(eq(hosts.id, host.id));
    host = (await db.select().from(hosts).where(eq(hosts.id, host.id)).limit(1))[0]!;
  });

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await exec(`DELETE FROM hosts WHERE fqdn = '${HOST_FQDN}'`);
    await handle?.pool.end();
  });

  async function register(
    engine: Engine,
    label: string,
    overrides: Partial<{ username: string; cwd: string; upstreamSessionId: string }> = {},
  ): Promise<AgentIdentity> {
    const sessionId = randomUUID();
    const bridgeToken = randomBytes(32).toString('base64url');
    const username = overrides.username ?? `${PREFIX}-${label}`;
    const cwd = overrides.cwd ?? `/tmp/${PREFIX}/${label}`;
    const result = await service.registerSession(host, {
      engine,
      username,
      cwd,
      upstreamSessionId: overrides.upstreamSessionId,
      invocationKind: 'interactive',
      sessionId,
      bridgeToken,
      adapterProtocol: 'test-live-v1',
      adapterCapabilities: { test: true },
    });
    const address = result.address as Record<string, unknown>;
    return {
      sessionId,
      bridgeToken,
      address: String(address.address),
      addressId: String(address.id),
      bindingGeneration: Number(address.binding_generation),
      engine,
      username,
      cwd,
    };
  }

  async function deliver(source: AgentIdentity, target: AgentIdentity, content: string): Promise<void> {
    const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address,
      content,
      clientMessageId: randomUUID(),
      kind: 'request',
    });
    const message = sent.message as Record<string, unknown>;
    const claimId = randomUUID();
    const claimed = await service.claimForSession(target.sessionId, target.bridgeToken, claimId);
    expect(claimed).toMatchObject({
      message_id: message.id,
      content,
      claim_id: claimId,
      attempts: 1,
    });
    const completed = await service.acknowledgeSessionDelivery(
      target.sessionId,
      target.bridgeToken,
      String(message.id),
      { claimId, outcome: 'completed', upstreamSessionId: randomUUID() },
    );
    expect((completed.message as Record<string, unknown>).status).toBe('completed');
    // Lost HTTP responses are safe: terminal ACKs retain their scoped claim
    // identity and collapse a retry onto the same terminal row.
    const repeated = await service.acknowledgeSessionDelivery(
      target.sessionId,
      target.bridgeToken,
      String(message.id),
      { claimId, outcome: 'completed' },
    );
    expect((repeated.message as Record<string, unknown>).status).toBe('completed');
  }

  it('delivers and completes all four Codex/Claude direction pairs', async () => {
    const codexA = await register('codex', 'codex-a');
    const codexB = await register('codex', 'codex-b');
    const claudeA = await register('claude', 'claude-a');
    const claudeB = await register('claude', 'claude-b');

    await deliver(codexA, codexB, 'codex to codex');
    await deliver(codexA, claudeA, 'codex to claude');
    await deliver(claudeA, codexA, 'claude to codex');
    await deliver(claudeA, claudeB, 'claude to claude');

    const state = await service.state();
    const directions = state.directions as Array<Record<string, unknown>>;
    for (const [source, target] of [
      ['codex', 'codex'],
      ['codex', 'claude'],
      ['claude', 'codex'],
      ['claude', 'claude'],
    ]) {
      expect(directions.find((row) => row.source_engine === source && row.target_engine === target))
        .toMatchObject({ total: 1, completed: 1, pending: 0 });
    }
  });

  it('keeps one in-flight delivery per address and preserves FIFO across retry', async () => {
    const source = await register('codex', 'fifo-source');
    const target = await register('claude', 'fifo-target');
    const first = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address, content: 'first', clientMessageId: randomUUID(),
    });
    const second = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address, content: 'second', clientMessageId: randomUUID(),
    });
    const firstId = String((first.message as Record<string, unknown>).id);
    const secondId = String((second.message as Record<string, unknown>).id);
    const inserted = await db.select().from(agentBusMessages).where(
      sql`${agentBusMessages.id} IN (${firstId}, ${secondId})`,
    );
    const orders = new Map(inserted.map((row) => [row.id, row.dispatchOrder]));
    expect(orders.get(firstId)).toBeLessThan(orders.get(secondId)!);
    const claimA = randomUUID();
    expect(await service.claimForSession(target.sessionId, target.bridgeToken, claimA))
      .toMatchObject({ message_id: firstId, content: 'first' });
    expect(await service.claimForSession(target.sessionId, target.bridgeToken, randomUUID())).toBeNull();
    await service.acknowledgeSessionDelivery(target.sessionId, target.bridgeToken, firstId, {
      claimId: claimA, outcome: 'retry', errorCode: 'test_retry',
    });
    // The second delivery cannot leapfrog a delayed retry at the head.
    expect(await service.claimForSession(target.sessionId, target.bridgeToken, randomUUID())).toBeNull();
    await db.update(agentBusMessages).set({ nextAttemptAt: '1970-01-01T00:00:00.000Z' }).where(eq(agentBusMessages.id, firstId));
    const claimB = randomUUID();
    expect(await service.claimForSession(target.sessionId, target.bridgeToken, claimB))
      .toMatchObject({ message_id: firstId, attempts: 2 });
    await service.acknowledgeSessionDelivery(target.sessionId, target.bridgeToken, firstId, {
      claimId: claimB, outcome: 'completed',
    });
    expect(await service.claimForSession(target.sessionId, target.bridgeToken, randomUUID()))
      .toMatchObject({ message_id: secondId, content: 'second' });
  });

  it('does not let sixty-four blocked later rows starve another target', async () => {
    const source = await register('codex', 'starvation-source');
    const blockedTarget = await register('claude', 'starvation-blocked');
    const eligibleTarget = await register('claude', 'starvation-eligible');
    const head = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: blockedTarget.address, content: 'blocked-head', clientMessageId: randomUUID(),
    });
    const headMessage = head.message as Record<string, unknown>;
    await db.update(agentBusMessages).set({ nextAttemptAt: '2999-01-01T00:00:00.000Z' }).where(
      eq(agentBusMessages.id, String(headMessage.id)),
    );
    for (let index = 0; index < 64; index += 1) {
      await service.sendMessage(source.sessionId, source.bridgeToken, {
        to: blockedTarget.address,
        conversationId: String(headMessage.conversation_id),
        content: `blocked-later-${index}`,
        clientMessageId: randomUUID(),
      });
    }
    const eligible = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: eligibleTarget.address, content: 'claim-me', clientMessageId: randomUUID(),
    });
    expect(await service.claimForSession(eligibleTarget.sessionId, eligibleTarget.bridgeToken, randomUUID())).toMatchObject({
      message_id: String((eligible.message as Record<string, unknown>).id),
      content: 'claim-me',
    });
  });

  it('reuses a dormant host/user/engine/cwd address with reset continuity', async () => {
    const first = await register('codex', 'stable', { username: 'stable-user', cwd: '/tmp/stable-work' });
    await service.finishSession(first.sessionId, first.bridgeToken, 'completed');
    const second = await register('codex', 'stable-next', { username: 'stable-user', cwd: '/tmp/stable-work' });

    expect(second.addressId).toBe(first.addressId);
    expect(second.address).toBe(first.address);
    expect(second.bindingGeneration).toBe(first.bindingGeneration + 1);
    const rows = await db.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, first.addressId));
    expect(rows[0]).toMatchObject({ continuity: 'reset', currentSessionId: second.sessionId });
  });

  it('does not let a disabled address rebind until an administrator re-enables it', async () => {
    const identity = await register('codex', 'disabled-rebind');
    await service.setAddressEnabled(identity.addressId, false);
    await expect(service.registerSession(host, {
      engine: identity.engine,
      username: identity.username,
      cwd: identity.cwd,
      invocationKind: 'interactive',
      sessionId: identity.sessionId,
      bridgeToken: identity.bridgeToken,
      adapterProtocol: 'test-live-v1',
    })).rejects.toMatchObject({ code: 'agent_messaging_binding_stale' });
    await expect(service.listAddresses(identity.sessionId, identity.bridgeToken)).rejects.toMatchObject({
      code: 'agent_messaging_binding_stale',
    });

    await service.setAddressEnabled(identity.addressId, true);
    const rebound = await service.registerSession(host, {
      engine: identity.engine,
      username: identity.username,
      cwd: identity.cwd,
      invocationKind: 'interactive',
      sessionId: identity.sessionId,
      bridgeToken: identity.bridgeToken,
      requestedAddress: identity.address,
      adapterProtocol: 'test-live-v1',
    });
    expect(rebound.address).toMatchObject({ id: identity.addressId, address: identity.address });
  });

  it('reclaims an expired wrapper binding and delivers queued work to the stable address', async () => {
    const source = await register('codex', 'reap-source');
    const target = await register('claude', 'reap-target', {
      username: 'reap-user', cwd: '/tmp/reap-work',
    });
    const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address, content: 'survive wrapper crash', clientMessageId: randomUUID(),
    });
    await db.update(agentSessions).set({ bridgeExpiresAt: '1970-01-01T00:00:00.000Z' }).where(eq(agentSessions.id, target.sessionId));
    const restarted = await register('claude', 'reap-restarted', {
      username: 'reap-user', cwd: '/tmp/reap-work',
    });
    expect(restarted.addressId).toBe(target.addressId);
    const claimId = randomUUID();
    expect(await service.claimForSession(restarted.sessionId, restarted.bridgeToken, claimId)).toMatchObject({
      message_id: String((sent.message as Record<string, unknown>).id),
      content: 'survive wrapper crash',
    });
  });

  it('makes the final retry-to-dead acknowledgement idempotent after a lost response', async () => {
    const source = await register('codex', 'dead-source');
    const target = await register('claude', 'dead-target');
    const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address, content: 'fail permanently', clientMessageId: randomUUID(),
    });
    const messageId = String((sent.message as Record<string, unknown>).id);
    const claimId = randomUUID();
    await service.claimForSession(target.sessionId, target.bridgeToken, claimId);
    await db.update(agentBusMessages).set({ attempts: 12 }).where(eq(agentBusMessages.id, messageId));
    const first = await service.acknowledgeSessionDelivery(target.sessionId, target.bridgeToken, messageId, {
      claimId, outcome: 'retry', errorCode: 'permanent_test_failure',
    });
    expect(first.message).toMatchObject({ status: 'dead' });
    const repeated = await service.acknowledgeSessionDelivery(target.sessionId, target.bridgeToken, messageId, {
      claimId, outcome: 'retry', errorCode: 'permanent_test_failure',
    });
    expect(repeated.message).toMatchObject({ status: 'dead' });
  });

  it('master-off cancels work and conversations, revokes relays, but leaves interactive sessions running', async () => {
    const source = await register('codex', 'switch-source');
    const target = await register('claude', 'switch-target');
    await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address, content: 'cancel me', clientMessageId: randomUUID(),
    });
    await service.registerRelay(host, {
      username: target.username,
      instanceId: randomUUID(),
      wrapperVersion: 'test',
    });

    const result = await service.setEnabled(false);
    expect(result).toMatchObject({ enabled: false, canceled: 1, conversations: 1, relays: 1 });
    expect((await db.select().from(agentBusMessages))[0]).toMatchObject({ status: 'canceled' });
    expect((await db.select().from(agentBusConversations))[0]).toMatchObject({ status: 'canceled' });
    expect((await db.select().from(agentBusRelays))[0]).toMatchObject({ status: 'revoked', tokenHash: null });
    const sessions = await db.select().from(agentSessions).where(eq(agentSessions.hostId, host.id));
    expect(sessions).toHaveLength(2);
    expect(sessions.every((row) => row.endedAt === null)).toBe(true);
    await expect(service.listAddresses(source.sessionId, source.bridgeToken)).rejects.toMatchObject({
      code: 'agent_messaging_disabled',
    });
  });

  it('atomically fences messaging when the admin registration path rotates a host key', async () => {
    const source = await register('codex', 'admin-rotate-source');
    const target = await register('claude', 'admin-rotate-target');
    const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address, content: 'do not survive key rotation', clientMessageId: randomUUID(),
    });
    await service.registerRelay(host, {
      username: target.username,
      instanceId: randomUUID(),
      wrapperVersion: 'test',
    });
    const management = new HostManagementService({
      db,
      env,
      keyring: testKeyring(),
      events: makeAdminEventsWriter(db),
    });

    const rotated = await management.register({
      fqdn: HOST_FQDN,
      secure: true,
      engines: ['codex', 'claude'],
    });
    host = rotated.host;

    expect((await db.select().from(agentBusMessages).where(
      eq(agentBusMessages.id, String((sent.message as Record<string, unknown>).id)),
    ))[0]).toMatchObject({ status: 'canceled' });
    expect((await db.select().from(agentBusConversations))[0]).toMatchObject({ status: 'canceled' });
    expect((await db.select().from(agentBusRelays))[0]).toMatchObject({ status: 'revoked', tokenHash: null });
    expect((await db.select().from(agentBusAddresses))[0]).toMatchObject({ readiness: 'disabled', currentSessionId: null });
  });

  it('atomically fences messaging when CLI auth approval rotates a host key', async () => {
    const source = await register('claude', 'cli-rotate-source');
    const target = await register('codex', 'cli-rotate-target');
    const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address, content: 'do not survive CLI reapproval', clientMessageId: randomUUID(),
    });
    const registration = createHostRegistrationService({
      db,
      keyring: testKeyring(),
      insecure: { openInitial: async () => undefined } as never,
    });

    const rotated = await registration.registerOrRotate({
      fqdn: HOST_FQDN,
      secure: true,
      engines: 'codex,claude',
      createdBy: 'durability-test',
    });
    host = rotated.host;

    expect((await db.select().from(agentBusMessages).where(
      eq(agentBusMessages.id, String((sent.message as Record<string, unknown>).id)),
    ))[0]).toMatchObject({ status: 'canceled' });
    expect((await db.select().from(agentBusConversations))[0]).toMatchObject({ status: 'canceled' });
    expect((await db.select().from(agentBusAddresses))[0]).toMatchObject({ readiness: 'disabled', currentSessionId: null });
  });
});
