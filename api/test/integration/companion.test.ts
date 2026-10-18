import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAgentChatRoutes } from '../../src/routes/agent-chat.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { getTestDb } from '../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../helpers/test-keyring.js';
import { runMigrations } from '../../src/db/migrator.js';
import {
  adminUsers,
  agentEvents,
  agentChatNotices,
  agentChatAttachments,
  agentSessions,
  companionDevices,
  companionFollows,
  companionNotifications,
  companionPairings,
  hosts,
  insecureAuthRequests,
  insecureDomainAllows,
  logs,
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
  let chatRoot: string;
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
    chatRoot = await mkdtemp(join(tmpdir(),'companion-chat-')); ctx.env.DATA_ROOT = chatRoot;
    app.decorate('requireAdmin', async () => {});
    // This fixture exercises companion bearer auth; admin-only routes are registered but not called.
    app.decorate('requireCapability', () => async () => {});
    await app.register(envelopePlugin);
    await registerCompanionRoutes(app, {
      ...ctx,
      env: { ...env, COMPANION_FIREBASE_CREDENTIAL_FILE: undefined },
    });
    await registerAgentChatRoutes(app,ctx);
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
    await db.delete(agentChatNotices).where(eq(agentChatNotices.sessionId,sessionId));
    await db.delete(agentChatAttachments).where(eq(agentChatAttachments.sessionId,sessionId));
    await rm(chatRoot,{recursive:true,force:true});
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
    for (const url of [`/companion/v1/hosts/${hostId}/insecure/disable`, '/companion/v1/insecure/window/close']) {
      expect((await app.inject({ method: 'POST', url })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url, headers: { authorization: authorization() } })).statusCode).toBe(403);
    }
    await db.update(adminUsers).set({ accessLevel: 'owner' }).where(eq(adminUsers.id, userId));
  });
  it('projects only active insecure windows, independently of daemon availability, with domain reopening hints', async () => {
    const fixtureIds: number[] = [];
    const domain = `${unique}.window.test`;
    const [allow] = await db.insert(insecureDomainAllows).values({ domain, windowMinutes: 60, enabledUntil: null, createdAt: nowIso(), updatedAt: nowIso() });
    try {
      for (const [name, secure, seconds] of [['active', 0, 3600], ['expired', 0, -1], ['secure', 1, 3600], ['closed', 0, 0]] as const) {
        const [row] = await db.insert(hosts).values({ fqdn: `${name}.${domain}`, apiKey: randomBytes(32).toString('hex'), secure, status: 'active', insecureEnabledUntil: seconds ? new Date(Date.now() + seconds * 1000) : null, createdAt: nowIso(), updatedAt: nowIso() });
        fixtureIds.push(row.insertId);
      }
      const response = await app.inject({ url: '/companion/v1/approvals', headers: { authorization: authorization() } });
      expect(response.statusCode, response.body).toBe(200);
      const data = response.json().data;
      expect(data.default_duration_minutes).toBe(480);
      expect(data.requests).toBeInstanceOf(Array);
      expect(data.fleet_window).toEqual({ open: false, enabled_until: null });
      const projected = data.active_windows.filter((w: { host_id: number }) => fixtureIds.includes(w.host_id));
      expect(projected).toEqual([{ host_id: fixtureIds[0], fqdn: `active.${domain}`, enabled_until: expect.any(String), domain_allow: domain }]);
      expect(response.body).not.toContain('apiKey');
      await db.update(insecureDomainAllows).set({ enabledUntil: isoOffsetSeconds(-1) }).where(eq(insecureDomainAllows.id, allow.insertId));
      expect((await insecure.accessWindows()).active_windows.find((w) => w.host_id === fixtureIds[0])?.domain_allow).toBeNull();
      await db.update(insecureDomainAllows).set({ enabledUntil: null, revokedAt: nowIso() }).where(eq(insecureDomainAllows.id, allow.insertId));
      expect((await insecure.accessWindows()).active_windows.find((w) => w.host_id === fixtureIds[0])?.domain_allow).toBeNull();
    } finally {
      for (const id of fixtureIds) await db.delete(hosts).where(eq(hosts.id, id));
      await db.delete(insecureDomainAllows).where(eq(insecureDomainAllows.id, allow.insertId));
    }
  });
  it('closes host access idempotently, blocks automatic session renewal and audits the paired actor', async () => {
    await insecure.enable(hostId, 60);
    const post = (id: number | string) => app.inject({ method: 'POST', url: `/companion/v1/hosts/${id}/insecure/disable`, headers: { authorization: authorization() } });
    expect((await post('invalid')).statusCode).toBe(422);
    expect((await post(2_000_000_000)).statusCode).toBe(404);
    expect((await post(hostId)).json().data).toEqual({ host_id: hostId, enabled_until: null });
    expect((await post(hostId)).statusCode).toBe(200);
    const [host] = await db.select().from(hosts).where(eq(hosts.id, hostId));
    expect(host).toMatchObject({ insecureEnabledUntil: null, insecureGraceUntil: null, insecureSessionRenewalBlocked: 1 });
    const [log] = await db.select().from(logs).where(eq(logs.hostId, hostId)).orderBy(desc(logs.id)).limit(1);
    expect(JSON.parse(log!.details!)).toMatchObject({ actor: { admin_user_id: userId, device_id: connection.device_id } });
  });
  it('exposes the fleet window, rejects per-host close and closes all standing grants with a device audit', async () => {
    const [domain] = await db.insert(insecureDomainAllows).values({ domain: `${unique}.fleet.test`, windowMinutes: 60, enabledUntil: null, createdAt: nowIso(), updatedAt: nowIso() });
    const close = () => app.inject({ method: 'POST', url: '/companion/v1/insecure/window/close', headers: { authorization: authorization() } });
    try {
      await insecure.openFleetWindow(60);
      const overview = await app.inject({ url: '/companion/v1/approvals', headers: { authorization: authorization() } });
      expect(overview.json().data.fleet_window).toEqual({ open: true, enabled_until: expect.any(String) });
      const refused = await app.inject({ method: 'POST', url: `/companion/v1/hosts/${hostId}/insecure/disable`, headers: { authorization: authorization() } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('insecure_fleet_window_open');
      const closed = await close();
      expect(closed.statusCode, closed.body).toBe(200);
      expect(closed.json().data).toMatchObject({ closed: true, hosts: expect.any(Number), domains: 1 });
      expect(await insecure.accessWindows()).toEqual({ active_windows: [], fleet_window: { open: false, enabled_until: null } });
      const [grant] = await db.select().from(insecureDomainAllows).where(eq(insecureDomainAllows.id, domain.insertId));
      expect(new Date(grant!.enabledUntil!).getTime()).toBeLessThanOrEqual(Date.now());
      const [log] = await db.select().from(logs).where(eq(logs.action, 'admin.insecure.fleet_window_close')).orderBy(desc(logs.id)).limit(1);
      expect(JSON.parse(log!.details!)).toMatchObject({ actor: { admin_user_id: userId, device_id: connection.device_id } });
      expect((await close()).json().data).toMatchObject({ closed: false, hosts: 0, domains: 0 });
    } finally {
      if ((await insecure.fleetWindowState()).open) await insecure.closeFleetWindow('manual');
      await db.delete(insecureDomainAllows).where(eq(insecureDomainAllows.id, domain.insertId));
    }
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
  it('uploads attachment-only messages and authorizes byte-range media downloads', async () => {
    const attachment = randomUUID(); const base = `/companion/v1/agents/${sessionId}/attachments`;
    const post = (url:string,payload:unknown) => app.inject({method:'POST',url,headers:{authorization:authorization()},payload:payload as Record<string,unknown>});
    expect((await post(base,{id:attachment,name:'sample.txt',mime_type:'text/plain',size_bytes:6})).statusCode).toBe(200);
    expect((await post(`${base}/${attachment}/chunks`,{offset:0,content_b64:Buffer.from('abcdef').toString('base64')})).statusCode).toBe(200);
    expect((await post(`${base}/${attachment}/seal`,{})).statusCode).toBe(200);
    const message=await post(`/companion/v1/agents/${sessionId}/messages`,{client_message_id:randomUUID(),content:'',metadata:{attachments:[attachment]}});
    expect(message.statusCode,message.body).toBe(202);
    const partial=await app.inject({url:`${base}/${attachment}/content`,headers:{authorization:authorization(),range:'bytes=2-4'}});
    expect(partial.statusCode,partial.body).toBe(206); expect(partial.body).toBe('cde'); expect(partial.headers['content-range']).toBe('bytes 2-4/6');
    expect((await app.inject({url:`${base}/${attachment}/content`})).statusCode).toBe(401);
    expect((await app.inject({url:`${base}/${attachment}/content`,headers:{authorization:authorization(),range:'bytes=99-100'}})).statusCode).toBe(416);
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
  it('deduplicates urgency pushes by notice and severity and cancels resolved notices', async () => {
    await db.update(companionDevices).set({fcmTokenEnc:encrypt('test-token',ctx.keyring)}).where(eq(companionDevices.id,connection.device_id));
    const worker=new CompanionPush(ctx);const send=vi.spyOn(worker.transport,'send').mockResolvedValue('sent');
    const notice=randomUUID();
    const notify=(severity:string,summary:string) => portal.addAgentEvent(sessionId,bridge,{clientEventId:randomUUID(),type:'attention',source:'engine',payload:{notice_id:notice,severity,summary}});
    await notify('important','Review this result.');await worker.tick();
    await notify('important','Review this result.');await worker.tick();
    expect(send.mock.calls.filter(c=>c[1].notice_id===notice)).toHaveLength(1);
    expect(send.mock.calls.find(c=>c[1].notice_id===notice)?.[1].summary).toBe('Review this result.');
    await notify('critical','The result is critical.');await worker.tick();
    expect(send.mock.calls.filter(c=>c[1].notice_id===notice)).toHaveLength(2);
    await notify('blocker','Blocked pending review.');
    await portal.resolveNotice({kind:'admin',user:{id:userId,displayName:'Test'}},sessionId,notice,randomUUID());await worker.tick();
    expect(send.mock.calls.filter(c=>c[1].notice_id===notice)).toHaveLength(2);
  });
  it('does not reveal classified notice content after transcript access is revoked', async () => {
    const notice=randomUUID();await portal.addAgentEvent(sessionId,bridge,{clientEventId:randomUUID(),type:'attention',source:'engine',payload:{notice_id:notice,severity:'critical',summary:'Private classified summary'}});
    await db.update(adminUsers).set({accessLevel:'viewer'}).where(eq(adminUsers.id,userId));
    try {
      const response=await app.inject({url:'/companion/v1/agents',headers:{authorization:authorization()}});
      expect(response.statusCode,response.body).toBe(200);expect(response.body).not.toContain('Private classified summary');
      expect(response.json().data.agents.find((a:{id:string})=>a.id===sessionId).notices).toEqual([]);
    } finally {
      await db.update(adminUsers).set({accessLevel:'owner'}).where(eq(adminUsers.id,userId));await portal.resolveNotice({kind:'admin',user:{id:userId,displayName:'Test'}},sessionId,notice,randomUUID());
    }
  });
  it('projects renamed native sessions only with transcript permission without changing unread replies', async () => {
    const snapshot = async () => {
      const result = await app.inject({
        method: 'GET',
        url: '/companion/v1/agents',
        headers: { authorization: authorization() },
      });
      expect(result.statusCode).toBe(200);
      return result.json().data.agents.find((card: { id: string }) => card.id === sessionId);
    };
    const before = await snapshot();
    await Promise.all(
      ['API review', 'Other AI suggestion'].map((name) =>
        portal.addAgentEvent(sessionId, bridge, {
          clientEventId: randomUUID(),
          type: 'session_named',
          source: 'engine',
          payload: { name, only_if_missing: true },
        }),
      ),
    );
    const assigned = (await snapshot()).session_name;
    expect(['API review', 'Other AI suggestion']).toContain(assigned);
    await portal.addAgentEvent(sessionId, bridge, {
      clientEventId: randomUUID(),
      type: 'session_named',
      source: 'engine',
      payload: { name: 'Overwrite attempt', only_if_missing: true },
    });
    expect((await snapshot()).session_name).toBe(assigned);
    const event = randomUUID();
    await portal.addAgentEvent(sessionId, bridge, {
      clientEventId: event,
      type: 'session_named',
      source: 'engine',
      payload: { name: 'Release review', text: 'discard unrelated text' },
    });
    await portal.addAgentEvent(sessionId, bridge, {
      clientEventId: event,
      type: 'session_named',
      source: 'engine',
      payload: { name: 'Release review' },
    });
    expect(await snapshot()).toMatchObject({
      session_name: 'Release review',
      reply_cursor: before.reply_cursor,
      unread_reply_count: before.unread_reply_count,
    });
    await portal.addAgentEvent(sessionId, bridge, {
      clientEventId: randomUUID(),
      type: 'session_named',
      source: 'engine',
      payload: { name: 'Schema migration' },
    });
    expect(await snapshot()).toMatchObject({ session_name: 'Schema migration' });
    await db
      .update(agentSessions)
      .set({ upstreamSessionId: 'native-next' })
      .where(eq(agentSessions.id, sessionId));
    try {
      expect(await snapshot()).toMatchObject({ session_name: null });
      await expect(
        portal.addAgentEvent(sessionId, bridge, {
          clientEventId: randomUUID(),
          type: 'session_named',
          source: 'engine',
          payload: { name: 'Stale native name', native_session_id: 'native-old' },
        }),
      ).rejects.toMatchObject({ code: 'agent_session_name_stale' });
      await portal.addAgentEvent(sessionId, bridge, {
        clientEventId: randomUUID(),
        type: 'session_named',
        source: 'engine',
        payload: { name: 'Next task', only_if_missing: true },
      });
      expect(await snapshot()).toMatchObject({ session_name: 'Next task' });
    } finally {
      await db.update(agentSessions).set({ upstreamSessionId: null }).where(eq(agentSessions.id, sessionId));
    }
    await portal.addAgentEvent(sessionId, bridge, {
      clientEventId: randomUUID(),
      type: 'session_named',
      source: 'engine',
      payload: { name: 'Schema migration' },
    });
    await portal.addAgentEvent(sessionId, bridge, {
      clientEventId: randomUUID(),
      type: 'session_named',
      source: 'engine',
      payload: { name: 'AI suggestion', only_if_missing: true },
    });
    expect(await snapshot()).toMatchObject({ session_name: 'Schema migration' });
    await db.update(adminUsers).set({ accessLevel: 'viewer' }).where(eq(adminUsers.id, userId));
    try {
      expect(await snapshot()).toMatchObject({ session_name: null, task_title: null, preview: null });
    } finally {
      await db.update(adminUsers).set({ accessLevel: 'owner' }).where(eq(adminUsers.id, userId));
    }
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
      unread_reply_count: null,
      preview: null,
    });
    await db.update(adminUsers).set({ accessLevel: 'owner' }).where(eq(adminUsers.id, userId));
  });
  it('counts only unread replies in each session without persisting client read markers', async () => {
    const [host] = await db.select().from(hosts).where(eq(hosts.id, hostId));
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const registered = await portal.registerAgent(host!, {
        engine: 'codex',
        username: 'test',
        cwd: `/tmp/companion-count-${i}`,
        invocationKind: 'interactive',
      });
      if (!registered.enabled) throw new Error('Registration disabled');
      ids.push(registered.session_id);
    }
    const [first, other, empty] = ids as [string, string, string];
    const put = async (id: string, type: string) => {
      const [row] = await db.insert(agentEvents).values({
        sessionId: id,
        clientEventId: randomUUID(),
        eventType: type,
        source: 'bridge',
        payloadEnc: encrypt(JSON.stringify({ text: type, summary: 'Count fixture.' }), ctx.keyring),
        createdAt: nowIso(),
      });
      return row.insertId;
    };
    const older = await put(first, 'assistant_message');
    await put(first, 'progress');
    await put(first, 'user_message');
    const foreign = await put(other, 'assistant_message');
    const latest = await put(first, 'assistant_message');
    await put(first, 'waiting_input');
    await put(first, 'attention');
    const before = await db
      .select()
      .from(companionDevices)
      .where(eq(companionDevices.id, connection.device_id));
    const snapshot = async (readCursors?: Record<string, number | string>) => {
      const result = await app.inject({
        method: readCursors ? 'POST' : 'GET',
        url: '/companion/v1/agents',
        headers: { authorization: authorization() },
        ...(readCursors ? { payload: { read_cursors: readCursors } } : {}),
      });
      expect(result.statusCode, result.body).toBe(200);
      return result.json().data.agents as Array<{
        id: string;
        unread_reply_count: number;
        reply_cursor: number;
      }>;
    };
    const cards = await snapshot();
    expect(cards.find((card) => card.id === first)).toMatchObject({
      reply_cursor: latest,
      unread_reply_count: 2,
    });
    expect(cards.find((card) => card.id === other)).toMatchObject({ unread_reply_count: 1 });
    expect(cards.find((card) => card.id === empty)).toMatchObject({ reply_cursor: 0, unread_reply_count: 0 });
    const marked = await snapshot({
      [first]: older,
      [other]: String(foreign),
      [randomUUID()]: Number.MAX_SAFE_INTEGER,
    });
    expect(marked.find((card) => card.id === first)).toMatchObject({ unread_reply_count: 1 });
    expect(marked.find((card) => card.id === other)).toMatchObject({ unread_reply_count: 0 });
    expect((await snapshot({ [first]: latest })).find((card) => card.id === first)).toMatchObject({
      unread_reply_count: 0,
    });
    expect((await snapshot()).find((card) => card.id === first)).toMatchObject({ unread_reply_count: 2 });
    expect((await snapshot()).find((card) => card.id === first)).toMatchObject({ unread_reply_count: 2 });
    expect(
      await db.select().from(companionDevices).where(eq(companionDevices.id, connection.device_id)),
    ).toEqual(before);
  });
  it('validates bounded UUID read maps and preserves snapshot permission and portal gates', async () => {
    const request = {
      method: 'POST' as const,
      url: '/companion/v1/agents',
      headers: { authorization: authorization() },
    };
    const tooMany = Object.fromEntries(Array.from({ length: 501 }, () => [randomUUID(), 0]));
    for (const payload of [
      {},
      { read_cursors: null },
      { read_cursors: [] },
      { read_cursors: { 'invalid-session': 0 } },
      { read_cursors: JSON.parse('{"__proto__":0}') },
      { read_cursors: { [sessionId]: -1 } },
      { read_cursors: { [sessionId]: 1.5 } },
      { read_cursors: { [sessionId]: true } },
      { read_cursors: { [sessionId]: Number.MAX_SAFE_INTEGER + 1 } },
      { read_cursors: { [sessionId]: '9007199254740992' } },
      { read_cursors: { [sessionId]: '0 OR 1=1' } },
      { read_cursors: tooMany },
    ]) {
      expect((await app.inject({ ...request, payload })).statusCode).toBe(400);
    }
    expect(
      (
        await app.inject({
          ...request,
          payload: { read_cursors: Object.fromEntries(Object.entries(tooMany).slice(0, 500)) },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ ...request, headers: {}, payload: { read_cursors: {} } })).statusCode).toBe(
      401,
    );
    await db.update(adminUsers).set({ accessLevel: 'viewer' }).where(eq(adminUsers.id, userId));
    try {
      const hidden = await app.inject({ ...request, payload: { read_cursors: { [sessionId]: 0 } } });
      expect(hidden.statusCode).toBe(200);
      expect(hidden.json().data.agents.find((card: { id: string }) => card.id === sessionId)).toMatchObject({
        reply_cursor: null,
        unread_reply_count: null,
        preview: null,
      });
    } finally {
      await db.update(adminUsers).set({ accessLevel: 'owner' }).where(eq(adminUsers.id, userId));
    }
    await portal.setEnabled(false);
    try {
      expect((await app.inject({ ...request, payload: { read_cursors: {} } })).statusCode).toBe(503);
    } finally {
      await portal.setEnabled(true);
    }
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
  it('renews native activity on phones without a state change or transcript event', async () => {
    const [host] = await db.select().from(hosts).where(eq(hosts.id, hostId));
    const registered = await portal.registerAgent(host!, {
      engine: 'codex', username: 'activity-test', cwd: '/tmp/companion-activity', invocationKind: 'interactive',
    });
    if (!registered.enabled) throw new Error('Registration disabled');
    const id = registered.session_id;
    const nativeId = randomUUID();
    const generation = randomUUID();
    await db.update(agentSessions).set({ upstreamSessionId: nativeId, receiver: {
      generation, native_session_id: nativeId, protocol: 'codex-queue-v1', heartbeat_at: nowIso(),
      failure: null, probes: { portal: {} },
    } }).where(eq(agentSessions.id, id));
    const input = { generation, native_session_id: nativeId, binding_generation: 0, sequence: 1,
      state: 'working' as const, wait_reason: null, source: 'codex-thread' as const, evidence_age_ms: 10_000 };
    await portal.reportActivity(id, registered.bridge_token, input);
    const frames: Array<{ type: string; scopes?: string[] }> = [];
    const socket = await app.injectWS('/companion/v1/ws', { headers: { authorization: authorization() } }, {
      onInit: (ws) => ws.on('message', (raw: Buffer) => frames.push(JSON.parse(raw.toString()))),
    });
    try {
      // The initial subscription performs real database work too; use the same
      // bounded delivery budget as the subsequent activity notification.
      await vi.waitFor(() => expect(frames.some((f) => f.type === 'changed')).toBe(true), { timeout: 10_000 });
      frames.length = 0;
      const publish = vi.spyOn(wsPublisher, 'publish');
      try {
        await portal.reportActivity(id, registered.bridge_token, { ...input, sequence: 2, evidence_age_ms: 0 });
        expect(publish).not.toHaveBeenCalled();
      } finally { publish.mockRestore(); }
      await vi.waitFor(() => expect(frames.some((f) => f.scopes?.includes('agents'))).toBe(true), { timeout: 10_000 });
      const response = await app.inject({ url: '/companion/v1/agents', headers: { authorization: authorization() } });
      const row = response.json().data.agents.find((a: { id: string }) => a.id === id);
      expect(row.activity.state).toBe('working');
      expect(Date.parse(row.activity.expires_at)).toBeGreaterThan(Date.now() + 30_000);
      expect(row.active_turn_id).toBeNull();
    } finally {
      socket.terminate();
      await db.delete(agentSessions).where(eq(agentSessions.id, id));
    }
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
