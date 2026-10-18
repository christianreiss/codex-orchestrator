import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../index.js';
import type { Capability } from '../../security/capabilities.js';
import { CompanionDevices } from '../../services/companion/devices.js';
import { AgentRoomChat } from '../../services/agent-room-chat/index.js';
import { createAgentMessagingService } from '../../services/agent-messaging.js';
import { createAdminEventsService } from '../../services/admin-events.js';
import { roomListSchema } from '../../services/agent-room-chat/contracts.js';

/** Native device credentials retain the operator's existing room permissions. */
export function registerCompanionRooms(app: FastifyInstance, ctx: RouteContext) {
  const devices = new CompanionDevices(ctx);
  const bus = createAgentMessagingService(ctx.db, ctx.env, ctx.keyring);
  const rooms = new AgentRoomChat(ctx.db, ctx.env, ctx.keyring, bus);
  const audit = createAdminEventsService(ctx.db);
  const actor = async (req: FastifyRequest, capability: Capability) => {
    const { user } = await devices.authenticate(req.headers.authorization, capability);
    return { adminId: user.id, name: user.name };
  };
  app.get('/companion/v1/rooms', async (req) => {
    const author = await actor(req, 'agent_messaging.read');
    const { offset, view } = roomListSchema.parse(req.query);
    return rooms.list(author, offset, view);
  });
  app.get('/companion/v1/rooms/candidates', async (req) => {
    await actor(req, 'agent_messaging.manage');
    return bus.listAdminAddresses();
  });
  app.post('/companion/v1/rooms/read', async (req) => {
    const author = await actor(req, 'agent_messaging.reveal_content');
    const result = await rooms.read(author, req.body);
    await audit.record(
      {
        type: 'agent_room_chat.revealed',
        payload: { room_id: result.room.id, admin_user_id: author.adminId, surface: 'companion' },
      },
      { broadcast: false },
    );
    return result;
  });
  app.post('/companion/v1/rooms/seen', async (req) => {
    const author = await actor(req, 'agent_messaging.reveal_content');
    const body = z
      .object({ room_id: z.string().uuid(), through: z.string().datetime() })
      .strict()
      .parse(req.body);
    return rooms.markRead(author, body.room_id, body.through);
  });
  const mutate = (operation: 'send' | 'create' | 'manage') => async (req: FastifyRequest) => {
    const author = await actor(req, 'agent_messaging.manage');
    await actor(req, 'agent_messaging.reveal_content');
    const result = await rooms[operation](author, req.body);
    await audit.record(
      {
        type: `agent_room_chat.${operation}`,
        payload: {
          admin_user_id: author.adminId,
          surface: 'companion',
          room_id:
            (req.body as { room_id?: string }).room_id ?? ('room_id' in result ? result.room_id : null),
        },
      },
      { broadcast: false },
    );
    return result;
  };
  app.post('/companion/v1/rooms/send', mutate('send'));
  app.post('/companion/v1/rooms/create', mutate('create'));
  app.post('/companion/v1/rooms/manage', mutate('manage'));
}
