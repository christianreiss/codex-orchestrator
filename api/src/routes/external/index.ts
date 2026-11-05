/**
 * External client routes (docs/external-clients.md).
 *
 *   /external/v1/*            the REST Communication Interface, bearer-key auth,
 *                             its own `{ error: { code, message } }` body
 *   /admin/external-clients*  admin lifecycle (session + capability gated)
 *
 * Both halves share one `ExternalClientsService`: an admin disabling or rotating
 * a client must end that client's in-memory presence at once.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../index.js';
import { ApiError } from '../../http/errors.js';
import { raw } from '../../http/reply.js';
import { parseBearer } from '../../util/api-key-helpers.js';
import { AdminEventsService } from '../../services/admin-events.js';
import { ExternalCallError, ExternalClientsService } from '../../services/external-clients/index.js';
import type { ExternalClient } from '../../db/schema.js';

/** Service error codes → the codes of the external contract. */
const CODE_MAP: Record<string, string> = {
  agent_messaging_address_not_found: 'recipient_not_found',
  agent_messaging_message_not_found: 'message_not_found',
  agent_messaging_idempotency_conflict: 'idempotency_conflict',
  validation_failed: 'validation_failed',
};

const uuid = z.string().uuid();
const sendSchema = z.object({
  client_message_id: uuid,
  to: z.string().min(1).max(200),
  content: z.string(),
  delivery_class: z.enum(['information', 'progress', 'notice', 'coordination']).optional(),
  // Accepted and reserved: whether a reply is expected is derived from
  // delivery_class and message kind in v1.
  expects_reply: z.boolean().optional(),
  conversation_id: uuid.optional(),
  related_work_id: uuid.optional(),
  ttl_seconds: z.number().int().min(60).max(604800).optional(),
});
const replySchema = z.object({
  client_message_id: uuid,
  reply_to: uuid,
  content: z.string(),
  ttl_seconds: z.number().int().min(60).max(604800).optional(),
});
const resultSchema = z.object({
  client_message_id: uuid.optional(),
  work_id: uuid,
  status: z.enum(['succeeded', 'failed', 'blocked', 'unknown']),
  content: z.string().max(4096).optional(),
});
const ackSchema = z.object({ message_ids: z.array(uuid).min(1).max(20), claim_id: z.string().optional() });
const heartbeatSchema = z.object({ claim_id: z.string().optional() }).optional();
const createSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  trust: z.string().optional(),
  enabled: z.boolean().optional(),
});
const patchSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  trust: z.string().optional(),
  enabled: z.boolean().optional(),
});

/** At most this many non-poll calls per client and minute. */
const CALLS_PER_MINUTE = 120;

export async function registerExternalClientRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const service = new ExternalClientsService(ctx.db, ctx.env, ctx.keyring);
  const events = new AdminEventsService(ctx.db);
  const windows = new Map<string, { start: number; count: number }>();

  function fail(reply: FastifyReply, error: unknown): FastifyReply {
    let status = 500;
    let code = 'server_error';
    let message = 'Internal error';
    let headers: Record<string, string> | undefined;
    if (error instanceof ApiError) {
      status = error.status;
      code = CODE_MAP[error.code] ?? error.code;
      message = error.message;
      headers = error.headers;
      // Anything the interface does not expose is a refusal of this one call.
      if (status === 403 && !['client_disabled', 'call_forbidden'].includes(code)) code = 'call_forbidden';
    } else {
      app.log.error({ err: error }, 'external client route failed');
    }
    if (status === 422) status = 400;
    for (const [name, value] of Object.entries(headers ?? {})) reply.header(name, value);
    return raw(reply).code(status).type('application/json').send({ error: { code, message } });
  }

  function limited(client: ExternalClient): void {
    const now = Date.now();
    const current = windows.get(client.id);
    if (!current || now - current.start >= 60_000) {
      windows.set(client.id, { start: now, count: 1 });
      return;
    }
    if (++current.count > CALLS_PER_MINUTE) {
      const wait = Math.max(1, Math.ceil((current.start + 60_000 - now) / 1000));
      throw new ExternalCallError(429, 'rate_limited', 'Too many requests', { 'Retry-After': String(wait) });
    }
  }

  async function handle<T>(
    req: FastifyRequest,
    reply: FastifyReply,
    run: (client: ExternalClient) => Promise<T>,
    options: { limit?: boolean } = {},
  ): Promise<FastifyReply> {
    try {
      const client = await service.authenticate(parseBearer(req.headers['authorization']));
      if (options.limit !== false) limited(client);
      const body = await run(client);
      return raw(reply).code(200).type('application/json').send(body);
    } catch (error) {
      return fail(reply, error);
    }
  }

  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
      throw new ApiError(`${where}${issue?.message ?? 'Invalid request'}`, { status: 400, code: 'validation_failed' });
    }
    return parsed.data;
  }

  // ── /external/v1 ────────────────────────────────────────────────────────
  app.get('/external/v1/inbox', async (req, reply) =>
    handle(
      req,
      reply,
      async (client) => {
        const query = req.query as { wait?: string };
        const wait = Number.isFinite(Number(query.wait)) ? Number(query.wait) : 25;
        const delivery = await service.bridge.poll(client, wait);
        return {
          messages: delivery ? [await service.envelope(delivery)] : [],
          claim_id: delivery?.claim_id ?? null,
          server_time: new Date().toISOString(),
        };
      },
      { limit: false },
    ),
  );

  app.post('/external/v1/inbox/ack', async (req, reply) =>
    handle(req, reply, async (client) => {
      const body = parse(ackSchema, req.body);
      return { ...(await service.bridge.ack(client, body.message_ids)), server_time: new Date().toISOString() };
    }),
  );

  app.post('/external/v1/send', async (req, reply) =>
    handle(req, reply, async (client) => {
      const body = parse(sendSchema, req.body);
      const sent = await service.bridge.send(client, {
        clientMessageId: body.client_message_id,
        to: body.to,
        content: body.content,
        conversationId: body.conversation_id ?? null,
        deliveryClass: body.delivery_class,
        relatedWorkId: body.related_work_id ?? null,
        ttlSeconds: body.ttl_seconds ?? null,
      });
      return { ok: true, message: sent.message ?? sent, server_time: new Date().toISOString() };
    }),
  );

  app.post('/external/v1/reply', async (req, reply) =>
    handle(req, reply, async (client) => {
      const body = parse(replySchema, req.body);
      const sent = await service.bridge.reply(client, {
        clientMessageId: body.client_message_id,
        replyTo: body.reply_to,
        content: body.content,
        ttlSeconds: body.ttl_seconds ?? null,
      });
      return { ok: true, message: sent.message ?? sent, server_time: new Date().toISOString() };
    }),
  );

  app.post('/external/v1/result', async (req, reply) =>
    handle(req, reply, async (client) => {
      const body = parse(resultSchema, req.body);
      await service.bridge.result(client, {
        workId: body.work_id,
        status: body.status,
        summary: body.content ?? body.status,
      });
      return { ok: true, server_time: new Date().toISOString() };
    }),
  );

  app.post('/external/v1/heartbeat', async (req, reply) =>
    handle(req, reply, async (client) => {
      parse(heartbeatSchema as z.ZodType<unknown>, req.body);
      await service.bridge.heartbeat(client);
      return { ok: true, server_time: new Date().toISOString() };
    }),
  );

  app.get('/external/v1/agents', async (req, reply) =>
    handle(req, reply, async (client) => {
      const q = req.query as { name?: string; engine?: string; include_offline?: string; limit?: string; offset?: string };
      return service.bridge.agents(client, {
        name: q.name,
        engine: q.engine,
        includeOffline: q.include_offline === undefined ? undefined : q.include_offline !== 'false',
        limit: q.limit ? Math.min(50, Math.max(1, Number(q.limit))) : undefined,
        offset: q.offset ? Math.max(0, Number(q.offset)) : undefined,
      });
    }),
  );

  // ── /admin/external-clients ─────────────────────────────────────────────
  const actor = (req: FastifyRequest): number | null => req.admin?.user?.id ?? null;
  const idOf = (req: FastifyRequest): string => String((req.params as { id?: unknown }).id ?? '');

  app.get('/admin/external-clients', { preHandler: app.requireAdmin }, async () => ({
    clients: await service.list(),
  }));

  app.post('/admin/external-clients', { preHandler: app.requireAdmin }, async (req) => {
    const body = parse(createSchema, req.body);
    const created = await service.create({ ...body, adminId: actor(req) });
    await events.record({
      type: 'external_client.created',
      payload: { id: created.client.id, name: created.client.name, trust: created.client.trust, admin_user_id: actor(req) },
    });
    return created;
  });

  app.patch('/admin/external-clients/:id', { preHandler: app.requireAdmin }, async (req) => {
    const body = parse(patchSchema, req.body);
    const before = await service.get(idOf(req));
    const client = await service.update(idOf(req), body);
    await events.record({
      type: 'external_client.updated',
      payload: {
        id: client.id,
        name: client.name,
        trust_from: before.trust,
        trust_to: client.trust,
        enabled: client.enabled,
        admin_user_id: actor(req),
      },
    });
    return { client };
  });

  app.post('/admin/external-clients/:id/rotate-key', { preHandler: app.requireAdmin }, async (req) => {
    const rotated = await service.rotateKey(idOf(req));
    await events.record({
      type: 'external_client.key_rotated',
      payload: { id: rotated.client.id, name: rotated.client.name, admin_user_id: actor(req) },
    });
    return rotated;
  });

  app.delete('/admin/external-clients/:id', { preHandler: app.requireAdmin }, async (req) => {
    const before = await service.get(idOf(req));
    await service.remove(idOf(req));
    await events.record({
      type: 'external_client.deleted',
      payload: { id: before.id, name: before.name, admin_user_id: actor(req) },
    });
    return { ok: true };
  });
}
