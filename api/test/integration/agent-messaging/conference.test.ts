import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  agentBusAddresses,
  agentBusConferenceMembers,
  agentBusConferences,
  agentBusMessages,
  hosts,
} from '../../../src/db/schema.js';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import type { Env } from '../../../src/env.js';
import {
  AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP,
  AGENT_MESSAGING_ENABLED_KEY,
  AgentMessagingService,
  releaseAgentMessagingBindingsLocked,
  suspendAgentMessagingRuntimeLocked,
} from '../../../src/services/agent-messaging.js';
import type { Engine } from '../../../src/util/engine.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  join(HERE, '../../../src/db/migrations/0008_add_agent_portal.sql'),
  join(HERE, '../../../src/db/migrations/0014_add_agent_messaging.sql'),
  join(HERE, '../../../src/db/migrations/0020_add_agent_call_pins.sql'),
  join(HERE, '../../../src/db/migrations/0021_add_agent_conferences.sql'),
];
const PREFIX = 'ztest-agent-conf';
const HOST_FQDN = `${PREFIX}.example`;
const HOST_KEY = 'd'.repeat(64);
const handle = await getTestDb();

interface AgentIdentity {
  sessionId: string;
  bridgeToken: string;
  address: string;
  addressId: string;
}

describe.skipIf(!handle)('conferences against a real database', { timeout: 120_000 }, () => {
  let db: TestDb;
  let env: Env;
  let service: AgentMessagingService;
  let host: typeof hosts.$inferSelect;

  const exec = async (query: string) => await db.execute(sql.raw(query));

  const cleanup = async (): Promise<void> => {
    const hostId = host?.id ?? 0;
    const scoped = `SELECT id FROM agent_bus_addresses WHERE host_id = ${hostId}`;
    await exec(`DELETE FROM agent_bus_conference_members WHERE address_id IN (${scoped})`);
    await exec(`DELETE FROM agent_bus_conferences WHERE owner_address_id IN (${scoped})`);
    await exec(
      `DELETE FROM agent_bus_messages WHERE sender_address_id IN (${scoped}) OR target_address_id IN (${scoped})`,
    );
    await exec(
      `DELETE FROM agent_bus_conversations WHERE address_a_id IN (${scoped}) OR address_b_id IN (${scoped})`,
    );
    await exec(`DELETE FROM agent_sessions WHERE host_id = ${hostId}`);
    await exec(`DELETE FROM agent_bus_addresses WHERE host_id = ${hostId}`);
    await exec(`DELETE FROM admin_events WHERE host_id = ${hostId}`);
    await exec(`DELETE FROM logs WHERE host_id = ${hostId}`);
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
    host = (await db.select().from(hosts).where(eq(hosts.fqdn, HOST_FQDN)).limit(1))[0]!;
    env = { ...loadTestEnv(), AGENT_PORTAL_BRIDGE_TTL_SECONDS: 900 } as Env;
    service = new AgentMessagingService(db, env, testKeyring());
  });

  beforeEach(async () => {
    await cleanup();
    await exec(
      `INSERT INTO versions (name, version, updated_at)
       VALUES ('${AGENT_MESSAGING_ENABLED_KEY}', '1', '2026-08-04T00:00:00.000Z')
       ON DUPLICATE KEY UPDATE version = '1', updated_at = VALUES(updated_at)`,
    );
  });

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await exec(`DELETE FROM hosts WHERE fqdn = '${HOST_FQDN}'`);
    await exec(
      `INSERT INTO versions (name, version, updated_at)
       VALUES ('${AGENT_MESSAGING_ENABLED_KEY}', '0', '1970-01-01T00:00:00.000Z')
       ON DUPLICATE KEY UPDATE version = '0', updated_at = VALUES(updated_at)`,
    );
    await handle?.pool.end();
  });

  async function register(engine: Engine, label: string): Promise<AgentIdentity> {
    const sessionId = randomUUID();
    const bridgeToken = randomBytes(32).toString('base64url');
    const result = await service.registerSession(host, {
      engine,
      username: `${PREFIX}-${label}`,
      cwd: `/tmp/${PREFIX}/${label}`,
      invocationKind: 'interactive',
      sessionId,
      bridgeToken,
      adapterProtocol: 'test-live-v1',
      adapterCapabilities: { test: true },
    });
    const address = result.address as Record<string, unknown>;
    return { sessionId, bridgeToken, address: String(address.address), addressId: String(address.id) };
  }

  const memberRow = async (conferenceId: string, addressId: string) =>
    (
      await db
        .select()
        .from(agentBusConferenceMembers)
        .where(
          and(
            eq(agentBusConferenceMembers.conferenceId, conferenceId),
            eq(agentBusConferenceMembers.addressId, addressId),
          ),
        )
        .limit(1)
    )[0];

  const conferenceRow = async (conferenceId: string) =>
    (await db.select().from(agentBusConferences).where(eq(agentBusConferences.id, conferenceId)).limit(1))[0];

  /** Open a room with a chair and two joined participants. */
  async function room() {
    const chair = await register('claude', 'chair');
    const one = await register('claude', 'one');
    const two = await register('codex', 'two');
    const opened = await service.openConference(chair.sessionId, chair.bridgeToken, {
      topic: 'migration 0021',
      purpose: 'land it on crane',
    });
    const conferenceId = String(opened.conference_id);
    const pin = String(opened.pin);
    await service.joinConference(one.sessionId, one.bridgeToken, { pin, purpose: 'db checks' });
    await service.joinConference(two.sessionId, two.bridgeToken, { pin, purpose: 'web checks' });
    return { chair, one, two, conferenceId, pin, opened };
  }

  it('opens a room, tells the chair its own address, and mints a four-digit PIN', async () => {
    const chair = await register('claude', 'chair');
    const opened = await service.openConference(chair.sessionId, chair.bridgeToken, { topic: 'standup' });

    expect(String(opened.pin)).toMatch(/^[0-9]{4}$/);
    // listAddresses excludes the caller, so this is the only way a chair can
    // ever name itself -- and a member that cannot name itself cannot read a roster.
    expect((opened.self as Record<string, unknown>).address).toBe(chair.address);
    expect(opened.reused).toBe(false);

    const reopened = await service.openConference(chair.sessionId, chair.bridgeToken, {});
    expect(reopened.conference_id).toBe(opened.conference_id);
    expect(reopened.reused).toBe(true);
    expect(reopened.pin).toBe(opened.pin);
  });

  it('admits many members on one PIN — the room PIN is not consumed by a join', async () => {
    const { conferenceId, pin, one, two } = await room();

    // The whole difference from #call: four agents dial the same four digits.
    expect((await conferenceRow(conferenceId))?.pin).toBe(pin);

    const roster = await service.conferenceRoster(one.sessionId, one.bridgeToken, conferenceId);
    const members = roster.members as Record<string, unknown>[];
    expect(members).toHaveLength(3);
    expect(members.filter((m) => m.role === 'owner')).toHaveLength(1);
    expect(members.map((m) => m.address)).toContain(two.address);
  });

  it('records host and engine from the fleet, and only purpose from the member', async () => {
    const { conferenceId, one, two } = await room();
    const roster = await service.conferenceRoster(one.sessionId, one.bridgeToken, conferenceId);
    const members = roster.members as Record<string, unknown>[];

    const codexMember = members.find((m) => m.address === two.address)!;
    // Declared by the agent.
    expect(codexMember.purpose).toBe('web checks');
    // Not declared by the agent: joined from hosts/agent_bus_addresses, so a
    // member cannot misreport which box or engine it is on.
    expect(codexMember.engine).toBe('codex');
    expect(codexMember.fqdn).toBe(HOST_FQDN);
    expect(codexMember.role).toBe('participant');
  });

  it('refuses a conference_id from an agent that was never invited', async () => {
    const { conferenceId } = await room();
    const stranger = await register('claude', 'stranger');

    // Knowing a UUID is not an entry ticket; only the PIN admits a newcomer.
    await expect(
      service.joinConference(stranger.sessionId, stranger.bridgeToken, {
        conferenceId,
        purpose: 'uninvited',
      }),
    ).rejects.toMatchObject({ code: 'agent_messaging_conference_not_member' });
  });

  it('mints conference PINs from the same space as call PINs', async () => {
    const chair = await register('claude', 'chair');
    const caller = await register('claude', 'caller');

    const opened = await service.openConference(chair.sessionId, chair.bridgeToken, {});
    const called = await service.openCall(caller.sessionId, caller.bridgeToken);

    // A human carrying four digits between terminals cannot also be expected to
    // carry which kind of thing they open, so the two spaces are one space.
    expect(String(called.pin)).not.toBe(String(opened.pin));
  });

  it('lets only the chair dispatch and adjourn', async () => {
    const { conferenceId, one, two } = await room();

    await expect(
      service.conferenceDispatch(one.sessionId, one.bridgeToken, {
        conferenceId,
        to: two.address,
        task: 'not yours to give',
      }),
    ).rejects.toMatchObject({ code: 'agent_messaging_conference_not_owner' });

    await expect(
      service.adjournConference(one.sessionId, one.bridgeToken, { conferenceId }),
    ).rejects.toMatchObject({ code: 'agent_messaging_conference_not_owner' });
  });

  it('takes a dispatched member off the floor and puts it back when it reports', async () => {
    const { chair, one, two, conferenceId } = await room();

    const dispatched = await service.conferenceDispatch(chair.sessionId, chair.bridgeToken, {
      conferenceId,
      to: one.address,
      task: 'check migration 0021 on crane',
      etaSeconds: 60,
    });
    expect((await memberRow(conferenceId, one.addressId))?.state).toBe('dispatched');

    // A broadcast skips it: it is holding a delivery it has not finished.
    const said = await service.conferenceSay(chair.sessionId, chair.bridgeToken, {
      conferenceId,
      content: 'status check',
    });
    const reached = (said.results as Record<string, unknown>[]).map((r) => r.address);
    expect(reached).toContain(two.address);
    expect(reached).not.toContain(one.address);

    // Reporting is an ordinary reply to the task, which is what a headless
    // member's relay-correlated output also lands as.
    await service.replyMessage(one.sessionId, one.bridgeToken, String(dispatched.message_id), {
      content: 'applied 09:12Z',
      clientMessageId: randomUUID(),
    });
    const settled = await memberRow(conferenceId, one.addressId);
    expect(settled?.state).toBe('seated');
    expect(settled?.lastReportAt).not.toBeNull();
  });

  it('settles a headless dispatch through the relay, which is the only path it has', async () => {
    const { chair, one, conferenceId } = await room();

    // Make the member genuinely headless: no attached wrapper, so the relay is
    // allowed to claim for it and it will never call a tool of its own.
    await db.transaction(async (tx) => {
      await releaseAgentMessagingBindingsLocked(tx, [one.sessionId]);
    });
    const relay = await service.registerRelay(host, {
      username: `${PREFIX}-one`,
      instanceId: randomUUID(),
      wrapperVersion: 'test',
    });

    const dispatched = await service.conferenceDispatch(chair.sessionId, chair.bridgeToken, {
      conferenceId,
      to: one.address,
      task: 'run the migration',
    });
    expect((await memberRow(conferenceId, one.addressId))?.state).toBe('dispatched');

    const claim = randomUUID();
    const claimed = await service.claimForRelay(String(relay.relay_id), String(relay.relay_token), claim);
    expect(claimed).not.toBeNull();
    expect(String((claimed as unknown as Record<string, unknown>).message_id)).toBe(String(dispatched.message_id));

    // A headless member never calls agent_reply: the relay correlates its final
    // output and posts it here. Hooking only the tool path would leave every
    // headless member stuck in `dispatched` forever.
    await service.replyFromRelayDelivery(
      String(relay.relay_id),
      String(relay.relay_token),
      String(dispatched.message_id),
      { claimId: claim, content: 'applied 09:12Z', clientMessageId: randomUUID() },
    );

    // Deliberately no maintenance() call. The sweep would return this member to
    // `seated` at its dispatch deadline anyway, so running it here would make a
    // broken relay hook look exactly like a working one.
    const settled = await memberRow(conferenceId, one.addressId);
    expect(settled?.state).toBe('seated');
    expect(settled?.lastReportAt).not.toBeNull();
    expect(settled?.mode).toBe('headless');
  });

  it('un-strands a dispatched member whose run never came back', async () => {
    const { chair, one, conferenceId } = await room();
    await service.conferenceDispatch(chair.sessionId, chair.bridgeToken, {
      conferenceId,
      to: one.address,
      task: 'a task whose engine is about to die',
    });

    // A headless run that dies burns its delivery attempts without ever
    // touching the member row, so only the sweep can free the floor.
    await exec(
      `UPDATE agent_bus_conference_members SET dispatch_deadline_at = '2000-01-01T00:00:00.000Z'
        WHERE conference_id = '${conferenceId}' AND address_id = '${one.addressId}'`,
    );
    const swept = await service.maintenance();

    expect(swept.dispatches_expired).toBeGreaterThanOrEqual(1);
    const member = await memberRow(conferenceId, one.addressId);
    expect(member?.state).toBe('seated');
    // The miss stays visible: the chair can see it never reported.
    expect(member?.lastReportAt).toBeNull();
  });

  it('reports a broadcast per member instead of pretending it is atomic', async () => {
    const { chair, one, two, conferenceId } = await room();

    // Take one member out from under the fan-out mid-flight.
    await exec(`UPDATE agent_bus_addresses SET enabled = 0 WHERE id = '${two.addressId}'`);
    const said = await service.conferenceSay(chair.sessionId, chair.bridgeToken, {
      conferenceId,
      content: 'agenda',
    });
    const results = said.results as Record<string, unknown>[];

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.address === one.address)?.delivered).toBe(true);
    const failed = results.find((r) => r.delivered === false);
    expect(failed).toBeDefined();
    expect(String(failed?.error)).toMatch(/agent_messaging/);
  });

  it('adjourns gracefully around work in flight, and cuts it off only under force', async () => {
    const { chair, one, conferenceId } = await room();
    await service.conferenceDispatch(chair.sessionId, chair.bridgeToken, {
      conferenceId,
      to: one.address,
      task: 'long job',
    });

    const graceful = await service.adjournConference(chair.sessionId, chair.bridgeToken, {
      conferenceId,
      reason: 'done',
    });
    // Cancelling a conversation revokes the lease, which kills a headless
    // member's engine mid-task. That must never be the default.
    expect(graceful.status).toBe('adjourning');
    expect(graceful.waiting_on_tasks).toBe(1);
    expect(graceful.interrupted_tasks).toBe(0);
    expect((await memberRow(conferenceId, one.addressId))?.state).toBe('dispatched');
  });

  it('force-adjourns through a running task and says how much it interrupted', async () => {
    const { chair, one, conferenceId } = await room();
    await service.conferenceDispatch(chair.sessionId, chair.bridgeToken, {
      conferenceId,
      to: one.address,
      task: 'long job',
    });

    const forced = await service.adjournConference(chair.sessionId, chair.bridgeToken, {
      conferenceId,
      reason: 'abandoned',
      force: true,
    });
    expect(forced.status).toBe('adjourned');
    expect(forced.interrupted_tasks).toBe(1);
    expect((await conferenceRow(conferenceId))?.pin).toBeNull();
  });

  it('closes a draining room once its last task reports', async () => {
    const { chair, one, conferenceId } = await room();
    const dispatched = await service.conferenceDispatch(chair.sessionId, chair.bridgeToken, {
      conferenceId,
      to: one.address,
      task: 'last job',
    });
    await service.adjournConference(chair.sessionId, chair.bridgeToken, { conferenceId });

    await service.replyMessage(one.sessionId, one.bridgeToken, String(dispatched.message_id), {
      content: 'finished',
      clientMessageId: randomUUID(),
    });
    await service.maintenance();

    expect((await conferenceRow(conferenceId))?.status).toBe('adjourned');
  });

  it('adjourns overdue rooms and releases their PINs', async () => {
    const { conferenceId } = await room();
    await exec(
      `UPDATE agent_bus_conferences SET deadline_at = '2000-01-01T00:00:00.000Z' WHERE id = '${conferenceId}'`,
    );

    const swept = await service.maintenance();
    expect(swept.conferences_adjourned).toBeGreaterThanOrEqual(1);
    const row = await conferenceRow(conferenceId);
    expect(row?.status).toBe('adjourned');
    expect(row?.pin).toBeNull();
  });

  it('spends a per-member budget rather than the call protocol s turn count', async () => {
    const { chair, one, conferenceId } = await room();

    // The join already spent one. Sixteen turns means nothing across five
    // members, so the budget is per member and the server holds it.
    for (let i = 1; i < AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP; i += 1) {
      const said = await service.conferenceSay(chair.sessionId, chair.bridgeToken, {
        conferenceId,
        content: `round ${i}`,
        to: one.address,
      });
      expect((said.results as Record<string, unknown>[])[0]?.delivered).toBe(true);
    }
    const spent = await service.conferenceSay(chair.sessionId, chair.bridgeToken, {
      conferenceId,
      content: 'one too many',
      to: one.address,
    });
    expect((spent.results as Record<string, unknown>[])[0]).toMatchObject({
      delivered: false,
      error: 'agent_messaging_conference_budget_spent',
    });
  });

  it('carries the conference id in the envelope so a booted member can answer', async () => {
    const { conferenceId, chair, one } = await room();
    const queued = (
      await db
        .select({ id: agentBusMessages.id })
        .from(agentBusMessages)
        .where(eq(agentBusMessages.senderAddressId, one.addressId))
        .limit(1)
    )[0]!;

    const message = await service.getMessage(chair.sessionId, chair.bridgeToken, queued.id);
    const content = String((message.message as Record<string, unknown>).content);
    // A relay-woken member's whole context is the prompt it was booted with, so
    // the id has to be inside the message body or it can never call
    // agent_conf_join to answer.
    expect(content.split('\n')[0]).toBe(`CONF/1 HELLO conference=${conferenceId} purpose=db checks`);
  });

  it('adjourns open rooms when the host stops being eligible', async () => {
    const { conferenceId } = await room();

    await db.transaction(async (tx) => {
      await suspendAgentMessagingRuntimeLocked(tx, host.id, 'host_inactive');
    });

    const row = await conferenceRow(conferenceId);
    // Left open, a room whose chair is gone still holds a PIN and still admits
    // joiners to a meeting nobody can run.
    expect(row?.status).toBe('adjourned');
    expect(row?.pin).toBeNull();
  });
});
