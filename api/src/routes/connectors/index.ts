import { canonicalConnectorOrigin, canonicalDashboardOrigin } from '../../util/connector-origin.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { RouteContext } from '../index.js';
import { ConnectorStore } from '../../services/connectors/store.js';
import { ConnectorOAuth, digest, type Grant } from '../../services/connectors/oauth.js';
import { ConnectorCatalog } from '../../services/connectors/catalog.js';
import { providers, grantSchema, intersectScope } from '../../services/connectors/policy.js';
import { capabilitiesForRole } from '../../security/capabilities.js';
import { ForbiddenError } from '../../http/errors.js';
import { raw } from '../../http/reply.js';
import { AdminEventsService } from '../../services/admin-events.js';

export async function registerConnectorRoutes(app: FastifyInstance, ctx: RouteContext) {
  // This module stays inert until an operator configures a public HTTPS issuer.
  const base = canonicalConnectorOrigin(ctx.env.CONNECTOR_PUBLIC_BASE_URL ?? ctx.env.PUBLIC_BASE_URL) ?? '';
  const dashboardBase = canonicalDashboardOrigin(ctx.env.PUBLIC_BASE_URL) ?? '';
  const oauth = new ConnectorOAuth(new ConnectorStore(ctx.db), base),
    catalog = new ConnectorCatalog(oauth, ctx),
    events = new AdminEventsService(ctx.db);
  const validIssuer = () => {
    if (!base) throw new ForbiddenError('Configure the connector base URL as a canonical HTTPS origin');
  };
  const administrator = (req: FastifyRequest) => {
    if (!capabilitiesForRole(req.admin!.user.accessLevel).includes('security.manage_authorization'))
      throw new ForbiddenError('Administrator connector policy permission required');
  };
  const sameOrigin = (req: FastifyRequest) => {
    const origin = req.headers.origin;
    if (
      typeof origin !== 'string' ||
      !origin ||
      ![base, dashboardBase].some((allowed) => !!allowed && allowed === origin)
    )
      throw new ForbiddenError('Same-origin request required');
  };
  const limits = new Map<string, { start: number; count: number }>();
  const rate = (req: FastifyRequest, max = 60) => {
    const key = `${req.ip}:${req.routeOptions.url}`;
    const now = Date.now();
    let entry = limits.get(key);
    if (!entry || now - entry.start > 60000) {
      entry = { start: now, count: 0 };
      limits.set(key, entry);
    }
    if (++entry.count > max) throw new ForbiddenError('Connector rate limit exceeded');
    if (limits.size > 10000) for (const [k, v] of limits) if (now - v.start > 60000) limits.delete(k);
  };
  const audit = (type: string, payload: Record<string, unknown>) =>
    events.record({ type: 'connector.changed', payload: { ...payload, event: type } });
  app.get('/admin/connectors/config', { preHandler: app.requireAdmin }, async (req) => ({
    policy: oauth.policy(),
    can_manage: capabilitiesForRole(req.admin!.user.accessLevel).includes('security.manage_authorization'),
    issuer: base,
    mcp_url: `${base}/connectors/mcp`,
    ready: Boolean(base),
    catalog: Object.entries(catalog.operations).map(([name, o]) => ({
      name,
      category: o.category,
      write: !!o.write,
      sensitive: o.sensitive,
      description: o.description,
    })),
    hosts: capabilitiesForRole(req.admin!.user.accessLevel).includes('hosts.read')
      ? oauth.store
          .snapshot()
          .hosts.all()
          .map((h) => ({ id: h.id, name: h.fqdn }))
      : [],
    projects: capabilitiesForRole(req.admin!.user.accessLevel).includes('projects.read')
      ? oauth.store
          .snapshot()
          .table('coordProjects')
          .all()
          .map((p) => p.slug)
      : [],
  }));
  app.put('/admin/connectors/config', { preHandler: app.requireAdmin }, async (req) => {
    sameOrigin(req);
    administrator(req);
    if ((req.body as { enabled?: boolean })?.enabled) validIssuer();
    const result = await oauth.setPolicy(req.body);
    await audit('policy', { user_id: req.admin!.user.id, enabled: result.enabled });
    return result;
  });
  app.post('/admin/connectors/preview', { preHandler: app.requireAdmin }, async (req) => {
    sameOrigin(req);
    const scope = intersectScope(grantSchema.parse(req.body), oauth.policy().ceiling),
      user = oauth.store.snapshot().table('adminUsers').get(req.admin!.user.id)!;
    return {
      scope,
      operations: catalog.names({
        grant: {
          id: '',
          userId: user.id,
          clientId: '',
          provider: 'chatgpt',
          scope,
          operations: [],
          createdAt: '',
        },
        policy: oauth.policy(),
        user,
      }),
    };
  });
  app.post('/admin/connectors/clients', { preHandler: app.requireAdmin }, async (req) => {
    sameOrigin(req);
    rate(req, 10);
    const b = z.object({ provider: z.enum(providers), redirect_uri: z.string().url() }).parse(req.body);
    const c = await oauth.register({ client_name: b.provider, redirect_uris: [b.redirect_uri] }, b.provider);
    return { client_id: c.id };
  });
  app.get('/admin/connectors/connections', { preHandler: app.requireAdmin }, async (req) => ({
    connections: oauth.store
      .snapshot()
      .table('connectorRecords')
      .all()
      .filter((r) => r.kind === 'grant')
      .map((r) => JSON.parse(r.bodyJson) as Grant)
      .filter(
        (g) =>
          g.userId === req.admin!.user.id ||
          capabilitiesForRole(req.admin!.user.accessLevel).includes('security.manage_authorization'),
      )
      .map((g) => ({ ...g, last_call_at: oauth.store.get<{ at: string }>(`activity:${g.id}`)?.at ?? null })),
  }));
  app.delete('/admin/connectors/connections/:id', { preHandler: app.requireAdmin }, async (req) => {
    sameOrigin(req);
    const id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id),
      grant = oauth.store.get<Grant>(`grant:${id}`);
    if (grant && grant.userId !== req.admin!.user.id) administrator(req);
    await oauth.store.change('revoke', (c) => {
      oauth.store.remove(c, `grant:${id}`);
      return true;
    });
    await audit('revoked', { grant_id: id, user_id: req.admin!.user.id });
    return { revoked: true };
  });
  app.get('/.well-known/oauth-protected-resource/connectors/mcp', async (_req, reply) => {
    validIssuer();
    oauth.enabled();
    return raw(reply).send({
      resource: `${base}/connectors/mcp`,
      authorization_servers: [base],
      scopes_supported: ['connector'],
      bearer_methods_supported: ['header'],
    });
  });
  app.get('/.well-known/oauth-authorization-server', async (_req, reply) => {
    validIssuer();
    oauth.enabled();
    return raw(reply).send({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['connector'],
    });
  });
  app.post('/oauth/register', async (req, reply) => {
    rate(req, 10);
    validIssuer();
    const label = String((req.body as { client_name?: string })?.client_name ?? '').toLowerCase();
    const provider = z
      .enum(providers)
      .parse(
        (req.query as { provider?: string }).provider ??
          (label.includes('claude') ? 'claude' : label.includes('grok') ? 'grok' : 'chatgpt'),
      );
    const c = await oauth.register(req.body, provider);
    await audit('client_registered', { client_id: c.id, provider });
    return raw(reply)
      .code(201)
      .send({
        client_id: c.id,
        client_name: c.name,
        redirect_uris: c.redirects,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
  });
  app.get('/oauth/authorize', async (req, reply) => {
    rate(req);
    validIssuer();
    await oauth.resolveClient(String((req.query as Record<string, unknown>).client_id ?? ''));
    const request = oauth.validateAuthorization(req.query as Record<string, unknown>),
      id = randomBytes(32).toString('base64url');
    await oauth.store.change('authorization_request', (c) => {
      oauth.store.put(c, `request:${digest(id)}`, 'request', request, 600);
      return true;
    });
    return raw(reply).redirect(`/admin/connectors?request=${encodeURIComponent(id)}`);
  });
  app.get('/admin/connectors/consent/:id', { preHandler: app.requireAdmin }, async (req) => {
    const id = (req.params as { id: string }).id,
      request = oauth.store.get<ReturnType<ConnectorOAuth['validateAuthorization']>>(`request:${digest(id)}`);
    if (!request) throw new ForbiddenError('Authorization request expired');
    return { client: request.client, request: id, csrf: digest(`${req.admin!.session.tokenHash}:${id}`) };
  });
  app.post('/admin/connectors/consent/:id', { preHandler: app.requireAdmin }, async (req) => {
    sameOrigin(req);
    const id = (req.params as { id: string }).id,
      body = z.object({ csrf: z.string(), scope: grantSchema, approve: z.boolean() }).parse(req.body),
      key = `request:${digest(id)}`;
    if (body.csrf !== digest(`${req.admin!.session.tokenHash}:${id}`))
      throw new ForbiddenError('Invalid consent token');
    const request = oauth.store.get<ReturnType<ConnectorOAuth['validateAuthorization']>>(key);
    if (!request) throw new ForbiddenError('Authorization request expired');
    if (!body.approve) {
      await oauth.store.change('denied_consent', (ctx) => {
        oauth.store.remove(ctx, key);
        return true;
      });
      const u = new URL(request.redirect);
      u.searchParams.set('iss', base);
      u.searchParams.set('error', 'access_denied');
      u.searchParams.set('state', request.state);
      return { redirect: u.href };
    }
    // Validate again so removed clients or disabled providers cannot reuse pending consent.
    oauth.client(request.clientId);
    const auth = {
      grant: {
        id: '',
        userId: req.admin!.user.id,
        clientId: request.clientId,
        provider: request.client.provider,
        scope: body.scope,
        operations: [],
        createdAt: '',
      },
      policy: oauth.policy(),
      user: oauth.store.snapshot().table('adminUsers').get(req.admin!.user.id)!,
    };
    const redirect = await oauth.consent(
      req.admin!.user.id,
      request,
      body.scope,
      (scope, policy, user) => catalog.names({ ...auth, grant: { ...auth.grant, scope }, policy, user }),
      key,
    );
    await audit('consent', { user_id: req.admin!.user.id, client_id: request.clientId });
    return { redirect };
  });
  await app.register(async (app) => {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(String(body)))),
    );
    app.post('/oauth/token', async (req, reply) => {
      rate(req);
      reply.header('Cache-Control', 'no-store');
      try {
        return raw(reply).send(await oauth.exchange(req.body));
      } catch {
        return raw(reply).code(400).send({ error: 'invalid_grant' });
      }
    });
    app.post('/oauth/revoke', async (req, reply) => {
      rate(req);
      const body = z.object({ token: z.string(), client_id: z.string() }).parse(req.body);
      const t =
        oauth.store.get<{ grantId: string; clientId: string }>(`refresh:${digest(body.token)}`) ??
        oauth.store.get<{ grantId: string; clientId: string }>(`access:${digest(body.token)}`);
      if (t?.clientId === body.client_id)
        await oauth.store.change('revoke', (c) => {
          oauth.store.remove(c, `grant:${t.grantId}`);
          return true;
        });
      return raw(reply).send({});
    });
  });
  const challenge = (reply: import('fastify').FastifyReply) =>
    reply.header(
      'WWW-Authenticate',
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/connectors/mcp"`,
    );
  app.get('/connectors/mcp', async (_req, reply) => {
    challenge(reply);
    return raw(reply).code(405).header('Allow', 'POST').send({ error: 'POST required' });
  });
  app.post('/connectors/mcp', async (req, reply) => {
    rate(req, 120);
    reply.header('Cache-Control', 'no-store');
    let auth: ReturnType<ConnectorOAuth['authenticate']>;
    try {
      auth = oauth.authenticate(
        req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '',
      );
    } catch {
      challenge(reply);
      return raw(reply).code(401).send({ error: 'invalid_token' });
    }
    const b = z
      .object({
        jsonrpc: z.literal('2.0'),
        id: z.union([z.string(), z.number(), z.null()]).optional(),
        method: z.string(),
        params: z.record(z.unknown()).optional(),
      })
      .parse(req.body);
    if (b.id === undefined) return raw(reply).code(202).send();
    let result: unknown;
    try {
      if (b.method === 'initialize')
        result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'Orchestrator connectors', version: '1.0.0' },
          instructions:
            'Only explicitly consented operations and targets are available. Delegated work can execute commands on the selected host.',
        };
      else if (b.method === 'ping') result = {};
      else if (b.method === 'tools/list') result = { tools: catalog.list(auth) };
      else if (b.method === 'tools/call') {
        const p = z
          .object({ name: z.string(), arguments: z.record(z.unknown()).default({}) })
          .parse(b.params);
        const output = await catalog.call(p.name, p.arguments, auth);
        await oauth.store.change('activity', (c) => {
          oauth.store.put(
            c,
            `activity:${auth.grant.id}`,
            'activity',
            { at: new Date().toISOString() },
            30 * 86400,
          );
          return true;
        });
        await audit('tool_call', { grant_id: auth.grant.id, user_id: auth.user.id, tool: p.name });
        result = { content: [{ type: 'text', text: JSON.stringify(output) }] };
      } else
        return raw(reply).send({
          jsonrpc: '2.0',
          id: b.id,
          error: { code: -32601, message: 'Method not found' },
        });
      return raw(reply).send({ jsonrpc: '2.0', id: b.id, result });
    } catch {
      await audit('denied', { grant_id: auth.grant.id, method: b.method });
      return raw(reply).send({
        jsonrpc: '2.0',
        id: b.id,
        error: { code: -32602, message: 'Operation denied or invalid arguments' },
      });
    }
  });
}
