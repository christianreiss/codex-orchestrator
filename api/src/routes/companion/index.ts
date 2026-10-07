import { setTimeout as delay } from 'node:timers/promises';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../index.js';
import { companionDevices, companionFollows } from '../../db/schema.js';
import { CompanionDevices } from '../../services/companion/devices.js';
import { startCompanionPush } from '../../services/companion/push.js';
import { companionPreviews } from '../../services/companion/summary.js';
import { CompanionLive } from '../../services/companion/live.js';
import { SettingsService } from '../../services/settings.js';
import { registerWebsocketTransport } from '../../ws/transport.js';
import { wsPublisher } from '../../ws/publisher.js';
import { capabilitiesForRole, type Capability } from '../../security/capabilities.js';
import { encrypt } from '../../security/secret-box.js';
import { createAgentPortalService, type PortalActor } from '../../services/agent-portal.js';
import { InsecureWindowAdminService } from '../../services/insecure-window-admin.js';
import { makeAdminEventsWriter } from '../../services/admin-events-writer.js';
import { ForbiddenError, ServiceUnavailableError } from '../../http/errors.js';
import { createSseLifecycle } from '../../http/sse-lifecycle.js';
import { isoOffsetSeconds, nowIso } from '../../util/timestamp.js';

const id = (req: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(req.params).id;
const message = z.object({ client_message_id: z.string().uuid(), content: z.string().min(1).max(32768) });

export async function registerCompanionRoutes(app: FastifyInstance, ctx: RouteContext) {
  await registerWebsocketTransport(app);
  const devices = new CompanionDevices(ctx);
  const settings = new SettingsService(ctx.db);
  const portal = createAgentPortalService(ctx.db, ctx.env, ctx.keyring);
  const insecure = new InsecureWindowAdminService({
    db: ctx.db,
    env: ctx.env,
    events: makeAdminEventsWriter(ctx.db),
  });
  const trackStream = createSseLifecycle(app);
  const checkEnabled = async () => {
    if (await settings.getFlag('api_disabled', false))
      throw new ServiceUnavailableError('API disabled by administrator', 'api_disabled');
  };
  const auth = async (req: FastifyRequest, capability?: Capability) => {
    await checkEnabled();
    return devices.authenticate(req.headers.authorization, capability);
  };
  const actor = (user: { id: number; name: string }): PortalActor => ({
    kind: 'admin',
    user: { id: user.id, displayName: user.name },
  });
  const follow = async (deviceId: string, sessionId: string) => {
    await ctx.db
      .insert(companionFollows)
      .values({ deviceId, sessionId })
      .onDuplicateKeyUpdate({ set: { sessionId } });
  };
  const requirePortal = async () => {
    if (!(await portal.isEnabled()))
      throw new ServiceUnavailableError('Agent portal is disabled', 'agent_portal_disabled');
  };
  const live = new CompanionLive({
    authorize: async (token) => {
      await checkEnabled();
      const { user } = await devices.authenticate(token);
      return capabilitiesForRole(user.accessLevel);
    },
    revisions: async () => {
      const enabled = await portal.isEnabled();
      const snapshot = enabled ? await portal.listAgentsSnapshot() : null;
      const cursor = enabled ? await portal.latestEventCursor() : 0;
      // Heartbeat timestamps change constantly; only rendered state and durable event cursors invalidate.
      const sessions = snapshot?.sessions.map((s) => ({
        id: s.id,
        host: s.host,
        cwd: s.cwd,
        engine: s.engine,
        presence: s.presence,
        ready: s.relay_ready,
        prompt: s.pending_prompt,
        attention: s.attention,
        close: s.close,
      }));
      const approvals = (await insecure.listPending()).map((r) => ({
        id: r.id,
        live: r.live,
        expires_at: r.expires_at,
        fqdn: r.fqdn,
        request_ip: r.request_ip,
      }));
      return { agents: JSON.stringify({ enabled, cursor, sessions }), approvals: JSON.stringify(approvals) };
    },
  });
  app.addHook('preClose', () => live.stop());

  app.get('/admin/companion/devices', { preHandler: app.requireAdmin }, async (req) => ({
    devices: await devices.list(req.admin!.user.id),
    push_configured: !!devices.firebase() && !!ctx.env.COMPANION_FIREBASE_CREDENTIAL_FILE,
  }));
  app.post('/admin/companion/pairings', { preHandler: app.requireAdmin }, async (req) =>
    devices.pair(req.admin!.user.id),
  );
  app.delete('/admin/companion/devices/:id', { preHandler: app.requireAdmin }, async (req) => {
    await devices.revoke(req.admin!.user.id, id(req));
    return { revoked: true };
  });

  await app.register(async (app) => {
    app.addHook('onRequest', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      // This is a native bearer surface, never a browser-cookie alternative.
      if (req.headers.origin || req.headers['sec-fetch-site'])
        throw new ForbiddenError('Native companion API only', 'native_only');
      await checkEnabled();
    });
    app.get(
      '/companion/v1/ws',
      {
        websocket: true,
        preHandler: async (req) => {
          await auth(req);
        },
      },
      (socket, req) => live.attach(socket, req.headers.authorization),
    );
    app.post('/companion/v1/pair', async (req) => {
      const body = z
        .object({ token: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().trim().min(1).max(100) })
        .parse(req.body);
      return devices.exchange(body.token, body.name);
    });
    app.get('/companion/v1/me', async (req) => {
      const { device, user } = await auth(req);
      return {
        device_id: device.id,
        name: user.name,
        capabilities: capabilitiesForRole(user.accessLevel),
        firebase: devices.firebase(),
        notifications: !!device.notifications,
        follows: (
          await ctx.db.select().from(companionFollows).where(eq(companionFollows.deviceId, device.id))
        ).map((f) => f.sessionId),
      };
    });
    app.patch('/companion/v1/device', async (req) => {
      const { device } = await auth(req);
      const body = z
        .object({
          fcm_token: z.string().min(1).max(4096).nullable().optional(),
          notifications: z.boolean().optional(),
          visible_session_id: z.string().uuid().nullable().optional(),
        })
        .parse(req.body);
      await ctx.db
        .update(companionDevices)
        .set({
          lastSeenAt: nowIso(),
          ...(body.fcm_token !== undefined
            ? { fcmTokenEnc: body.fcm_token ? encrypt(body.fcm_token, ctx.keyring) : null }
            : {}),
          ...(body.notifications !== undefined ? { notifications: body.notifications ? 1 : 0 } : {}),
          ...(body.visible_session_id !== undefined
            ? {
                visibleSessionId: body.visible_session_id,
                visibleUntil: body.visible_session_id ? isoOffsetSeconds(45) : null,
              }
            : {}),
        })
        .where(eq(companionDevices.id, device.id));
      if (body.notifications !== undefined) wsPublisher.publish('companion.devices.changed', {});
      return { updated: true };
    });
    app.delete('/companion/v1/device', async (req) => {
      const { user, device } = await auth(req);
      await devices.revoke(user.id, device.id);
      return { revoked: true };
    });
    app.get('/companion/v1/agents', async (req) => {
      const { user } = await auth(req, 'agent_portal.read');
      await requirePortal();
      const snapshot = await portal.listAgentsSnapshot();
      const reveal = capabilitiesForRole(user.accessLevel).includes('agent_portal.reveal_transcript');
      const sessions = (reveal ? await companionPreviews(ctx, snapshot.sessions) : snapshot.sessions).map(
        (session) =>
          reveal
            ? session
            : {
                ...session,
                preview: null,
                pending_prompt: null,
                attention: session.attention
                  ? { since: (session.attention as { since: string }).since }
                  : null,
              },
      );
      return { agents: sessions, generated_at: snapshot.generated_at, timings: portal.timings() };
    });
    app.get('/companion/v1/agents/:id/events', async (req) => {
      await auth(req, 'agent_portal.reveal_transcript');
      await requirePortal();
      const query = z
        .object({
          after: z.coerce.number().int().nonnegative().default(0),
          tail: z.enum(['1', '0']).default('0'),
        })
        .parse(req.query);
      return portal.listEvents(id(req), query.after, 250, query.tail === '1');
    });
    app.post('/companion/v1/agents/:id/messages', async (req, reply) => {
      const { device, user } = await auth(req, 'agent_portal.manage');
      const body = message.parse(req.body);
      const result = await portal.enqueueMessage(actor(user), {
        sessionId: id(req),
        clientMessageId: body.client_message_id,
        content: body.content,
      });
      await follow(device.id, id(req));
      wsPublisher.publish('companion.devices.changed', {});
      reply.code(202);
      return result;
    });
    app.post('/companion/v1/agents/:id/prompts/:promptId/answer', async (req, reply) => {
      const { device, user } = await auth(req, 'agent_portal.manage');
      const body = z
        .object({
          client_message_id: z.string().uuid(),
          answer: z.string().max(32768),
          version: z.number().int().positive().optional(),
        })
        .parse(req.body);
      const params = z.object({ id: z.string().uuid(), promptId: z.string().uuid() }).parse(req.params);
      const result = await portal.answerPrompt(actor(user), {
        sessionId: params.id,
        promptId: params.promptId,
        clientMessageId: body.client_message_id,
        answer: body.answer,
        version: body.version,
      });
      await follow(device.id, params.id);
      wsPublisher.publish('companion.devices.changed', {});
      reply.code(202);
      return result;
    });
    app.put('/companion/v1/agents/:id/follow', async (req) => {
      const { device } = await auth(req, 'agent_portal.reveal_transcript');
      await requirePortal();
      await portal.listEvents(id(req), 0, 1, true);
      const body = z.object({ followed: z.boolean() }).parse(req.body);
      if (body.followed) await follow(device.id, id(req));
      else
        await ctx.db
          .delete(companionFollows)
          .where(and(eq(companionFollows.deviceId, device.id), eq(companionFollows.sessionId, id(req))));
      wsPublisher.publish('companion.devices.changed', {});
      return { followed: body.followed };
    });
    app.get('/companion/v1/approvals', async (req) => {
      await auth(req, 'hosts.activate_insecure');
      return {
        requests: await insecure.listPending(),
        default_duration_minutes: 480,
        max_duration_minutes: 480,
      };
    });
    const decide = (decision: 'approve' | 'deny') => async (req: FastifyRequest) => {
      const { user, device } = await auth(req, 'hosts.activate_insecure');
      const requestId = z
        .object({ requestId: z.coerce.number().int().positive() })
        .parse(req.params).requestId;
      const body = z
        .object({ duration_minutes: z.number().int().min(0).max(480).optional() })
        .parse(req.body ?? {});
      const audit = { admin_user_id: user.id, device_id: device.id, decision };
      const result =
        decision === 'approve'
          ? await insecure.approve(requestId, body.duration_minutes ?? null, audit)
          : await insecure.deny(requestId, audit);
      return { request_id: result.requestId, decision };
    };
    app.post('/companion/v1/approvals/:requestId/approve', decide('approve'));
    app.post('/companion/v1/approvals/:requestId/deny', decide('deny'));
    app.get('/companion/v1/events', async (req, reply) => {
      await auth(req, 'agent_portal.reveal_transcript');
      await requirePortal();
      const query = z
        .object({
          after: z.coerce.number().int().nonnegative().optional(),
          session_id: z.string().uuid().optional(),
        })
        .parse(req.query);
      let cursor = query.after ?? (await portal.latestEventCursor());
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      const disconnected = new AbortController();
      const stop = trackStream(reply, () => disconnected.abort());
      reply.raw.flushHeaders();
      let heartbeat = Date.now();
      try {
        while (!disconnected.signal.aborted) {
          await auth(req, 'agent_portal.reveal_transcript');
          await requirePortal();
          const page = await portal.listEventsAfter(cursor, 250, query.session_id);
          for (const event of page.events) {
            cursor = Number(event.cursor);
            if (!reply.raw.write(`id: ${cursor}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`)) return;
          }
          if (Date.now() - heartbeat > 15_000) {
            if (!reply.raw.write(': heartbeat\n\n')) return;
            heartbeat = Date.now();
          }
          await delay(1000, undefined, { signal: disconnected.signal });
        }
      } catch {
        /* Reconnect rechecks credentials and resumes the cursor. */
      } finally {
        stop();
      }
    });
  });
  startCompanionPush(app, ctx);
}
