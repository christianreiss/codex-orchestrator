import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from './index.js';
import { UnauthorizedError } from '../http/errors.js';
import { createAgentMessagingService } from '../services/agent-messaging.js';
import { AgentRoomChat, type RoomActor } from '../services/agent-room-chat/index.js';
import { createAdminEventsService } from '../services/admin-events.js';
import { roomListSchema } from '../services/agent-room-chat/contracts.js';

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
