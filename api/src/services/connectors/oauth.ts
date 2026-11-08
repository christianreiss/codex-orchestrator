import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConnectorStore } from './store.js';
import {
  policySchema,
  grantSchema,
  intersectScope,
  type ConnectorPolicy,
  type GrantScope,
  type providers,
} from './policy.js';
import { UnauthorizedError, ForbiddenError } from '../../http/errors.js';
import { setOwnerRequestPrincipal } from '../../control-plane/state/runtime.js';

export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');
export interface Client {
  id: string;
  provider: (typeof providers)[number];
  name: string;
  redirects: string[];
}
export interface Grant {
  id: string;
  userId: number;
  clientId: string;
  provider: Client['provider'];
  scope: GrantScope;
  operations: string[];
  createdAt: string;
}
interface Code {
  clientId: string;
  redirect: string;
  challenge: string;
  resource: string;
  grantId: string;
}
interface Token {
  grantId: string;
  clientId: string;
  resource: string;
  used?: boolean;
}
export class ConnectorOAuth {
  constructor(
    readonly store: ConnectorStore,
    readonly issuer: string,
  ) {}
  policy(snapshot = this.store.snapshot()): ConnectorPolicy {
    return policySchema.parse(this.store.get('policy', snapshot) ?? {});
  }
  enabled(provider?: Client['provider'], snapshot = this.store.snapshot()): ConnectorPolicy {
    if (!this.issuer) throw new ForbiddenError('Connector HTTPS origin is not configured');
    const policy = this.policy(snapshot);
    if (!policy.enabled || (provider && !policy.providers[provider]))
      throw new ForbiddenError('Connector access is disabled');
    return policy;
  }
  async setPolicy(input: unknown): Promise<ConnectorPolicy> {
    const next = policySchema.parse(input);
    await this.store.change('policy', (ctx) => {
      const previous = this.policy(ctx.snapshot);
      for (const row of ctx.snapshot.table('connectorRecords').all()) {
        if (row.kind !== 'grant') continue;
        const grant = JSON.parse(row.bodyJson) as Grant;
        if (!next.enabled || !next.providers[grant.provider] || (previous.enabled && !next.enabled))
          this.store.remove(ctx, row.id);
      }
      this.store.put(ctx, 'policy', 'policy', next);
      return true;
    });
    return next;
  }
  client(id: string): Client {
    const c = this.store.get<Client>(`client:${digest(id)}`);
    if (!c) throw new UnauthorizedError('Unknown OAuth client');
    this.enabled(c.provider);
    return c;
  }
  async register(input: unknown, provider: Client['provider']): Promise<Client> {
    this.enabled(provider);
    const body = z
      .object({
        client_name: z.string().min(1).max(100).default(provider),
        redirect_uris: z.array(z.string().url().max(2048)).min(1).max(8),
        token_endpoint_auth_method: z.literal('none').default('none'),
        grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).optional(),
        response_types: z.array(z.literal('code')).optional(),
      })
      .parse(input);
    for (const uri of body.redirect_uris) {
      const u = new URL(uri);
      if (u.protocol !== 'https:' || u.hash || u.username || u.password)
        throw new ForbiddenError('Redirects must be HTTPS URLs without fragments or credentials');
    }
    const client: Client = {
      id: randomUUID(),
      provider,
      name: body.client_name,
      redirects: body.redirect_uris,
    };
    await this.store.change('register', (ctx) => {
      this.enabled(provider, ctx.snapshot);
      this.store.put(ctx, `client:${digest(client.id)}`, 'client', client);
      return true;
    });
    return client;
  }
  async resolveClient(id: string): Promise<Client> {
    if (!id.startsWith('https://')) return this.client(id);
    const u = new URL(id);
    const provider =
      u.origin === 'https://chatgpt.com' && /^\/oauth\/(?:[A-Za-z0-9_-]+\/)?client\.json$/.test(u.pathname)
        ? 'chatgpt'
        : u.origin === 'https://claude.ai' && ['/oauth/mcp-oauth-client-metadata'].includes(u.pathname)
          ? 'claude'
          : u.origin === 'https://grok.com' && u.pathname === '/oauth/mcp-client.json'
            ? 'grok'
            : null;
    if (!provider || u.search || u.hash || u.username || u.password)
      throw new ForbiddenError('Unsupported published OAuth client identity');
    this.enabled(provider);
    const cached = this.store.get<Client>(`client:${digest(id)}`);
    if (cached) return cached;
    const response = await fetch(id, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 65536)
      throw new ForbiddenError('Client metadata unavailable');
    const reader = response.body?.getReader();
    if (!reader) throw new ForbiddenError('Empty client metadata');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 65536) throw new ForbiddenError('Client metadata too large');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    const metadata = z
      .object({
        client_id: z.literal(id),
        client_name: z.string().max(100).optional(),
        redirect_uris: z.array(z.string().url()).min(1).max(20),
        token_endpoint_auth_method: z.string().optional(),
        token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
      })
      .parse(JSON.parse(Buffer.concat(chunks).toString()));
    const methods = metadata.token_endpoint_auth_methods_supported ?? [
      metadata.token_endpoint_auth_method ?? 'none',
    ];
    if (!methods.includes('none')) throw new ForbiddenError('Client must support public PKCE authentication');
    if (
      metadata.redirect_uris.some((uri) => {
        const r = new URL(uri);
        return r.protocol !== 'https:' || !!r.hash || !!r.username || !!r.password;
      })
    )
      throw new ForbiddenError('Invalid published redirect');
    const client: Client = {
      id,
      provider,
      name: metadata.client_name ?? provider,
      redirects: metadata.redirect_uris,
    };
    await this.store.change('published_client', (ctx) => {
      this.enabled(provider, ctx.snapshot);
      this.store.put(ctx, `client:${digest(id)}`, 'client', client, 3600);
      return true;
    });
    return client;
  }
  validateAuthorization(query: Record<string, unknown>): Code & { state: string; client: Client } {
    const q = z
      .object({
        client_id: z.string(),
        redirect_uri: z.string(),
        response_type: z.literal('code'),
        code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        code_challenge_method: z.literal('S256'),
        resource: z.literal(`${this.issuer}/connectors/mcp`),
        state: z.string().max(2048).default(''),
        scope: z.literal('connector').optional(),
      })
      .parse(query);
    const client = this.client(q.client_id);
    if (!client.redirects.includes(q.redirect_uri)) throw new ForbiddenError('Unregistered redirect URI');
    return {
      clientId: client.id,
      client,
      redirect: q.redirect_uri,
      challenge: q.code_challenge,
      resource: q.resource,
      state: q.state,
      grantId: '',
    };
  }
  async consent(
    userId: number,
    request: ReturnType<ConnectorOAuth['validateAuthorization']>,
    scopeInput: unknown,
    operationNames: (
      scope: GrantScope,
      policy: ConnectorPolicy,
      user: import('../../control-plane/state/catalog.js').StateRow<'adminUsers'>,
    ) => string[],
    requestKey: string,
  ): Promise<string> {
    const selected = grantSchema.parse(scopeInput),
      code = token(),
      grantId = randomUUID();
    await this.store.change('consent', (ctx) => {
      if (JSON.stringify(this.store.get(requestKey, ctx.snapshot)) !== JSON.stringify(request))
        throw new ForbiddenError('Authorization request consumed or expired');
      this.store.remove(ctx, requestKey);
      const policy = this.enabled(request.client.provider, ctx.snapshot);
      const scope = intersectScope(selected, policy.ceiling);
      const user = ctx.snapshot.table('adminUsers').get(userId);
      if (!user?.active) throw new UnauthorizedError('User disabled');
      this.store.put(
        ctx,
        `grant:${grantId}`,
        'grant',
        {
          id: grantId,
          userId,
          clientId: request.clientId,
          provider: request.client.provider,
          scope,
          operations: operationNames(scope, policy, user),
          createdAt: new Date().toISOString(),
        } satisfies Grant,
        30 * 86400,
      );
      this.store.put(
        ctx,
        `code:${digest(code)}`,
        'code',
        {
          clientId: request.clientId,
          redirect: request.redirect,
          challenge: request.challenge,
          resource: request.resource,
          grantId,
        } satisfies Code,
        60,
      );
      return true;
    });
    const url = new URL(request.redirect);
    url.searchParams.set('iss', this.issuer);
    url.searchParams.set('code', code);
    url.searchParams.set('state', request.state);
    return url.href;
  }
  authority(grantId: string, snapshot = this.store.snapshot()) {
    const grant = this.store.get<Grant>(`grant:${grantId}`, snapshot);
    if (!grant) throw new UnauthorizedError('Connector grant revoked or expired');
    const policy = this.enabled(grant.provider, snapshot),
      user = snapshot.table('adminUsers').get(grant.userId);
    if (!user?.active) throw new UnauthorizedError('User disabled');
    return { grant, policy, user };
  }
  async exchange(input: unknown) {
    const b = z
      .object({
        grant_type: z.enum(['authorization_code', 'refresh_token']),
        client_id: z.string(),
        resource: z.literal(`${this.issuer}/connectors/mcp`).default(`${this.issuer}/connectors/mcp`),
        code: z.string().optional(),
        redirect_uri: z.string().optional(),
        code_verifier: z
          .string()
          .regex(/^[A-Za-z0-9._~-]{43,128}$/)
          .optional(),
        refresh_token: z.string().optional(),
      })
      .parse(input);
    await this.resolveClient(b.client_id);
    const access = token(),
      refresh = token();
    const result = await this.store.change('exchange', (ctx) => {
      let grantId: string;
      if (b.grant_type === 'authorization_code') {
        const key = `code:${digest(b.code ?? '')}`,
          c = this.store.get<Code>(key, ctx.snapshot);
        if (
          !c ||
          c.clientId !== b.client_id ||
          c.redirect !== b.redirect_uri ||
          c.resource !== b.resource ||
          !b.code_verifier ||
          createHash('sha256').update(b.code_verifier).digest('base64url') !== c.challenge
        )
          throw new UnauthorizedError('Invalid authorization code');
        this.store.remove(ctx, key);
        grantId = c.grantId;
      } else {
        const key = `refresh:${digest(b.refresh_token ?? '')}`,
          t = this.store.get<Token>(key, ctx.snapshot);
        if (!t || t.clientId !== b.client_id || t.resource !== b.resource)
          throw new UnauthorizedError('Invalid refresh token');
        if (t.used) {
          this.store.remove(ctx, `grant:${t.grantId}`);
          return false;
        }
        grantId = t.grantId;
        this.store.put(ctx, key, 'refresh', { ...t, used: true }, 30 * 86400);
      }
      this.authority(grantId, ctx.snapshot);
      const body = { grantId, clientId: b.client_id, resource: b.resource };
      this.store.put(ctx, `access:${digest(access)}`, 'access', body, 900);
      this.store.put(ctx, `refresh:${digest(refresh)}`, 'refresh', body, 30 * 86400);
      return true;
    });
    if (!result) throw new UnauthorizedError('Refresh token reuse revoked the connection');
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: 900,
      scope: 'connector',
    };
  }
  authenticate(bearer: string) {
    const t = this.store.get<Token>(`access:${digest(bearer)}`);
    if (!t || t.resource !== `${this.issuer}/connectors/mcp`)
      throw new UnauthorizedError('Invalid connector token');
    const initial = this.authority(t.grantId);
    setOwnerRequestPrincipal({
      principal: `connector:${initial.grant.id}`,
      revalidate: (snapshot) => {
        if (!this.store.get(`access:${digest(bearer)}`, snapshot))
          throw new UnauthorizedError('Token expired');
        const current = this.authority(t.grantId, snapshot);
        if (JSON.stringify(current) !== JSON.stringify(initial))
          throw new UnauthorizedError('Connector authority changed');
      },
    });
    return initial;
  }
}
