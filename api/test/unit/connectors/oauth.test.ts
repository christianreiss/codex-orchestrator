import {
  ownedClaimCandidates,
  type OwnedClaimOptions,
} from '../../../src/services/agent-messaging/owned-claim.js';
import Fastify from 'fastify';
import { registerConnectorRoutes } from '../../../src/routes/connectors/index.js';
import { testKeyring, loadTestEnv } from '../../helpers/test-keyring.js';
import { intersectScope } from '../../../src/services/connectors/policy.js';
import { connectorWorkAllowed, connectorMessageAllowed } from '../../../src/services/connectors/work.js';
import { randomUUID, createHash } from 'node:crypto';
import { afterEach, describe, it, expect, vi } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import {
  OwnerStateSnapshot,
  OwnerStateStore,
  type PreparedOwnerState,
} from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { ConnectorStore } from '../../../src/services/connectors/store.js';
import { ConnectorOAuth } from '../../../src/services/connectors/oauth.js';
import { allowed, targetAllowed, grantSchema } from '../../../src/services/connectors/policy.js';
const queues: DeadlineQueue[] = [];
afterEach(() => {
  queues.splice(0).forEach((q) => q.close());
  vi.useRealTimers();
});
function harness(rows: Record<string, Record<string, unknown>[]> = {}) {
  const now = new Date().toISOString();
  const seed = {
    providerAccounts: [
      {
        id: 1,
        engine: 'codex',
        state: 'enabled',
        payloadId: 1,
        lastSelectedAt: null,
        mergedIntoAccountId: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    authPayloads: [{ id: 1, engine: 'codex', accountId: 1, verificationState: 'verified' }],
    ...rows,
  };
  const db = createDbFake(
    new Map(
      Object.entries(seed).map(([name, values]) => [
        (schema as unknown as Record<string, unknown>)[name],
        structuredClone(values),
      ]),
    ),
  );
  const state = new OwnerStateStore(
    new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed as unknown as StateSeed),
  );
  const deadlines = new DeadlineQueue((e) => {
    throw e;
  });
  queues.push(deadlines);
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state,
    assertOwner() {},
    loseOwner(e) {
      throw e;
    },
    committed() {},
    notificationError(e) {
      throw e;
    },
    persistence: {
      async receipt() {
        return undefined;
      },
      async transaction(run) {
        await run(db as unknown as PersistenceTransaction);
      },
      async record() {},
    },
  });
  const owner: OwnerRuntime = {
    state,
    deadlines,
    assertOwner() {},
    execute: (command) => executor.execute(command),
  };

  bindOwnerRuntime(db as unknown as import('../../../src/db/client.js').Database, owner);
  return { owner, state, db: db as unknown as import('../../../src/db/client.js').Database };
}

async function setup() {
  const { db, state } = harness({
    adminUsers: [
      { id: 1, active: 1, accessLevel: 'owner', username: 'owner', name: 'Owner', passwordHash: 'redacted' },
    ],
  });
  const store = new ConnectorStore(db),
    oauth = new ConnectorOAuth(store, 'https://fleet.example');
  const scope = grantSchema.parse({
    categories: { hosts: 'ro', projects: 'rw' },
    hosts: [1],
    projects: ['test'],
  });
  await oauth.setPolicy({
    enabled: true,
    providers: { chatgpt: true, claude: true, grok: true },
    ceiling: scope,
  });
  const client = await oauth.register({ redirect_uris: ['https://client.example/callback'] }, 'claude');
  const verifier = 'a'.repeat(64),
    challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = {
    client_id: client.id,
    redirect_uri: client.redirects[0],
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: 'https://fleet.example/connectors/mcp',
    state: 'abc',
  };
  const request = oauth.validateAuthorization(query);
  await store.change('test', (c) => {
    store.put(c, 'request:test', 'request', request, 600);
    return true;
  });
  const redirect = await oauth.consent(1, request, scope, () => ['hosts_list'], 'request:test');
  const code = new URL(redirect).searchParams.get('code')!;
  const exchange = {
    grant_type: 'authorization_code',
    client_id: client.id,
    resource: query.resource,
    redirect_uri: query.redirect_uri,
    code,
    code_verifier: verifier,
  };
  return { oauth, store, state, scope, query, exchange, db };
}
describe('connector OAuth', () => {
  it('is off by default and enforces strict category, sensitive and target grants', () => {
    const s = grantSchema.parse({ categories: { projects: 'rw' }, projects: ['a'] });
    expect(
      allowed(s, s, 'owner', 'delete', {
        category: 'projects',
        write: true,
        capability: 'projects.manage',
        sensitive: 'delete',
      }),
    ).toBe(false);
    expect(
      allowed(s, s, 'viewer', 'write', { category: 'projects', write: true, capability: 'projects.manage' }),
    ).toBe(false);
    expect(targetAllowed(s, s, 'projects', 'a')).toBe(true);
    expect(targetAllowed(s, s, 'projects', 'b')).toBe(false);
  });
  it('issues audience-bound tokens, consumes codes and rotates refresh tokens', async () => {
    const { oauth, exchange } = await setup();
    await expect(oauth.exchange({ ...exchange, code_verifier: 'b'.repeat(64) })).rejects.toThrow();
    await expect(oauth.exchange({ ...exchange, resource: 'https://other.example' })).rejects.toThrow();
    const t = await oauth.exchange(exchange);
    expect(oauth.authenticate(t.access_token).grant.operations).toEqual(['hosts_list']);
    await expect(oauth.exchange(exchange)).rejects.toThrow();
    const r = {
      grant_type: 'refresh_token',
      client_id: exchange.client_id,
      resource: exchange.resource,
      refresh_token: t.refresh_token,
    };
    const next = await oauth.exchange(r);
    expect(next.access_token).not.toBe(t.access_token);
    await expect(oauth.exchange(r)).rejects.toThrow(/reuse/);
    expect(() => oauth.authenticate(next.access_token)).toThrow();
  });
  it('rejects unregistered redirects and revokes all grants on disable', async () => {
    const { oauth, query, exchange } = await setup();
    expect(() => oauth.validateAuthorization({ ...query, redirect_uri: 'https://evil.example' })).toThrow();
    const t = await oauth.exchange(exchange);
    await oauth.setPolicy({ ...oauth.policy(), enabled: false });
    expect(() => oauth.authenticate(t.access_token)).toThrow();
    await oauth.setPolicy({ ...oauth.policy(), enabled: true });
    expect(() => oauth.authenticate(t.access_token)).toThrow();
  });
  it('rejects disabled users, expired access and concurrent code redemption', async () => {
    const { oauth, exchange, store } = await setup();
    const results = await Promise.allSettled([oauth.exchange(exchange), oauth.exchange(exchange)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const t = (
      results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
        Awaited<ReturnType<typeof oauth.exchange>>
      >
    ).value;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 901000);
    expect(() => oauth.authenticate(t.access_token)).toThrow();
    vi.useRealTimers();
    const row = store.snapshot().table('adminUsers').get(1)!;
    await store.change('disable', (c) => {
      c.draft.upsert('adminUsers', { ...row, active: 0 });
      return true;
    });
    expect(() => oauth.authenticate(t.access_token)).toThrow();
  });
});

it('never expands selected host, global or sensitive scope after ceiling expansion', () => {
  const selected = grantSchema.parse({
    categories: { projects: 'rw' },
    hosts: [1, 2],
    projects: ['a', 'b'],
    global: true,
    sensitive: ['delete'],
  });
  const ceiling = grantSchema.parse({ categories: { projects: 'ro' }, hosts: [1], projects: ['a'] });
  const consent = intersectScope(selected, ceiling);
  expect(consent).toMatchObject({
    hosts: [1],
    projects: ['a'],
    global: false,
    sensitive: [],
    categories: { projects: 'ro' },
  });
});
it('serves OAuth discovery and scoped MCP without accepting host credentials', async () => {
  const { db, oauth, exchange } = await setup();
  const app = Fastify();
  app.decorate('requireAdmin', async () => {});
  await registerConnectorRoutes(app, {
    db,
    env: { ...loadTestEnv(), PUBLIC_BASE_URL: 'https://fleet.example' },
    keyring: testKeyring(),
  });
  try {
    const metadata = await app.inject({ url: '/.well-known/oauth-authorization-server' });
    expect(metadata.json().code_challenge_methods_supported).toEqual(['S256']);
    const unauth = await app.inject({
      method: 'POST',
      url: '/connectors/mcp',
      headers: { authorization: 'Bearer host-key' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.headers['www-authenticate']).toContain('resource_metadata');
    const t = await oauth.exchange(exchange);
    const invoke = (method: string, params?: object) =>
      app.inject({
        method: 'POST',
        url: '/connectors/mcp',
        headers: { authorization: `Bearer ${t.access_token}` },
        payload: { jsonrpc: '2.0', id: 1, method, params },
      });
    expect((await invoke('tools/list')).json().result.tools.map((t: { name: string }) => t.name)).toEqual([
      'hosts_list',
    ]);
    expect(
      (await invoke('tools/call', { name: 'secret_reveal', arguments: { id: 1 } })).json().error,
    ).toBeDefined();
    expect((await invoke('resources/read', { uri: 'secret://example' })).json().error.code).toBe(-32601);
  } finally {
    await app.close();
  }
});
it.each(['chatgpt', 'claude', 'grok'] as const)(
  'validates published client metadata for %s and rejects arbitrary fetch targets',
  async (provider) => {
    const { oauth } = await setup();
    const ids = {
      chatgpt: 'https://chatgpt.com/oauth/client.json',
      claude: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
      grok: 'https://grok.com/oauth/mcp-client.json',
    };
    const id = ids[provider],
      fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            client_id: id,
            client_name: provider,
            redirect_uris: ['https://client.example/callback'],
            token_endpoint_auth_method: 'none',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    try {
      expect((await oauth.resolveClient(id)).provider).toBe(provider);
      await expect(oauth.resolveClient('https://127.0.0.1/client.json')).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  },
);
it('requires live host-scoped delegation authority before queued work delivery', async () => {
  const { oauth, store } = await setup(),
    scope = grantSchema.parse({ categories: { coordination: 'rw' }, hosts: [1], sensitive: ['delegate'] });
  await oauth.setPolicy({ ...oauth.policy(), ceiling: scope });
  await store.change('work_fixture', (ctx) => {
    ctx.draft.upsert('agentSessions', { id: 's', hostId: 1 } as never);
    store.put(ctx, 'grant:g', 'grant', {
      id: 'g',
      userId: 1,
      provider: 'claude',
      scope,
      operations: ['agent_delegate'],
    });
    return true;
  });
  const work = { grantId: 'g', userId: 1, hostId: 1, sessionId: 's' };
  expect(connectorWorkAllowed(store.snapshot(), work)).toBe(true);
  expect(connectorWorkAllowed(store.snapshot(), { ...work, hostId: 2 })).toBe(false);
  await oauth.setPolicy({ ...oauth.policy(), enabled: false });
  expect(connectorWorkAllowed(store.snapshot(), work)).toBe(false);
});

it('fails closed when permanent work provenance survives missing OAuth metadata', async () => {
  const { store } = await setup();
  expect(connectorMessageAllowed(store.snapshot(), 'missing', 'grant')).toBe(false);
  expect(connectorMessageAllowed(store.snapshot(), 'ordinary', null)).toBe(true);
});

it.each(['queued', 'leased', 'accepted', 'reboot_hold'])(
  'revocation fences queued work while preserving %s delivery ordering',
  async (status) => {
    const target = randomUUID(),
      next = randomUUID(),
      now = new Date().toISOString();
    const row = {
      targetAddressId: target,
      kind: 'request',
      workKind: 'request',
      deliveryTiming: 'after_turn',
      deliveryClass: 'coordination',
      conversationId: randomUUID(),
      expiresAt: '2099-01-01T00:00:00Z',
      nextAttemptAt: now,
    };
    const snapshot = new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
      agentBusMessages: [
        { ...row, id: randomUUID(), dispatchOrder: 1, status, connectorGrantId: 'revoked' },
        { ...row, id: next, status: 'queued', dispatchOrder: 2, connectorGrantId: null },
      ],
    } as unknown as StateSeed);
    const options = {
      targetAddressIds: [target],
      leaseOwner: `session:${randomUUID()}`,
      relayGeneration: null,
      smartQueue: true,
    } as OwnedClaimOptions;
    expect(ownedClaimCandidates(snapshot, options, now).map((r) => r.id)).toEqual(
      status === 'queued' ? [next] : [],
    );
  },
);
