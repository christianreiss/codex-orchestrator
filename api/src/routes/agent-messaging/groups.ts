import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UnauthorizedError } from '../../http/errors.js';
import type { AgentMessagingService } from '../../services/agent-messaging.js';
import { createAdminEventsService } from '../../services/admin-events.js';
import type { RouteContext } from '../index.js';

const createSchema = z
  .object({ slug: z.string(), title: z.string(), description: z.string().nullable().optional() })
  .strict();
const publishSchema = z
  .object({
    topic: z.string(),
    content: z.string(),
    client_message_id: z.string().uuid(),
    ttl_seconds: z.number().int().nullable().optional(),
  })
  .strict();

export function registerAgentGroupRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  messaging: AgentMessagingService,
): void {
  const events = createAdminEventsService(ctx.db);
  const bridge = (req: FastifyRequest) => {
    const token = req.headers['x-agent-bridge-token'];
    if (typeof token !== 'string' || !token.trim())
      throw new UnauthorizedError('Agent bridge token required', 'agent_bridge_token_required');
    return {
      id: z
        .string()
        .uuid()
        .parse((req.params as { id?: string }).id),
      token,
    };
  };
  const audit = async (req: FastifyRequest, type: string, payload: Record<string, unknown>) => {
    await events.record(
      { type, payload: { ...payload, admin_user_id: req.admin?.user.id ?? null } },
      { broadcast: false },
    );
  };
  app.get('/admin/agent-messaging/groups', { preHandler: app.requireAdmin }, () =>
    messaging.listAdminGroups(),
  );
  app.get('/admin/agent-messaging/groups/:slug', { preHandler: app.requireAdmin }, (req) =>
    messaging.getAdminGroup(z.string().parse((req.params as { slug?: string }).slug)),
  );
  app.post('/admin/agent-messaging/groups', { preHandler: app.requireAdmin }, async (req) => {
    const result = await messaging.createAdminGroup(createSchema.parse(req.body));
    if (result.created)
      await audit(req, 'agent_messaging.group.created', {
        group_id: result.group.id,
        slug: result.group.slug,
      });
    return result;
  });
  app.get('/admin/agent-messaging/subscriptions', { preHandler: app.requireAdmin }, () =>
    messaging.listAdminSubscriptions(),
  );
  const publishAdmin = async (req: FastifyRequest, topic?: string) => {
    const body =
      topic === undefined
        ? publishSchema.parse(req.body)
        : publishSchema.omit({ topic: true }).parse(req.body);
    const result = await messaging.publishAdmin({
      topic: topic ?? (body as z.infer<typeof publishSchema>).topic,
      content: body.content,
      clientMessageId: body.client_message_id,
      ttlSeconds: body.ttl_seconds,
    });
    if (result.created)
      await audit(req, 'agent_messaging.publication.created', {
        publication_id: result.publication_id,
        topic: result.topic,
        recipient_count: result.recipient_count,
        skipped_count: result.skipped.length,
      });
    return result;
  };
  app.post('/admin/agent-messaging/publish', { preHandler: app.requireAdmin }, (req) => publishAdmin(req));
  app.post('/admin/agent-messaging/groups/:slug/publish', { preHandler: app.requireAdmin }, (req) =>
    publishAdmin(req, `group:${z.string().parse((req.params as { slug?: string }).slug)}`),
  );

  app.post('/host/agent-sessions/:id/agent-messaging/groups/list', (req) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    const { id, token } = bridge(req);
    return messaging.listGroups(id, token);
  });
  app.post('/host/agent-sessions/:id/agent-messaging/groups/create', (req) => {
    const { id, token } = bridge(req);
    return messaging.createGroup(id, token, createSchema.parse(req.body));
  });
  app.post('/host/agent-sessions/:id/agent-messaging/groups/detail', (req) => {
    const body = z.object({ slug: z.string() }).strict().parse(req.body);
    const { id, token } = bridge(req);
    return messaging.groupMembers(id, token, body.slug);
  });
  app.post('/host/agent-sessions/:id/agent-messaging/subscribe', (req) => {
    const body = z.object({ topic: z.string() }).strict().parse(req.body);
    const { id, token } = bridge(req);
    return messaging.subscribe(id, token, body.topic);
  });
  app.post('/host/agent-sessions/:id/agent-messaging/unsubscribe', (req) => {
    const body = z.object({ topic: z.string() }).strict().parse(req.body);
    const { id, token } = bridge(req);
    return messaging.unsubscribe(id, token, body.topic);
  });
  app.post('/host/agent-sessions/:id/agent-messaging/subscriptions', (req) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    const { id, token } = bridge(req);
    return messaging.subscriptions(id, token);
  });
  app.post('/host/agent-sessions/:id/agent-messaging/publish', (req) => {
    const body = publishSchema.parse(req.body);
    const { id, token } = bridge(req);
    return messaging.publish(id, token, {
      topic: body.topic,
      content: body.content,
      clientMessageId: body.client_message_id,
      ttlSeconds: body.ttl_seconds,
    });
  });
}
