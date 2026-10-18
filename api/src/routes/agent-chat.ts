import { AgentRoomChat } from '../services/agent-room-chat/index.js';
import { createAgentMessagingService } from '../services/agent-messaging.js';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from './index.js';
import { ChatAttachments } from '../services/agent-chat/attachments.js';
import { chunkSchema } from '../services/agent-chat/contracts.js';
import { createAgentPortalService, type PortalActor } from '../services/agent-portal.js';
import { CompanionDevices } from '../services/companion/devices.js';
import { CompanionRemote } from '../services/companion/remote.js';
import { ForbiddenError, ServiceUnavailableError } from '../http/errors.js';

export async function registerAgentChatRoutes(app: FastifyInstance, ctx: RouteContext) {
  const attachments = new ChatAttachments(ctx.db, ctx.keyring, ctx.env.DATA_ROOT ?? 'storage');
  const portal = createAgentPortalService(ctx.db, ctx.env, ctx.keyring);
  const devices = new CompanionDevices(ctx);
  const remote = new CompanionRemote(ctx);
  const rooms = new AgentRoomChat(ctx.db, ctx.env, ctx.keyring, createAgentMessagingService(ctx.db, ctx.env, ctx.keyring));
  const params = z.object({ id: z.string().uuid().optional(), roomId: z.string().uuid().optional(), attachmentId: z.string().uuid().optional() });
  async function identity(req: FastifyRequest, write: boolean) {
    const roomId = params.parse(req.params).roomId;
    if (roomId) {
      if (req.url.startsWith('/companion/')) {
        if (req.headers.origin || req.headers['sec-fetch-site']) throw new ForbiddenError('Native companion API only', 'native_only');
        const { user } = await devices.authenticate(req.headers.authorization, 'agent_messaging.reveal_content');
        if (write) await devices.authenticate(req.headers.authorization, 'agent_messaging.manage');
        const access = await rooms.access({ adminId: user.id, name: user.name }, roomId, write);
        return { sessionId: roomId, owner: access.owner };
      }
      const host = req.url.startsWith('/host/');
      const token = req.headers['x-agent-bridge-token'];
      if (host && typeof token !== 'string') throw new ForbiddenError('Bridge token required');
      if (!host && write) await app.assertCapability(req, 'agent_messaging.manage');
      const access = await rooms.access(host ? { sessionId: params.parse(req.params).id, token: token as string } : { adminId: req.admin!.user.id, name: req.admin!.user.name }, roomId, write);
      return { sessionId: roomId, owner: access.owner };
    }
    if (!(await portal.isEnabled()))
      throw new ServiceUnavailableError('Agent chat is disabled', 'agent_portal_disabled');
    const id = z.string().uuid().parse(params.parse(req.params).id);
    if (req.url.startsWith('/host/')) {
      const token = req.headers['x-agent-bridge-token'];
      if (typeof token !== 'string') throw new ForbiddenError('Bridge token required');
      await portal.authenticateBridge(id, token);
      return { sessionId: id, owner: `agent:${id}` };
    }
    const user = req.url.startsWith('/companion/')
      ? (
          await devices.authenticate(
            req.headers.authorization,
            write ? 'agent_portal.manage' : 'agent_portal.reveal_transcript',
          )
        ).user
      : req.admin!.user;
    if (!req.url.startsWith('/companion/'))
      await app.assertCapability(req, write ? 'agent_portal.manage' : 'agent_portal.reveal_transcript');
    const linked = await remote.find(id, user.id);
    const sessionId = linked?.sessionId ?? id;
    await portal.listEvents(sessionId, 0, 1, true);
    return {
      sessionId,
      owner: `admin:${user.id}`,
      actor: { kind: 'admin', user: { id: user.id, displayName: user.name } } as PortalActor,
    };
  }
  type Op = 'create' | 'put' | 'seal' | 'info' | 'download' | 'delete' | 'resolve' | 'get';
  const handler = (op: Op) => async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const auth = await identity(req, !['info', 'download', 'get'].includes(op));
    const p = params.parse(req.params);
    const attachmentId = p.attachmentId;
    if (op === 'resolve') {
      const body = z
        .object({ notice_id: z.string().uuid(), client_event_id: z.string().uuid() })
        .strict()
        .parse(req.body);
      return portal.resolveNotice(auth.actor!, auth.sessionId, body.notice_id, body.client_event_id);
    }
    if (op === 'create') return attachments.create(auth.sessionId, auth.owner, req.body);
    if (op === 'get') {
      const body = z
        .object({
          attachment_id: z.string().uuid(),
          variant: z.string().optional(),
          offset: z.number().int().nonnegative().default(0),
        })
        .parse(req.body);
      if (p.roomId) await attachments.assertReadableDraft(auth.sessionId,body.attachment_id,auth.owner);
      const item = await attachments.download(auth.sessionId, body.attachment_id, body.variant);
      const size = (await stat(item.path)).size;
      if (body.offset > size) throw new ForbiddenError('Invalid download offset');
      const file = await open(item.path, 'r');
      try {
        const bytes = Buffer.alloc(Math.min(4 * 1024 * 1024, size - body.offset));
        await file.read(bytes, 0, bytes.length, body.offset);
        const { path: _, ...info } = item;
        return {
          ...info,
          size_bytes: size,
          offset: body.offset,
          content_b64: bytes.toString('base64'),
          next_offset: body.offset + bytes.length,
          done: body.offset + bytes.length === size,
        };
      } finally {
        await file.close();
      }
    }
    if (!attachmentId) throw new ForbiddenError('Attachment ID required');
    if (op === 'put') {
      const b = chunkSchema.parse(req.body);
      return attachments.put(auth.sessionId, auth.owner, attachmentId, b.offset, b.content_b64);
    }
    if (op === 'seal') return attachments.seal(auth.sessionId, auth.owner, attachmentId);
    if (op === 'delete') return attachments.discard(auth.sessionId, auth.owner, attachmentId);
    if (p.roomId) await attachments.assertReadableDraft(auth.sessionId, attachmentId, auth.owner);
    if (op === 'info') return attachments.info(auth.sessionId, attachmentId);
    const query = z
      .object({ variant: z.string().optional(), inline: z.enum(['1', '0']).optional() })
      .parse(req.query);
    const item = await attachments.download(auth.sessionId, attachmentId, query.variant);
    const safeInline = /^(image\/(png|jpeg|gif|webp)|audio\/(mpeg|wav|ogg|mp4|webm)|video\/(mp4|webm))$/.test(
      item.mime_type,
    );
    reply
      .header('Content-Type', item.mime_type)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header(
        'Content-Disposition',
        `${query.inline === '1' && safeInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(String(item.name))}`,
      );
    const size = (await stat(item.path)).size;
    reply.header('Accept-Ranges', 'bytes');
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      const start = range?.[1] ? Number(range[1]) : Math.max(0, size - Number(range?.[2]));
      const end = range?.[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
      if (
        !range ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= size
      ) {
        return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      }
      reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${size}`)
        .header('Content-Length', end - start + 1);
      return reply.send(createReadStream(item.path, { start, end }));
    }
    reply.header('Content-Length', size);
    return reply.send(createReadStream(item.path));
  };
  app.post('/admin/agent-messaging/chats/:roomId/attachments', { preHandler: app.requireAdmin }, handler('create'));
  app.post('/admin/agent-messaging/chats/:roomId/attachments/:attachmentId/chunks', { preHandler: app.requireAdmin }, handler('put'));
  app.post('/admin/agent-messaging/chats/:roomId/attachments/:attachmentId/seal', { preHandler: app.requireAdmin }, handler('seal'));
  app.get('/admin/agent-messaging/chats/:roomId/attachments/:attachmentId', { preHandler: [app.requireAdmin, app.requireCapability('agent_messaging.reveal_content')] }, handler('info'));
  app.get('/admin/agent-messaging/chats/:roomId/attachments/:attachmentId/content', { preHandler: [app.requireAdmin, app.requireCapability('agent_messaging.reveal_content')] }, handler('download'));
  app.delete('/admin/agent-messaging/chats/:roomId/attachments/:attachmentId', { preHandler: app.requireAdmin }, handler('delete'));
  app.post('/host/agent-sessions/:id/agent-messaging/chats/:roomId/attachments', handler('create'));
  app.post('/host/agent-sessions/:id/agent-messaging/chats/:roomId/attachments/:attachmentId/chunks', handler('put'));
  app.post('/host/agent-sessions/:id/agent-messaging/chats/:roomId/attachments/:attachmentId/seal', handler('seal'));
  app.post('/host/agent-sessions/:id/agent-messaging/chats/:roomId/attachments/get', handler('get'));
  app.get('/admin/agent-chat/limits', { preHandler: app.requireAdmin }, async () => attachments.limits());
  app.get('/companion/v1/agent-chat/limits', async (req) => {
    await devices.authenticate(req.headers.authorization, 'agent_portal.read');
    return attachments.limits();
  });
  app.post('/admin/agent-sessions/:id/attachments', { preHandler: app.requireAdmin }, handler('create'));
  app.post(
    '/admin/agent-sessions/:id/attachments/:attachmentId/chunks',
    { preHandler: app.requireAdmin },
    handler('put'),
  );
  app.post(
    '/admin/agent-sessions/:id/attachments/:attachmentId/seal',
    { preHandler: app.requireAdmin },
    handler('seal'),
  );
  app.get(
    '/admin/agent-sessions/:id/attachments/:attachmentId',
    { preHandler: app.requireAdmin },
    handler('info'),
  );
  app.get(
    '/admin/agent-sessions/:id/attachments/:attachmentId/content',
    { preHandler: app.requireAdmin },
    handler('download'),
  );
  app.delete(
    '/admin/agent-sessions/:id/attachments/:attachmentId',
    { preHandler: app.requireAdmin },
    handler('delete'),
  );
  app.post('/admin/agent-sessions/:id/notices/resolve', { preHandler: app.requireAdmin }, handler('resolve'));
  app.post('/companion/v1/agents/:id/attachments', handler('create'));
  app.post('/companion/v1/rooms/:roomId/attachments', handler('create'));
  app.post('/companion/v1/rooms/:roomId/attachments/:attachmentId/chunks', handler('put'));
  app.post('/companion/v1/rooms/:roomId/attachments/:attachmentId/seal', handler('seal'));
  app.get('/companion/v1/rooms/:roomId/attachments/:attachmentId', handler('info'));
  app.get('/companion/v1/rooms/:roomId/attachments/:attachmentId/content', handler('download'));
  app.delete('/companion/v1/rooms/:roomId/attachments/:attachmentId', handler('delete'));
  app.post('/companion/v1/agents/:id/attachments/:attachmentId/chunks', handler('put'));
  app.post('/companion/v1/agents/:id/attachments/:attachmentId/seal', handler('seal'));
  app.get('/companion/v1/agents/:id/attachments/:attachmentId', handler('info'));
  app.get('/companion/v1/agents/:id/attachments/:attachmentId/content', handler('download'));
  app.delete('/companion/v1/agents/:id/attachments/:attachmentId', handler('delete'));
  app.post('/companion/v1/agents/:id/notices/resolve', handler('resolve'));
  app.post('/host/agent-sessions/:id/attachments', handler('create'));
  app.post('/host/agent-sessions/:id/attachments/:attachmentId/chunks', handler('put'));
  app.post('/host/agent-sessions/:id/attachments/:attachmentId/seal', handler('seal'));
  app.post('/host/agent-sessions/:id/attachments/get', handler('get'));
}
