import { CompanionChanges } from '../../services/companion/changes.js';
import { subscribeActivityObservations } from '../../services/agent-activity.js';
import { ownerRuntimeFor } from '../../control-plane/state/runtime.js';
import { ownerPresence } from '../../control-plane/presence.js';
import { attachCompanion } from '../../services/companion/presence.js';
import { chatMetadataSchema } from '../../services/agent-chat/contracts.js';
import { registerCompanionRooms } from './rooms.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../index.js';
import {
  companionFollows,
  companionDaemonFollows,
  hostDaemonSessions,
} from '../../db/schema.js';
import { CompanionDevices } from '../../services/companion/devices.js';
import { startCompanionPush } from '../../services/companion/push.js';
import { companionPreviews } from '../../services/companion/summary.js';
import { CompanionRemote, companionStartSchema, contactPrompt } from '../../services/companion/remote.js';
import { CompanionLive } from '../../services/companion/live.js';
import { SettingsService } from '../../services/settings.js';
import { registerWebsocketTransport } from '../../ws/transport.js';
import { wsPublisher } from '../../ws/publisher.js';
import { capabilitiesForRole, type Capability } from '../../security/capabilities.js';
import { createAgentPortalService, type PortalActor } from '../../services/agent-portal.js';
import { InsecureWindowAdminService } from '../../services/insecure-window-admin.js';
import { makeAdminEventsWriter } from '../../services/admin-events-writer.js';
import { ApiError, ForbiddenError, ServiceUnavailableError } from '../../http/errors.js';
import { createSseLifecycle } from '../../http/sse-lifecycle.js';

const id = (req: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(req.params).id;
const message = z.object({ client_message_id: z.string().uuid(), metadata: chatMetadataSchema.optional(),
  content: z.string().max(32768) });
const safeReadCursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sessionUuid = z.string().uuid();
const readSnapshot = z
  .object({
    read_cursors: z
      .unknown()
      .refine((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const keys = Object.keys(value);
        return keys.length <= 500 && keys.every((key) => sessionUuid.safeParse(key).success);
      })
      .pipe(
        z.object({}).catchall(
          z.union([
            safeReadCursor,
            z
              .string()
              .regex(/^\d{1,16}$/u)
              .transform(Number)
              .pipe(safeReadCursor),
          ]),
        ),
      ),
  })
  .strict();

export async function registerCompanionRoutes(app: FastifyInstance, ctx: RouteContext) {
  await registerWebsocketTransport(app);
  const devices = new CompanionDevices(ctx);
  const settings = new SettingsService(ctx.db);
  const remote = new CompanionRemote(ctx);
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
  const authenticatedDevices = new WeakMap<object, string>();
  const auth = async (req: FastifyRequest, capability?: Capability) => {
    await checkEnabled();
    const result = await devices.authenticate(req.headers.authorization, capability); authenticatedDevices.set(req, result.device.id); return result;
  };
  const actor = (user: { id: number; name: string }): PortalActor => ({
    kind: 'admin',
    user: { id: user.id, displayName: user.name },
  });
  const follow = (deviceId: string, sessionId: string) => devices.follow(deviceId, sessionId);
  const requirePortal = async () => {
    if (!(await portal.isEnabled()))
      throw new ServiceUnavailableError('Agent portal is disabled', 'agent_portal_disabled');
  };
  const live = new CompanionLive({
    authorize: async (token) => {
      await checkEnabled();
      const { user, device } = await devices.authenticate(token);
      return { capabilities: capabilitiesForRole(user.accessLevel), expiresAt: device.expiresAt };
    },
    subscribe: listener => {
      const owner = ownerRuntimeFor(ctx.db); if (!owner) return subscribeActivityObservations(ctx.db, listener);
      const tables = ['adminUsers','companionDevices','versions','hosts','agentSessions','agentPrompts','insecureAuthRequests','hostDaemons','hostDaemonSessions','agentBusConferences','agentRoomEvents'] as const;
      let previous = owner.state.snapshot();
      const state = owner.state.subscribe(next => { const changed = tables.some(table => next.table(table) !== previous.table(table)); previous = next; if (changed) listener(); });
      const presence = ownerPresence(owner).subscribe(listener); return () => { state(); presence(); };
    },
    revisions: async () => {
      const owner = ownerRuntimeFor(ctx.db);
      if (owner) { const revision = owner.state.revision(); const value = `${revision.epoch}:${revision.sequence}`; return { agents: value, approvals: value, hosts: value }; }
      const enabled = await portal.isEnabled();
      const snapshot = enabled ? await portal.listAgentsSnapshot() : null;
      const cursor = enabled ? await portal.latestEventCursor() : 0;
      // Native observation deadlines must reach phones even while the state
      // stays Working/Idle; ordinary transport heartbeats remain excluded.
      const sessions = snapshot?.sessions.map((s) => ({
        id: s.id,
        host: s.host,
        cwd: s.cwd,
        engine: s.engine,
        presence: s.presence,
        ready: s.relay_ready,
        activity: s.activity,
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
      const remoteSessions = (await ctx.db.select().from(hostDaemonSessions)).map((s) => ({
        id: s.id,
        status: s.status,
        sessionId: s.sessionId,
      }));
      const hostCards = (await remote.hosts()).map(
        ({ health: { heartbeat_at: _beat, evaluated_at: _at, ...health }, ...card }) => ({ ...card, health }),
      );
      return {
        agents: JSON.stringify({ enabled, cursor, sessions, remoteSessions }),
        approvals: JSON.stringify({ requests: approvals, ...await insecure.accessWindows() }),
        hosts: JSON.stringify(hostCards),
      };
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
    registerCompanionRooms(app, ctx);
    app.get(
      '/companion/v1/ws',
      {
        websocket: true,
        preHandler: async (req) => {
          await auth(req);
        },
      },
      (socket, req) => {
        const owner = ownerRuntimeFor(ctx.db), deviceId = authenticatedDevices.get(req);
        if (owner && deviceId) { const detach = attachCompanion(owner, deviceId); socket.on('close', detach); socket.on('error', detach); }
        live.attach(socket, req.headers.authorization);
      },
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
        follows: [
          ...(
            ownerRuntimeFor(ctx.db) ? ownerRuntimeFor(ctx.db)!.state.snapshot().table('companionFollows').by('deviceId', device.id) : await ctx.db.select().from(companionFollows).where(eq(companionFollows.deviceId, device.id))
          ).map((f) => f.sessionId),
          ...(
            ownerRuntimeFor(ctx.db) ? ownerRuntimeFor(ctx.db)!.state.snapshot().table('companionDaemonFollows').by('deviceId', device.id) : await ctx.db
              .select()
              .from(companionDaemonFollows)
              .where(eq(companionDaemonFollows.deviceId, device.id))
          ).map((f) => f.daemonSessionId),
        ],
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
      await devices.patch(device.id, body);
      return { updated: true };
    });
    app.delete('/companion/v1/device', {config:{ownerResponse:'committed-action'}}, async (req) => {
      const { user, device } = await auth(req);
      await devices.revoke(user.id, device.id);
      return { revoked: true };
    });
    const agentsSnapshot = async (
      user: { id: number; accessLevel: string },
      readCursors?: Record<string, number>,
    ) => {
      const snapshot = await portal.listAgentsSnapshot();
      const reveal = capabilitiesForRole(user.accessLevel).includes('agent_portal.reveal_transcript');
      const projection = await remote.project(user.id, snapshot.sessions);
      const sessions = (
        reveal
          ? await companionPreviews(ctx, projection.sessions, readCursors, projection.aliases)
          : projection.sessions
      ).map((session) =>
        reveal
          ? session
          : {
              ...session,
              session_name: null,
              task_title: null,
              preview: null,
              reply_cursor: null,
              unread_reply_count: null,
              pending_prompt: null,
              notices: [],
              attention: session.attention ? { since: (session.attention as { since: string }).since } : null,
            },
      );
      return { agents: sessions, generated_at: snapshot.generated_at, timings: portal.timings() };
    };
    app.get('/companion/v1/agents', async (req) => {
      const { user } = await auth(req, 'agent_portal.read');
      await requirePortal();
      return agentsSnapshot(user);
    });
    app.post('/companion/v1/agents', async (req) => {
      const { user } = await auth(req, 'agent_portal.read');
      await requirePortal();
      const parsed = readSnapshot.safeParse(req.body);
      if (!parsed.success)
        throw new ApiError(
          'read_cursors must map at most 500 session UUIDs to safe nonnegative integer cursors',
          {
            status: 400,
            code: 'bad_request',
            type: 'invalid_request_error',
            param: 'read_cursors',
          },
        );
      return agentsSnapshot(user, parsed.data.read_cursors);
    });
    app.get('/companion/v1/agents/:id/events', async (req) => {
      const { user } = await auth(req, 'agent_portal.reveal_transcript');
      await requirePortal();
      const query = z
        .object({
          after: z.coerce.number().int().nonnegative().default(0),
          tail: z.enum(['1', '0']).default('0'),
        })
        .parse(req.query);
      return (
        (await remote.events(id(req), user.id, query.after, query.tail === '1')) ??
        portal.listEvents(id(req), query.after, 250, query.tail === '1')
      );
    });
    app.post('/companion/v1/agents/:id/messages', async (req, reply) => {
      const { device, user } = await auth(req, 'agent_portal.manage');
      const body = message.parse(req.body);
      await requirePortal();
      const linked = await remote.find(id(req), user.id);
      let result;
      if (
        linked &&
        (linked.status !== 'running' || (await remote.hasOperation(body.client_message_id, user.id)))
      ) {
        await auth(req, 'agent_messaging.manage');
        await auth(req, 'agent_portal.reveal_transcript');
        result = await remote.daemon.turn(
          linked.id,
          body.content + (body.metadata ? '\n\nChat metadata: ' + JSON.stringify(body.metadata) + '. Fetch attached files with agent_attachment_get; reply_to identifies the referenced conversation event.' : '') + '\n\nReply to the operator through cxx portal say or cxx portal ask with --summary.',
          body.client_message_id,
          `admin:${user.id}`,
          { deviceId: device.id, content: body.content, metadata: body.metadata, author: user.name },
        );
      } else {
        result = await portal.enqueueMessage(actor(user), {
          sessionId: linked?.sessionId ?? id(req),
          clientMessageId: body.client_message_id,
          content: body.content,
          metadata: body.metadata,
        });
        if (linked) await remote.follow(device.id, linked.id, true);
        else await follow(device.id, id(req));
      }
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
          metadata: chatMetadataSchema.optional(),
          version: z.number().int().positive().optional(),
        })
        .parse(req.body);
      const params = z.object({ id: z.string().uuid(), promptId: z.string().uuid() }).parse(req.params);
      await requirePortal();
      const linked = await remote.find(params.id, user.id);
      let result;
      if (
        linked &&
        (linked.status !== 'running' || (await remote.hasOperation(body.client_message_id, user.id)))
      ) {
        await auth(req, 'agent_messaging.manage');
        await auth(req, 'agent_portal.reveal_transcript');
        result = await remote.daemon.turn(
          linked.id,
          body.answer + (body.metadata ? '\n\nChat metadata: ' + JSON.stringify(body.metadata) + '. Fetch attached files with agent_attachment_get; reply_to identifies the referenced conversation event.' : '') +
            '\n\nThis answers your open Portal question. Continue the same task and report through cxx portal say or cxx portal ask with --summary.',
          body.client_message_id,
          `admin:${user.id}`,
          {
            deviceId: device.id,
            content: body.answer,
            metadata: body.metadata,
            author: user.name,
            promptId: params.promptId,
            version: body.version,
          },
        );
      } else {
        result = await portal.answerPrompt(actor(user), {
          sessionId: linked?.sessionId ?? params.id,
          promptId: params.promptId,
          clientMessageId: body.client_message_id,
          answer: body.answer,
          metadata: body.metadata,
          version: body.version,
        });
        if (linked) await remote.follow(device.id, linked.id, true);
        else await follow(device.id, params.id);
      }
      wsPublisher.publish('companion.devices.changed', {});
      reply.code(202);
      return result;
    });
    app.put('/companion/v1/agents/:id/follow', async (req) => {
      const { device, user } = await auth(req, 'agent_portal.reveal_transcript');
      await requirePortal();
      const linked = await remote.find(id(req), user.id);
      if (linked) {
        const body = z.object({ followed: z.boolean() }).parse(req.body);
        await remote.follow(device.id, linked.id, body.followed);
        wsPublisher.publish('companion.devices.changed', {});
        return { followed: body.followed };
      }
      await portal.listEvents(id(req), 0, 1, true);
      const body = z.object({ followed: z.boolean() }).parse(req.body);
      await devices.follow(device.id, id(req), body.followed);
      wsPublisher.publish('companion.devices.changed', {});
      return { followed: body.followed };
    });
    app.get('/companion/v1/hosts', async (req) => {
      await auth(req, 'admin.read');
      return { hosts: await remote.hosts() };
    });
    app.post('/companion/v1/daemon-sessions', async (req, reply) => {
      const { device, user } = await auth(req, 'agent_messaging.manage');
      await auth(req, 'agent_portal.manage');
      await auth(req, 'agent_portal.read');
      await auth(req, 'agent_portal.reveal_transcript');
      await requirePortal();
      const body = companionStartSchema.parse(req.body);
      const result = await remote.daemon.start(
        {
          host_id: body.host_id,
          engine: body.engine,
          ...(body.cwd ? { cwd: body.cwd } : {}),
          title: body.title || (body.task ? body.task.slice(0, 160) : 'Kontakt herstellen'),
          prompt: contactPrompt(body.task),
          client_message_id: body.client_message_id,
        },
        `admin:${user.id}`,
        { deviceId: device.id, content: body.task || 'Kontakt herstellen', author: user.name },
      );
      wsPublisher.publish('companion.devices.changed', {});
      reply.code(202);
      return result;
    });
    app.get('/companion/v1/approvals', async (req) => {
      await auth(req, 'hosts.activate_insecure');
      return {
        requests: await insecure.listPending(),
        ...await insecure.accessWindows(),
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
    app.post('/companion/v1/hosts/:hostId/insecure/disable', async (req) => {
      const { user, device } = await auth(req, 'hosts.activate_insecure');
      const hostId = z.object({ hostId: z.coerce.number().int().positive() }).parse(req.params).hostId;
      const host = await insecure.disable(hostId, { admin_user_id: user.id, device_id: device.id });
      return { host_id: host.id, enabled_until: null };
    });
    app.post('/companion/v1/insecure/window/close', async (req) => {
      const { user, device } = await auth(req, 'hosts.activate_insecure');
      return insecure.closeFleetWindow('manual', { admin_user_id: user.id, device_id: device.id });
    });
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
      const changes = new CompanionChanges(ownerRuntimeFor(ctx.db));
      let source = -1;
      try {
        while (!disconnected.signal.aborted) {
          await auth(req, 'agent_portal.reveal_transcript');
          await requirePortal();
          const observed = changes.revision;
          if (source !== changes.source) {
          const requestedSource = changes.source;
          const page = await portal.listEventsAfter(cursor, 250, query.session_id);
          await auth(req, 'agent_portal.reveal_transcript');
          await requirePortal();
          for (const event of page.events) {
            cursor = Number(event.cursor);
            if (!reply.raw.write(`id: ${cursor}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`)) return;
          }
          if (page.events.length >= 250) continue;
          source = requestedSource;
          }
          if (Date.now() - heartbeat >= 15_000) {
            if (!reply.raw.write(': heartbeat\n\n')) return;
            heartbeat = Date.now();
          }
          await changes.wait(observed, Math.max(1, 15_000 - (Date.now() - heartbeat)), disconnected.signal);
        }
      } catch {
        /* Reconnect rechecks credentials and resumes the cursor. */
      } finally {
        changes.close(); stop();
      }
    });
  });
  startCompanionPush(app, ctx);
}
