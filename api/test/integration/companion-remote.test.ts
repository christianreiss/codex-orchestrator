import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { getTestDb } from '../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../helpers/test-keyring.js';
import { runMigrations } from '../../src/db/migrator.js';
import {
  adminUsers,
  agentBusAddresses,
  agentEvents,
  companionDevices,
  agentPrompts,
  companionDaemonFollows,
  companionFollows,
  hostDaemons,
  hosts,
} from '../../src/db/schema.js';
import { CompanionPush } from '../../src/services/companion/push.js';
import { encrypt } from '../../src/security/secret-box.js';
import { CompanionDevices } from '../../src/services/companion/devices.js';
import { registerAgentPortalAdminHostRoutes } from '../../src/routes/agent-portal/admin-host.js';
import { registerCompanionRoutes } from '../../src/routes/companion/index.js';
import { HostDaemonService } from '../../src/services/host-daemon/service.js';
import { daemonSettingsSchema } from '../../src/services/host-daemon/policy.js';
import { createAgentPortalService } from '../../src/services/agent-portal.js';
import { envelopePlugin } from '../../src/http/plugins/envelope.js';
import { SettingsService } from '../../src/services/settings.js';
import { nowIso } from '../../src/util/timestamp.js';

const handle = await getTestDb();
describe.skipIf(!handle)('companion remote conversations with MySQL', () => {
  const ctx = {
    db: handle ? handle.db : null!,
    env: { ...loadTestEnv(), PUBLIC_BASE_URL: 'https://fleet.example' },
    keyring: testKeyring(),
  };
  const daemon = new HostDaemonService(ctx);
  const portal = createAgentPortalService(ctx.db, ctx.env, ctx.keyring);
  const devices = new CompanionDevices(ctx);
  const app = Fastify();
  let userId: number, hostId: number, generation: string, token: string, deviceId: string;
  let logical: string, firstPortal: string, address: string;
  const headers = () => ({ authorization: `Bearer ${token}` });
  const request = () => ({ host_id: hostId, engine: 'codex', client_message_id: randomUUID() });
  const snapshot = async () => {
    const response = await app.inject({ url: '/companion/v1/agents', headers: headers() });
    expect(response.statusCode,response.body).toBe(200);
    return response.json().data.agents as Array<Record<string, unknown>>;
  };
  beforeAll(async () => {
    await runMigrations(handle!.pool, { appliedBy: 'companion-remote-test' });
    const unique = randomUUID();
    const [u] = await ctx.db
      .insert(adminUsers)
      .values({
        name: unique,
        username: unique,
        email: `${unique}@test.example`,
        passwordHash: 'test',
        accessLevel: 'owner',
        active: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    userId = u.insertId;
    const [h] = await ctx.db
      .insert(hosts)
      .values({
        fqdn: `${unique}.test`,
        engines: 'codex,claude,grok',
        secure: 1,
        authDigest: 'test',
        claudeAuthDigest: 'test',
        grokAuthDigest: 'test',
        apiKey: randomBytes(32).toString('hex'),
        status: 'active',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    hostId = h.insertId;
    await new SettingsService(ctx.db).setFlag('agent_messaging_enabled', true);
    await portal.setEnabled(true);
    await daemon.configure(
      hostId,
      daemonSettingsSchema.parse({ enabled: true, default_cwd: '/tmp', max_parallel: 1 }),
    );
    generation = (
      await daemon.connect(hostId, {
        instance_id: randomUUID(),
        username: 'root',
        version: 'test',
        engines: ['codex', 'claude', 'grok'],
        error: null,
      })
    ).generation;
    const connection = await devices.exchange(
      JSON.parse((await devices.pair(userId)).qr).token,
      'Test phone',
    );
    token = connection.token;
    deviceId = connection.device_id;
    app.decorate('requireAdmin', async () => {});
    await app.register(envelopePlugin);
    await registerCompanionRoutes(app, ctx);
    await registerAgentPortalAdminHostRoutes(app, ctx);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await devices.revoke(userId, deviceId);
    await ctx.db.delete(hosts).where(eq(hosts.id, hostId));
    await ctx.db.delete(adminUsers).where(eq(adminUsers.id, userId));
    await handle?.pool.end();
  });
  it('rejects stale/offline hosts and engines outside the assignment before creating work', async () => {
    const cfg = await daemon.settings(hostId);
    await ctx.db.update(hostDaemons).set({ runtime: { ...cfg.runtime!, connected: false } }).where(eq(hostDaemons.hostId, hostId));
    const offline = await app.inject({ method: 'POST', url: '/companion/v1/daemon-sessions', headers: headers(), payload: request() });
    expect(offline.statusCode).toBe(409);
    expect(offline.json().code).toBe('daemon_unreachable');
    await ctx.db.update(hostDaemons).set({ runtime: { ...cfg.runtime!, heartbeat_at: new Date(Date.now() - 90_000).toISOString() } }).where(eq(hostDaemons.hostId, hostId));
    expect((await app.inject({ method: 'POST', url: '/companion/v1/daemon-sessions', headers: headers(), payload: request() })).statusCode).toBe(409);
    await ctx.db.update(hostDaemons).set({ runtime: cfg.runtime }).where(eq(hostDaemons.hostId, hostId));
    await ctx.db.update(hosts).set({ engines: 'codex' }).where(eq(hosts.id, hostId));
    expect((await app.inject({ method: 'POST', url: '/companion/v1/daemon-sessions', headers: headers(), payload: { ...request(), engine: 'claude' } })).statusCode).toBe(403);
    await ctx.db.update(hosts).set({ engines: 'codex,claude,grok' }).where(eq(hosts.id, hostId));
  });
  it('starts contact once, follows before registration and rejects occupied slots', async () => {
    const payload = request();
    const responses = await Promise.all(
      [0, 1].map(() =>
        app.inject({ method: 'POST', url: '/companion/v1/daemon-sessions', headers: headers(), payload }),
      ),
    );
    expect(responses.map((r) => r.statusCode)).toEqual([202, 202]);
    expect(responses[0]!.json()).toEqual(responses[1]!.json());
    logical = responses[0]!.json().data.session_id;
    expect(
      await ctx.db
        .select()
        .from(companionDaemonFollows)
        .where(eq(companionDaemonFollows.daemonSessionId, logical)),
    ).toHaveLength(1);
    expect((await snapshot()).find((s) => s.id === logical)).toMatchObject({
      remote_status: 'queued',
      relay_ready: false,
    });
    const hostCards = (await app.inject({ url: '/companion/v1/hosts', headers: headers() })).json().data
      .hosts;
    expect(hostCards.find((h: { host_id: number }) => h.host_id === hostId)).toMatchObject({
      free_slots: 0,
      startable: false,
    });
    const full = await app.inject({
      method: 'POST',
      url: '/companion/v1/daemon-sessions',
      headers: headers(),
      payload: request(),
    });
    expect(full.statusCode).toBe(409);
    expect(full.json().code).toBe('daemon_busy');
    expect((await daemon.session(logical)).operations[0]!.result).toBeNull();
  });
  it('binds the first real Portal greeting and keeps it writable after the process ends', async () => {
    const op = (await daemon.offer(hostId, generation))!;
    await daemon.accept(hostId, op.operation_id, op.claim_id);
    const host = await daemon.host(hostId) as typeof hosts.$inferSelect;
    const registered = await portal.registerAgent(host, {
      engine: 'codex',
      username: 'root',
      cwd: '/tmp',
      invocationKind: 'execute',
      upstreamSessionId: null,
    });
    if (!registered.enabled) throw new Error('Portal disabled');
    firstPortal = registered.session_id;
    address = randomUUID();
    await ctx.db
      .insert(agentBusAddresses)
      .values({
        id: address,
        address: `agent:${address}`,
        launchName: 'Testname',
        hostId,
        engine: 'codex',
        username: 'root',
        cwd: '/tmp',
        cwdHash: createHash('sha256').update('/tmp').digest('hex'),
        lastUpstreamSessionId: null,
        lastSeenAt: nowIso(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    await daemon.bind(hostId, op.operation_id, op.claim_id, firstPortal, address);
    expect(
      await ctx.db.select().from(companionFollows).where(eq(companionFollows.sessionId, firstPortal)),
    ).toHaveLength(1);
    await portal.addAgentEvent(
      firstPortal,
      registered.bridge_token,
      {
        clientEventId: randomUUID(),
        source: 'bridge',
        type: 'assistant_message',
        payload: { text: 'I am ready.', summary: 'Ready for your instruction.' },
      },
      hostId,
    );
    await portal.finishAgent(
      firstPortal,
      registered.bridge_token,
      { status: 'completed', summary: 'done' },
      hostId,
    );
    await daemon.complete(hostId, op.operation_id, op.claim_id, {
      status: 'completed',
      reply: 'I am ready.',
      upstream_session_id: 'native-test',
    });
    expect((await snapshot()).find((s) => s.id === logical)).toMatchObject({
      remote_status: 'idle',
      relay_ready: true,
      read_only: false,
      upstream_session_id: 'native-test',
      unread_reply_count: 1,
    });
    expect((await snapshot()).some((s) => s.id === firstPortal)).toBe(false);
    const [nativeAddress] = await ctx.db.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, address));
    expect(nativeAddress?.lastUpstreamSessionId).toBe('native-test');
  });
  it('resumes the same transcript and replays a lost send response even after acceptance', async () => {
    const payload = { client_message_id: randomUUID(), content: 'Do the next step.' };
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/companion/v1/agents/${logical}/messages`,
        headers: headers(),
        payload,
      });
    const first = await send();
    expect(first.statusCode, first.body).toBe(202);
    const op = (await daemon.offer(hostId, generation))!;
    expect(op.upstream_session_id).toBe('native-test');
    await daemon.accept(hostId, op.operation_id, op.claim_id);
    expect((await send()).json()).toEqual(first.json());
    const host = await daemon.host(hostId) as typeof hosts.$inferSelect;
    const registration = { engine: 'codex', username: 'root', cwd: '/tmp',
      invocation_kind: 'peer_delivery', upstream_session_id: 'native-test', resumed: true,
      session_id: randomUUID(), bridge_token: randomBytes(32).toString('base64url'),
      daemon_operation_id: op.operation_id, daemon_claim_id: op.claim_id,
      agent_address: `agent:${address}`, binding_generation: op.binding_generation, continuity: 'native' };
    const register = () => app.inject({ method: 'POST', url: '/host/agent-sessions',
      headers: { 'x-api-key': host.apiKey }, payload: registration });
    const response = await register();
    expect(response.statusCode, response.body).toBe(200);
    const reg = response.json();
    expect(reg.capabilities).toEqual({ portal: true, agent_messaging: true });
    expect((await register()).statusCode).toBe(200);
    expect((await daemon.session(logical)).sessionId).toBe(reg.session_id);
    await portal.addAgentEvent(
      reg.session_id,
      reg.bridge_token,
      {
        clientEventId: randomUUID(),
        source: 'bridge',
        type: 'waiting_input',
        payload: {
          prompt_id: randomUUID(),
          question: 'Which target?',
          allow_answer: true,
          summary: 'Choose a target.',
        },
      },
      hostId,
    );
    await portal.finishAgent(
      reg.session_id,
      reg.bridge_token,
      { status: 'completed', summary: 'Waiting' },
      hostId,
    );
    await daemon.complete(hostId, op.operation_id, op.claim_id, {
      status: 'completed',
      reply: 'Which target?',
      upstream_session_id: 'native-test',
    });
    const card = (await snapshot()).find((s) => s.id === logical)!;
    expect(card).toMatchObject({ remote_status: 'waiting', relay_ready: true });
    const events = (
      await app.inject({ url: `/companion/v1/agents/${logical}/events`, headers: headers() })
    ).json().data.events;
    expect(events.filter((e: { type: string }) => e.type === 'user_message')).toHaveLength(2);
    expect(events.some((e: { payload: { text?: string } }) => e.payload.text === 'I am ready.')).toBe(true);
    const prompt = card.pending_prompt as { id: string; version: number };
    const answer = { client_message_id: randomUUID(), answer: 'Staging', version: prompt.version };
    const reply = () =>
      app.inject({
        method: 'POST',
        url: `/companion/v1/agents/${logical}/prompts/${prompt.id}/answer`,
        headers: headers(),
        payload: answer,
      });
    expect((await reply()).statusCode).toBe(202);
    expect((await reply()).statusCode).toBe(202);
    expect((await ctx.db.select().from(agentPrompts).where(eq(agentPrompts.id, prompt.id)))[0]?.status).toBe(
      'answered',
    );
  });
  it('sends push to the logical conversation including the first genuine reply', async () => {
    const events = await ctx.db.select().from(agentEvents).where(eq(agentEvents.sessionId, firstPortal));
    const greeting = events.find((e) => e.eventType === 'assistant_message')!;
    await ctx.db
      .update(companionDevices)
      .set({ fcmTokenEnc: encrypt('test-token', ctx.keyring), eventCursor: greeting.id - 1 })
      .where(eq(companionDevices.id, deviceId));
    const worker = new CompanionPush({
      ...ctx,
      env: {
        ...ctx.env,
        COMPANION_FIREBASE_PROJECT_ID: 'test-project',
        COMPANION_FIREBASE_CREDENTIAL_FILE: '/unused',
      },
    });
    const send = vi.spyOn(worker.transport, 'send').mockResolvedValue('sent');
    await worker.tick();
    expect(
      send.mock.calls.some(
        ([, data]) =>
          data.target_id === logical &&
          data.event_cursor === String(greeting.id) &&
          data.summary === 'Ready for your instruction.',
      ),
    ).toBe(true);
    send.mockRestore();
    await ctx.db.update(companionDevices).set({ fcmTokenEnc: null }).where(eq(companionDevices.id, deviceId));
    const card = (await snapshot()).find((s) => s.id === logical)!;
    const read = await app.inject({
      method: 'POST',
      url: '/companion/v1/agents',
      headers: headers(),
      payload: { read_cursors: { [logical]: card.reply_cursor } },
    });
    expect(read.json().data.agents.find((s: { id: string }) => s.id === logical).unread_reply_count).toBe(0);
  });
  it('does not expose transcript or start rights after a role downgrade', async () => {
    await ctx.db.update(adminUsers).set({ accessLevel: 'viewer' }).where(eq(adminUsers.id, userId));
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/companion/v1/daemon-sessions',
          headers: headers(),
          payload: request(),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: `/companion/v1/agents/${logical}/events`, headers: headers() })).statusCode,
    ).toBe(403);
    await ctx.db.update(adminUsers).set({ accessLevel: 'owner' }).where(eq(adminUsers.id, userId));
  });
});
