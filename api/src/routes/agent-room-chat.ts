import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from './index.js';
import { UnauthorizedError } from '../http/errors.js';
import { createAgentMessagingService } from '../services/agent-messaging.js';
import { AgentRoomChat, type RoomActor } from '../services/agent-room-chat/index.js';
import { createAdminEventsService } from '../services/admin-events.js';
import { roomListSchema } from '../services/agent-room-chat/contracts.js';
import { roomPinSchema, roomReactionSchema, SlidingWindowLimiter } from '../services/agent-room-chat/annotations.js';
import { ConversationSearch, searchConversations, searchQuerySchema } from '../services/conversation-search.js';
import { createAgentPortalService } from '../services/agent-portal.js';
import { capabilitiesForRole } from '../security/capabilities.js';

const reactionBody = roomReactionSchema.omit({ room_id: true, event_id: true });
const pinBody = roomPinSchema.omit({ room_id: true, event_id: true });

export function registerAgentRoomChatRoutes(app: FastifyInstance, ctx: RouteContext) {
  const service = new AgentRoomChat(
    ctx.db,
    ctx.env,
    ctx.keyring,
    createAgentMessagingService(ctx.db, ctx.env, ctx.keyring),
  );
  const audit = createAdminEventsService(ctx.db);
  const actor = (req: FastifyRequest): RoomActor => ({
    adminId: req.admin!.user.id,
    name: req.admin!.user.name,
  });
  app.get('/admin/agent-messaging/chats', { preHandler: app.requireAdmin }, (req) => {
    const { offset, view } = roomListSchema.parse(req.query);
    return service.list(actor(req), offset, view);
  });
  app.post(
    '/admin/agent-messaging/chats/read',
    { preHandler: [app.requireAdmin, app.requireCapability('agent_messaging.reveal_content')] },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const result = await service.read(actor(req), req.body);
      await audit.record(
        {
          type: 'agent_room_chat.revealed',
          payload: { room_id: result.room.id, admin_user_id: req.admin!.user.id },
        },
        { broadcast: false },
      );
      return result;
    },
  );
  app.post(
    '/admin/agent-messaging/chats/seen',
    { preHandler: [app.requireAdmin, app.requireCapability('agent_messaging.reveal_content')] },
    async (req) => {
      const b = z
        .object({ room_id: z.string().uuid(), through: z.string().datetime() })
        .strict()
        .parse(req.body);
      return service.markRead(actor(req), b.room_id, b.through);
    },
  );
  const operation = (name: 'send' | 'create' | 'manage') => async (req: FastifyRequest) => {
    const result = await service[name](actor(req), req.body);
    await audit.record(
      {
        type: `agent_room_chat.${name}`,
        payload: {
          room_id:
            (req.body as { room_id?: string }).room_id ?? ('room_id' in result ? result.room_id : null),
          admin_user_id: req.admin!.user.id,
        },
      },
      { broadcast: false },
    );
    return result;
  };
  // Reactions and pins (0119): operators only, open rooms, canonical room events.
  const eventParams = z.object({ roomId: z.string().uuid(), eventId: z.string().uuid() }).strict();
  const annotationLimit = new SlidingWindowLimiter(60, 60_000, 'Too many reactions or pins. Try again in a minute.');
  const annotate = (kind: 'reaction' | 'pin') => async (req: FastifyRequest) => {
    const { roomId, eventId } = eventParams.parse(req.params);
    const body = (kind === 'reaction' ? reactionBody : pinBody).parse(req.body);
    annotationLimit.take(`admin:${req.admin!.user.id}`);
    const input = { ...body, room_id: roomId, event_id: eventId };
    const result = kind === 'reaction' ? await service.react(actor(req), input) : await service.pin(actor(req), input);
    if (result.changed)
      await audit.record(
        {
          type: `agent_room_chat.${kind}`,
          payload: { room_id: roomId, event_id: eventId, on: body.on, admin_user_id: req.admin!.user.id },
        },
        { broadcast: false },
      );
    return result;
  };
  app.post('/admin/agent-messaging/chats/:roomId/events/:eventId/reactions', { preHandler: [app.requireAdmin, app.requireCapability('agent_messaging.reveal_content')] }, annotate('reaction'));
  app.post('/admin/agent-messaging/chats/:roomId/events/:eventId/pin', { preHandler: [app.requireAdmin, app.requireCapability('agent_messaging.reveal_content')] }, annotate('pin'));
  app.get('/admin/agent-messaging/chats/:roomId/pins', { preHandler: [app.requireAdmin, app.requireCapability('agent_messaging.reveal_content')] }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const { roomId } = z.object({ roomId: z.string().uuid() }).strict().parse(req.params);
    return service.pins(actor(req), roomId);
  });
  const search = new ConversationSearch(ctx.db, ctx.keyring);
  const portal = createAgentPortalService(ctx.db, ctx.env, ctx.keyring);
  const searchLimit = new SlidingWindowLimiter(20, 60_000, 'Too many searches. Try again in a minute.');
  app.get('/admin/agent-messaging/search', { preHandler: [app.requireAdmin, app.requireCapability('agent_messaging.reveal_content')] }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const query = searchQuerySchema.parse(req.query);
    searchLimit.take(`admin:${req.admin!.user.id}`);
    const capabilities = capabilitiesForRole(req.admin!.user.accessLevel);
    const result = await searchConversations(
      { search, rooms: service, portal },
      { adminId: req.admin!.user.id, name: req.admin!.user.name },
      query,
      { rooms: true, direct: capabilities.includes('agent_portal.reveal_transcript') },
    );
    await audit.record(
      {
        type: 'conversation_search.performed',
        payload: {
          admin_user_id: req.admin!.user.id,
          scope: query.scope,
          scopes: result.scopes,
          results: result.results.length,
          truncated: result.truncated,
        },
      },
      { broadcast: false },
    );
    return result;
  });
  app.post('/admin/agent-messaging/chats/send', { preHandler: app.requireAdmin }, operation('send'));
  app.post('/admin/agent-messaging/chats/create', { preHandler: app.requireAdmin }, operation('create'));
  app.post('/admin/agent-messaging/chats/manage', { preHandler: app.requireAdmin }, operation('manage'));
  const bridge = (operation: 'list' | 'read' | 'send') => (req: FastifyRequest) => {
    const token = req.headers['x-agent-bridge-token'];
    if (typeof token !== 'string' || !token) throw new UnauthorizedError('Bridge credential required');
    const a = {
      sessionId: z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id),
      token,
    };
    if (operation === 'list') {
      const { offset, view } = roomListSchema.parse(req.body ?? {});
      return service.list(a, offset, view);
    }
    return service[operation](a, req.body);
  };
  app.post('/host/agent-sessions/:id/agent-messaging/chats/list', bridge('list'));
  app.post('/host/agent-sessions/:id/agent-messaging/chats/read', bridge('read'));
  app.post('/host/agent-sessions/:id/agent-messaging/chats/send', bridge('send'));
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pending) return;
    pending = service
      .tick()
      .catch((err) => app.log.error({ err }, 'Room chat maintenance failed'))
      .finally(() => {
        pending = undefined;
      });
  }, 15000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await pending;
  });
}
