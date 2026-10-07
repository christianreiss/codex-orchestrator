import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { getTestDb } from '../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../helpers/test-keyring.js';
import { runMigrations } from '../../src/db/migrator.js';
import {
  adminUsers,
  agentEvents,
  agentSessions,
  companionDevices,
  companionFollows,
  companionNotifications,
  companionPairings,
  hosts,
  insecureAuthRequests,
} from '../../src/db/schema.js';
import { CompanionDevices } from '../../src/services/companion/devices.js';
import { CompanionPush } from '../../src/services/companion/push.js';
import { InsecureWindowAdminService } from '../../src/services/insecure-window-admin.js';
import { makeAdminEventsWriter } from '../../src/services/admin-events-writer.js';
import { registerCompanionRoutes } from '../../src/routes/companion/index.js';
import { createAgentPortalService } from '../../src/services/agent-portal.js';
import { envelopePlugin } from '../../src/http/plugins/envelope.js';
import { encrypt } from '../../src/security/secret-box.js';
import { isoOffsetSeconds, nowIso } from '../../src/util/timestamp.js';
import { companionPreviews } from '../../src/services/companion/summary.js';
import { wsPublisher } from '../../src/ws/publisher.js';
import { SettingsService } from '../../src/services/settings.js';

const handle = await getTestDb();

describe.skipIf(!handle)('Android companion with real MySQL', { timeout: 120_000 }, () => {
  const db = handle ? handle.db : null!;
  const env = {
    ...loadTestEnv(),
    PUBLIC_BASE_URL: 'https://fleet.example',
    COMPANION_FIREBASE_PROJECT_ID: 'test-project',
    COMPANION_FIREBASE_CREDENTIAL_FILE: '/unused/test-credential',
  };
  const ctx = { db, env, keyring: testKeyring() };
  const devices = new CompanionDevices(ctx);
  let userId: number;
  let hostId: number;
  let connection: Awaited<ReturnType<CompanionDevices['exchange']>>;
  let sessionId: string;
  let bridge: string;
  const portal = createAgentPortalService(db, env, ctx.keyring);
  const insecure = new InsecureWindowAdminService({ db, env, events: makeAdminEventsWriter(db) });
  const app = Fastify();
  const unique = `companion-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await runMigrations(handle!.pool, { appliedBy: 'companion-tests' });
    const [u] = await db.insert(adminUsers).values({
      name: unique,
      username: unique,
      email: `${unique}@example.test`,
      passwordHash: 'test-only',
      accessLevel: 'owner',
      active: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    userId = u.insertId;
    const [h] = await db.insert(hosts).values({
      fqdn: `${unique}.example.test`,
      apiKey: randomBytes(32).toString('hex'),
      secure: 0,
      status: 'active',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    hostId = h.insertId;
    app.decorate('requireAdmin', async () => {});
    await app.register(envelopePlugin);
    await registerCompanionRoutes(app, {
      ...ctx,
      env: { ...env, COMPANION_FIREBASE_CREDENTIAL_FILE: undefined },
    });
    await app.ready();
    await portal.setEnabled(true);
    const [host] = await db.select().from(hosts).where(eq(hosts.id, hostId));
    const registered = await portal.registerAgent(host!, {
      engine: 'codex',
      username: 'test',
      cwd: '/tmp/companion',
      invocationKind: 'interactive',
    });
    if (!registered.enabled) throw new Error('Registration disabled');
    sessionId = registered.session_id;
    bridge = registered.bridge_token;
    await portal.heartbeatAgent(sessionId, bridge, { relayAction: 'poll' }, hostId);
  });
  afterAll(async () => {
    await app.close();
    await portal.setEnabled(false);
    // Isolated test DB; keep source events for the other canonical integration suites.
    if (connection) {
      await db
        .delete(companionNotifications)
        .where(eq(companionNotifications.deviceId, connection.device_id));
      await db.delete(companionFollows).where(eq(companionFollows.deviceId, connection.device_id));
    }
    await db.delete(companionDevices).where(eq(companionDevices.userId, userId));
    await db.delete(companionPairings).where(eq(companionPairings.userId, userId));
    await db.delete(adminUsers).where(eq(adminUsers.id, userId));
    await handle?.pool.end();
  });
  const authorization = () => `Bearer ${connection.token}`;

  it('consumes a QR token exactly once under concurrent exchange', async () => {
    const pairing = JSON.parse((await devices.pair(userId)).qr);
    const results = await Promise.allSettled([
      devices.exchange(pairing.token, 'Phone'),
      devices.exchange(pairing.token, 'Other phone'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    connection = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<typeof connection>)
      .value;
    const [stored] = await db
      .select()
      .from(companionDevices)
      .where(eq(companionDevices.id, connection.device_id));
    expect(stored!.tokenHash).not.toEqual(connection.token);
  });
  it('rejects expired pairing codes', async () => {
    const pairing = JSON.parse((await devices.pair(userId)).qr);
    await db
      .update(companionPairings)
      .set({ expiresAt: isoOffsetSeconds(-1) })
      .where(eq(companionPairings.userId, userId));
    await expect(devices.exchange(pairing.token, 'Phone')).rejects.toMatchObject({ code: 'pairing_invalid' });
  });
  it('rejects browser origins, missing credentials and live role changes', async () => {
    expect((await app.inject({ url: '/companion/v1/me' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: '/companion/v1/me',
          headers: { authorization: authorization(), origin: 'https://fleet.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: '/companion/v1/me', headers: { authorization: authorization() } })).statusCode,
    ).toBe(200);
    await db.update(adminUsers).set({ accessLevel: 'viewer' }).where(eq(adminUsers.id, userId));
    expect(
      (await app.inject({ url: '/companion/v1/approvals', headers: { authorization: authorization() } }))
        .statusCode,
    ).toBe(403);
    await db.update(adminUsers).set({ accessLevel: 'owner' }).where(eq(adminUsers.id, userId));
  });
  it('preserves message retry identity and follows the conversation', async () => {
    const payload = { client_message_id: randomUUID(), content: 'Companion hello' };
    const request = {
      method: 'POST' as const,
      url: `/companion/v1/agents/${sessionId}/messages`,
      headers: { authorization: authorization() },
      payload,
    };
    const first = await app.inject(request);
    expect(first.statusCode, first.body).toBe(202);
    expect((await app.inject(request)).json()).toEqual(first.json());
    expect(
      (await app.inject({ ...request, payload: { ...payload, content: 'Different content' } })).statusCode,
    ).toBe(409);
    expect(
      await db.select().from(companionFollows).where(eq(companionFollows.deviceId, connection.device_id)),
    ).toHaveLength(1);
  });
  it('serializes competing desktop and mobile decisions', async () => {
    const [r] = await db
      .insert(insecureAuthRequests)
      .values({ hostId, status: 'pending', requestedAt: isoOffsetSeconds(-2), updatedAt: nowIso() });
    const results = await Promise.allSettled([insecure.approve(r.insertId, 60), insecure.deny(r.insertId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.status).toBe(409);
    const [request] = await db
      .select()
      .from(insecureAuthRequests)
      .where(eq(insecureAuthRequests.id, r.insertId));
    const [host] = await db.select().from(hosts).where(eq(hosts.id, hostId));
    if (request!.status === 'denied') expect(host!.insecureEnabledUntil).toBeNull();
    else expect(host!.insecureEnabledUntil).not.toBeNull();
  });
  it('rejects an expired request without granting access', async () => {
    const [r] = await db
      .insert(insecureAuthRequests)
      .values({ hostId, status: 'pending', requestedAt: isoOffsetSeconds(-360), updatedAt: nowIso() });
    await expect(insecure.approve(r.insertId, 480)).rejects.toMatchObject({ status: 409 });
  });
  it('persists retry jobs, deduplicates and clears invalid FCM tokens', async () => {
    await db
      .update(companionDevices)
      .set({ fcmTokenEnc: encrypt('test-token', ctx.keyring) })
      .where(eq(companionDevices.id, connection.device_id));
    const [originalEvent] = await db.insert(agentEvents).values({
      sessionId,
      clientEventId: randomUUID(),
      eventType: 'assistant_message',
      source: 'bridge',
      payloadEnc: encrypt(JSON.stringify({ text: 'reply', summary: 'Original result.' }), ctx.keyring),
      createdAt: nowIso(),
    });
    const worker = new CompanionPush(ctx);
    const send = vi
      .spyOn(worker.transport, 'send')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('sent');
    await worker.tick();
    const rows = await db
      .select()
      .from(companionNotifications)
      .where(eq(companionNotifications.deviceId, connection.device_id));
    const reply = rows.find((r) => r.kind === 'reply')!;
    expect(reply.state).toBe('pending');
    await db.insert(agentEvents).values({
      sessionId,
      clientEventId: randomUUID(),
      eventType: 'assistant_message',
      source: 'bridge',
      payloadEnc: encrypt(JSON.stringify({ text: 'later reply', summary: 'Later result.' }), ctx.keyring),
      createdAt: nowIso(),
    });
    await db
      .update(companionNotifications)
      .set({ nextAttemptAt: isoOffsetSeconds(-1) })
      .where(eq(companionNotifications.id, reply.id));
    await worker.tick();
    await worker.tick();
    expect(send.mock.calls.filter((c) => c[1].notification_id === reply.id)).toHaveLength(2);
    expect(send.mock.calls.filter((c) => c[1].notification_id === reply.id).map((c) => c[1].summary)).toEqual(
      ['Original result.', 'Original result.'],
    );
    expect(
      send.mock.calls.filter((c) => c[1].notification_id === reply.id).map((c) => c[1].event_cursor),
    ).toEqual([String(originalEvent.insertId), String(originalEvent.insertId)]);
    expect(send.mock.calls[0]![1]).not.toHaveProperty('text');
    const [attentionEvent] = await db.insert(agentEvents).values({
      sessionId,
      clientEventId: randomUUID(),
      eventType: 'attention',
      source: 'bridge',
      payloadEnc: encrypt(JSON.stringify({ summary: 'needs you' }), ctx.keyring),
      createdAt: nowIso(),
    });
    send.mockResolvedValue('invalid');
    await worker.tick();
    expect(send.mock.calls.find((c) => c[1].kind === 'attention')?.[1].event_cursor).toBe(
      String(attentionEvent.insertId),
    );
    expect(
      (await db.select().from(companionDevices).where(eq(companionDevices.id, connection.device_id)))[0]!
        .fcmTokenEnc,
    ).toBeNull();
  });
  it('projects the latest reply, prioritizes an active question and never reuses an older summary', async () => {
    const put = async (type: string, payload: Record<string, unknown>) => {
      const [result] = await db.insert(agentEvents).values({
        sessionId,
        clientEventId: randomUUID(),
        eventType: type,
        source: 'bridge',
        payloadEnc: encrypt(JSON.stringify(payload), ctx.keyring),
        createdAt: nowIso(),
      });
      return result.insertId;
    };
    const firstReply = await put('assistant_message', { text: 'Full answer', summary: 'Build passed.' });
    const base = { id: sessionId, pending_prompt: null, attention: null };
    expect((await companionPreviews(ctx, [base]))[0]).toMatchObject({
      reply_cursor: firstReply,
      preview: { summary: 'Build passed.' },
    });
    const secondReply = await put('assistant_message', { text: 'New answer without summary' });
    expect((await companionPreviews(ctx, [base]))[0]).toMatchObject({
      reply_cursor: secondReply,
      preview: { summary: 'New reply from the agent.' },
    });
    const question = await put('waiting_input', {
      prompt_id: 'question',
      question: 'Full question',
      summary: 'Choose a target.',
    });
    const pending = { ...base, pending_prompt: { id: 'question' } };
    expect((await companionPreviews(ctx, [pending]))[0]).toMatchObject({
      reply_cursor: secondReply,
      preview: { cursor: question, summary: 'Choose a target.' },
    });
    const thirdReply = await put('assistant_message', {
      text: 'Reply after question',
      summary: 'More done.',
    });
    expect((await companionPreviews(ctx, [pending]))[0]).toMatchObject({
      reply_cursor: thirdReply,
      preview: { cursor: question, summary: 'Choose a target.' },
    });
    const attention = await put('attention', { summary: 'Review the result.' });
    const fourthReply = await put('assistant_message', { text: 'Reply after notice', summary: 'All done.' });
    expect((await companionPreviews(ctx, [{ ...base, attention: { since: nowIso() } }]))[0]).toMatchObject({
      reply_cursor: fourthReply,
      preview: { cursor: attention, summary: 'Review the result.' },
    });
    expect((await companionPreviews(ctx, [{ ...base, id: randomUUID() }]))[0]).toMatchObject({
      reply_cursor: 0,
      preview: null,
    });
    await db.update(adminUsers).set({ accessLevel: 'viewer' }).where(eq(adminUsers.id, userId));
    const hidden = await app.inject({
      url: '/companion/v1/agents',
      headers: { authorization: authorization() },
    });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.body).not.toContain('Build passed.');
    expect(hidden.json().data.agents.find((a: { id: string }) => a.id === sessionId)).toMatchObject({
      reply_cursor: null,
      preview: null,
    });
    await db.update(adminUsers).set({ accessLevel: 'owner' }).where(eq(adminUsers.id, userId));
  });
  it('retains reply cursors and readable history for offline and ended conversations', async () => {
    const [host] = await db.select().from(hosts).where(eq(hosts.id, hostId));
    const registered = await portal.registerAgent(host!, {
      engine: 'codex',
      username: 'test',
      cwd: '/tmp/companion-retained',
      invocationKind: 'interactive',
    });
    if (!registered.enabled) throw new Error('Registration disabled');
    const id = registered.session_id;
    const [reply] = await db.insert(agentEvents).values({
      sessionId: id,
      clientEventId: randomUUID(),
      eventType: 'assistant_message',
      source: 'bridge',
      payloadEnc: encrypt(
        JSON.stringify({ text: 'Retained answer', summary: 'Work finished.' }),
        ctx.keyring,
      ),
      createdAt: nowIso(),
    });
    await db
      .update(agentSessions)
      .set({ heartbeatAt: isoOffsetSeconds(-3600) })
      .where(eq(agentSessions.id, id));
    const snapshot = async () => {
      const result = await app.inject({
        url: '/companion/v1/agents',
        headers: { authorization: authorization() },
      });
      expect(result.statusCode).toBe(200);
      return result.json().data.agents.find((a: { id: string }) => a.id === id);
    };
    expect(await snapshot()).toMatchObject({ presence: 'offline', reply_cursor: reply.insertId });
    await db
      .update(agentSessions)
      .set({ status: 'completed', endedAt: nowIso(), expiresAt: isoOffsetSeconds(3600) })
      .where(eq(agentSessions.id, id));
    expect(await snapshot()).toMatchObject({
      presence: 'ended',
      read_only: true,
      reply_cursor: reply.insertId,
    });
    const history = await app.inject({
      url: `/companion/v1/agents/${id}/events?tail=1`,
      headers: { authorization: authorization() },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().data.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cursor: reply.insertId, type: 'assistant_message' }),
      ]),
    );
  });
  it('upgrades with a native bearer, invalidates immediately and closes on the kill switch', async () => {
    const frames: Array<{ type: string; scopes?: string[] }> = [];
    const socket = await app.injectWS(
      '/companion/v1/ws',
      { headers: { authorization: authorization() } },
      {
        onInit: (ws) => ws.on('message', (raw: Buffer) => frames.push(JSON.parse(raw.toString()))),
      },
    );
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'hello')).toBe(true));
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'changed')).toBe(true));
    frames.length = 0;
    wsPublisher.publish('agent_portal.sessions.changed', { session_id: sessionId });
    await vi.waitFor(() => expect(frames.some((f) => f.scopes?.includes('agents'))).toBe(true));
    const settings = new SettingsService(db);
    try {
      await settings.setFlag('api_disabled', true);
      await vi.waitFor(() => expect(socket.readyState).toBe(3));
      expect(
        (await app.inject({ url: '/companion/v1/me', headers: { authorization: authorization() } }))
          .statusCode,
      ).toBe(503);
    } finally {
      socket.terminate();
      await settings.setFlag('api_disabled', false);
    }
  });
  it('revocation immediately rejects the old bearer and an existing socket', async () => {
    const socket = await app.injectWS('/companion/v1/ws', { headers: { authorization: authorization() } });
    await devices.revoke(userId, connection.device_id);
    await expect(devices.authenticate(authorization())).rejects.toMatchObject({ code: 'device_revoked' });
    await vi.waitFor(() => expect(socket.readyState).toBe(3));
  });
});
