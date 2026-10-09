import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { ok } from '../../../http/reply.js';
import { ApiError, ValidationError, NotFoundError, ServiceUnavailableError } from '../../../http/errors.js';
import { SettingsService } from '../../../services/settings.js';
import { AdminEventsService } from '../../../services/admin-events.js';
import { ChattyCoordinator } from '../../../services/chatty/coordinator.js';
import { messageSchema, selectionSchema, settingsSchema } from '../../../services/chatty/contracts.js';

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ValidationError(result.error.issues[0]?.message ?? 'Invalid input', {
      param: result.error.issues[0]?.path.join('.'),
    });
  return result.data;
}
const actor = (req: FastifyRequest) => ({ userId: req.admin!.user.id, sessionId: req.admin!.session.id });
const runId = (req: FastifyRequest) => parse(z.object({ id: z.string().uuid() }), req.params).id;

export async function registerAdminChattyRoutes(app: FastifyInstance, ctx: RouteContext) {
  const chatty = new ChattyCoordinator(ctx);
  const streams = new Set<() => void>();
  let worker: ReturnType<typeof setInterval> | undefined;
  app.addHook('onReady', async () => {
    worker = setInterval(() => {
      void chatty.tick().catch(() => app.log.warn('Chatty scheduler failed'));
    }, 1000);
    worker.unref();
  });
  app.addHook('preClose', async () => {
    if (worker) clearInterval(worker);
    chatty.stop();
    for (const close of streams) close();
  });
  app.get('/admin/chatty/status', { preHandler: app.requireAdmin }, async (req) =>
    ok(await chatty.status(actor(req).userId)),
  );
  app.get('/admin/chatty/session', { preHandler: app.requireAdmin }, async (req) => {
    const { before } = parse(z.object({ before: z.coerce.number().int().positive().optional() }), req.query);
    return ok(await chatty.snapshot(actor(req).userId, before));
  });
  app.put('/admin/chatty/selection', { preHandler: app.requireAdmin }, async (req) => {
    await chatty.choose(actor(req).userId, parse(selectionSchema, req.body));
    return ok({ saved: true });
  });
  app.post('/admin/chatty/messages', { preHandler: app.requireAdmin, bodyLimit: 70000 }, async (req) => {
    const input = parse(messageSchema, req.body);
    if (
      !(await chatty.store.hasReceipt(actor(req).userId, input.client_message_id)) &&
      !(await chatty.status(actor(req).userId)).ready
    )
      throw new ServiceUnavailableError('No usable AI access', 'chatty_unavailable');
    return ok(await chatty.store.submit(actor(req), input));
  });
  app.post('/admin/chatty/runs/:id/answer', { preHandler: app.requireAdmin }, async (req) => {
    const input = parse(
      z.object({ generation: z.number().int().positive(), text: z.string().min(1).max(16000) }).strict(),
      req.body,
    );
    await chatty.store.answer(actor(req), runId(req), input.text, input.generation);
    return ok({ accepted: true });
  });
  app.post('/admin/chatty/runs/:id/cancel', { preHandler: app.requireAdmin }, async (req) => {
    await chatty.store.cancel(actor(req).userId, runId(req));
    chatty.stop(runId(req));
    return ok({ cancelled: true });
  });
  app.post('/admin/chatty/actions/:id/decision', { preHandler: app.requireAdmin }, async (req) => {
    const input = parse(
      z.object({ generation: z.number().int().positive(), approve: z.boolean() }).strict(),
      req.body,
    );
    await chatty.decide(actor(req), runId(req), input.approve, input.generation);
    return ok({ accepted: true });
  });
  app.delete('/admin/chatty/session', { preHandler: app.requireAdmin }, async (req) => {
    await chatty.store.session(actor(req).userId);
    const active = await chatty.store.active(actor(req).userId);
    const result = await chatty.store.clear(actor(req).userId);
    if (active) chatty.stop(active.id);
    return ok(result);
  });
  app.get('/admin/chatty/sources/:id', { preHandler: app.requireAdmin }, async (req) => {
    const { id } = parse(z.object({ id: z.string().max(100) }), req.params);
    const source = chatty.knowledge.sources.find((s) => s.id === id);
    if (!source) throw new NotFoundError('Documentation source not found');
    return ok({ ...source, version: chatty.knowledge.version });
  });
  app.get('/admin/chatty/settings', { preHandler: app.requireAdmin }, async () =>
    ok(await chatty.store.settings()),
  );
  app.put('/admin/chatty/settings', { preHandler: app.requireAdmin }, async (req) => {
    const settings = parse(settingsSchema, req.body);
    await new SettingsService(ctx.db).set('chatty_settings', JSON.stringify(settings));
    if (!settings.enabled) chatty.stop();
    await new AdminEventsService(ctx.db).record({
      type: 'chatty.settings',
      payload: { user_id: actor(req).userId, enabled: settings.enabled },
    });
    return ok(settings);
  });
  // Cookie-authenticated personal notifications. Chat content never enters admin WS.
  // Reconnect fetches the canonical snapshot, so missed notifications cannot lose content.
  const perUser = new Map<number, number>();
  app.get('/admin/chatty/events', { preHandler: app.requireAdmin }, async (req, reply) => {
    const owner = actor(req);
    if ((perUser.get(owner.userId) ?? 0) >= 6)
      throw new ApiError('Too many open Chatty tabs', { status: 429 });
    await chatty.store.session(owner.userId);
    perUser.set(owner.userId, (perUser.get(owner.userId) ?? 0) + 1);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 3000\n\n');
    let closed = false;
    let busy = false;
    let fingerprint = '';
    const timer = setInterval(() => {
      void poll();
    }, 1500);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      streams.delete(close);
      perUser.set(owner.userId, Math.max(0, (perUser.get(owner.userId) ?? 1) - 1));
      reply.raw.end();
    };
    streams.add(close);
    reply.raw.once('close', close);
    const poll = async () => {
      if (busy || closed) return;
      busy = true;
      try {
        await chatty.store.authorize(owner);
        const snapshot = await chatty.snapshot(owner.userId);
        const next = JSON.stringify([
          snapshot.generation,
          snapshot.events.at(-1)?.id,
          snapshot.active,
          snapshot.selection,
        ]);
        const chunk =
          next !== fingerprint
            ? `event: changed\ndata: ${JSON.stringify({ generation: snapshot.generation })}\n\n`
            : ': keepalive\n\n';
        fingerprint = next;
        if (!closed && !reply.raw.write(chunk)) close();
      } catch {
        close();
      } finally {
        busy = false;
      }
    };
    await poll();
  });
}
