import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../index.js';
import type { Capability } from '../../security/capabilities.js';
import { CompanionDevices } from '../../services/companion/devices.js';
import { AgentRoomChat } from '../../services/agent-room-chat/index.js';
import { createAgentMessagingService } from '../../services/agent-messaging.js';
import { createAdminEventsService } from '../../services/admin-events.js';
import { roomListSchema } from '../../services/agent-room-chat/contracts.js';
import { ROOM_PUSH_MODES } from '../../services/companion/room-push.js';

const roomParams = z.object({ roomId: z.string().uuid() }).strict();
const cursor = z.union([
  z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^\d{1,16}$/u).transform(Number),
]);

/** Native device credentials retain the operator's existing room permissions. */
export function registerCompanionRooms(app: FastifyInstance, ctx: RouteContext) {
  const devices = new CompanionDevices(ctx);
  const bus = createAgentMessagingService(ctx.db, ctx.env, ctx.keyring);
  const rooms = new AgentRoomChat(ctx.db, ctx.env, ctx.keyring, bus);
  const audit = createAdminEventsService(ctx.db);
  const actor = async (req: FastifyRequest, capability: Capability) => {
    const { user, device } = await devices.authenticate(req.headers.authorization, capability);
    return { adminId: user.id, name: user.name, deviceId: device.id };
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
  /** Room ids changed after a change cursor, with each room's newest sequence. */
  app.get('/companion/v1/rooms/changes', async (req) => {
    const author = await actor(req, 'agent_messaging.read');
    const { after } = z.object({ after: cursor.default(0) }).strict().parse(req.query);
    return rooms.changes(author, after);
  });
  app.post('/companion/v1/rooms/read', async (req) => {
    const author = await actor(req, 'agent_messaging.reveal_content');
    const delta = !!req.body && typeof req.body === 'object' && 'after' in req.body;
    const result = delta ? await rooms.readDelta(author, req.body) : await rooms.read(author, req.body);
    await audit.record(
      {
        type: 'agent_room_chat.revealed',
        payload: {
          room_id: 'room_id' in result && result.room_id ? result.room_id : result.room!.id,
          admin_user_id: author.adminId,
          surface: 'companion',
          ...(delta ? { delta: true } : {}),
        },
      },
      { broadcast: false },
    );
    return result;
  });
  app.post('/companion/v1/rooms/seen', async (req) => {
    const author = await actor(req, 'agent_messaging.reveal_content');
    // `through` is the newest seen event's exact created_at (millisecond precision); the
    // stored position only moves forward and never past the server clock.
    const body = z
      .object({ room_id: z.string().uuid(), through: z.string().datetime() })
      .strict()
      .parse(req.body);
    return rooms.markRead(author, body.room_id, body.through);
  });
  app.get('/companion/v1/rooms/:roomId/notifications', async (req) => {
    const author = await actor(req, 'agent_messaging.read');
    const { roomId: id } = roomParams.parse(req.params);
    await rooms.access(author, id);
    return { room_id: id, mode: await devices.roomPreference(author.deviceId, id) };
  });
  app.put('/companion/v1/rooms/:roomId/notifications', async (req) => {
    const author = await actor(req, 'agent_messaging.read');
    const { roomId: id } = roomParams.parse(req.params);
    const { mode } = z.object({ mode: z.enum(ROOM_PUSH_MODES) }).strict().parse(req.body);
    await rooms.access(author, id);
    return { room_id: id, mode: await devices.setRoomPreference(author.deviceId, id, mode) };
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
