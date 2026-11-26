import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { registerAdminProviderKeyRoutes } from '../../../src/routes/admin/provider-keys/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { createGatewayUpstream } from '../../../src/services/gateway-upstream/index.js';
import { upstreamConfigFromEnv } from '../../../src/services/gateway-upstream/client.js';
import { sha256 } from '../../../src/security/hash.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { memoryOwner, persisted } from '../../helpers/memory-owner.js';
import { testKeyring } from '../../helpers/test-keyring.js';

const KEY = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345678901';
const KEY_2 = 'sk-proj-ZYXWVUTSRQPONMLKJIHGFEDCBA987654321099';
const GATEWAY_KEY = `sk-cdx-${'a'.repeat(64)}`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fakeProvider(status: number) {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"Incorrect API key provided: sk-proj-ABCD"}}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
}

async function harness(settings: Array<[string, string]> = []) {
  const owner = memoryOwner({
    openaiApiKeys: [{ id: 1, name: 'gw', keyPrefix: 'sk-cdx-aaaa...', keyHash: sha256(GATEWAY_KEY), isActive: 1, engine: 'codex' }],
    versions: settings.map(([name, version]) => ({ name, version, updatedAt: '2026-01-01T00:00:00Z' })),
  });
  cleanups.push(() => owner.close());
  const ctx = { db: owner.db, keyring: testKeyring(), env: {} } as unknown as RouteContext;
  const upstream = createGatewayUpstream(ctx, {
    config: upstreamConfigFromEnv({ GATEWAY_UPSTREAM_PRIVATE_HOSTS: '127.0.0.1' } as never),
  });
  cleanups.push(() => upstream.close());
  const app = await buildRouteApp();
  await registerAdminProviderKeyRoutes(app, ctx, { upstream });
  await app.ready();
  cleanups.push(() => app.close());
  const published: unknown[] = [];
  vi.spyOn(wsPublisher, 'publish').mockImplementation(((type: string, payload: unknown) => {
    published.push({ type, payload });
  }) as never);
  return { ...owner, app, published };
}

describe('/admin/provider-keys', () => {
  it('stores a key write-only and lists metadata with the provider rows', async () => {
    const h = await harness();
    const created = await h.app.inject({
      method: 'POST',
      url: '/admin/provider-keys',
      payload: { provider: 'openai', label: 'Primary', key: KEY },
    });
    expect(created.statusCode, created.body).toBe(200);
    const record = created.json().data;
    expect(record).toEqual({
      id: expect.any(Number),
      provider: 'openai',
      label: 'Primary',
      key_hint: 'sk-proj-…8901',
      base_url: null,
      effective_base_url: 'https://api.openai.com/v1',
      sort_order: 0,
      state: 'active',
      verification_state: 'unverified',
      verification_reason: null,
      verification_checked_at: null,
      last_used_at: null,
      last_error_at: null,
      last_error_status: null,
      last_error_reason: null,
      created_by_admin_user_id: null,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });

    const list = await h.app.inject('/admin/provider-keys');
    expect(list.statusCode).toBe(200);
    const body = list.json().data;
    expect(body.keys).toEqual([record]);
    expect(body.providers).toEqual([
      expect.objectContaining({ provider: 'openai', label: 'OpenAI', engine: 'codex', engine_enabled: true, surface: 'openai', base_path: '/v1', source: 'emulated', default_base_url: 'https://api.openai.com/v1', counts: { total: 1, active: 1, usable: 1 } }),
      expect.objectContaining({ provider: 'anthropic', engine: 'claude', surface: 'anthropic', counts: { total: 0, active: 0, usable: 0 } }),
      expect.objectContaining({ provider: 'xai', engine: 'grok', surface: 'grok' }),
      expect.objectContaining({ provider: 'moonshot', engine: 'kimi', surface: 'kimi' }),
    ]);
    expect(h.published).toEqual([{ type: 'provider_key.changed', payload: { id: record.id, provider: 'openai', action: 'created' } }]);

    const trail = JSON.stringify([created.body, list.body, h.published, persisted(h.fake, schema.adminEvents), persisted(h.fake, schema.logs)]);
    expect(trail).not.toContain(KEY);
    expect(trail).not.toContain(sha256(KEY));
  });

  it('validates input and refuses gateway keys, duplicates and unsafe base URLs', async () => {
    const h = await harness();
    const post = (payload: Record<string, unknown>) => h.app.inject({ method: 'POST', url: '/admin/provider-keys', payload });
    expect((await post({ provider: 'gemini', label: 'x', key: KEY })).json()).toMatchObject({ code: 'invalid_request' });
    expect((await post({ provider: 'openai', label: ' ', key: KEY })).statusCode).toBe(400);
    expect((await post({ provider: 'openai', label: 'x', key: 'short' })).statusCode).toBe(400);
    const own = await post({ provider: 'openai', label: 'x', key: GATEWAY_KEY });
    expect(own.statusCode).toBe(400);
    expect(own.json().code).toBe('gateway_key_not_allowed');
    expect(own.body).not.toContain(GATEWAY_KEY);
    for (const base_url of ['http://api.example.com/v1', 'https://user:pw@api.example.com', 'https://10.0.0.1/v1', 'https://api.example.com/v1?x=1']) {
      const reply = await post({ provider: 'openai', label: 'x', key: KEY, base_url });
      expect(reply.statusCode, base_url).toBe(400);
      expect(reply.json().code).toBe('invalid_base_url');
    }
    expect((await post({ provider: 'openai', label: 'x', key: KEY })).statusCode).toBe(200);
    const duplicate = await post({ provider: 'openai', label: 'again', key: KEY });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe('provider_key_duplicate');
    expect((await h.app.inject({ method: 'POST', url: '/admin/provider-keys', payload: [] })).statusCode).toBe(400);
  });

  it('updates, pauses, verifies, reorders and deletes', async () => {
    const h = await harness();
    const provider = await fakeProvider(200);
    const create = async (key: string) =>
      (await h.app.inject({ method: 'POST', url: '/admin/provider-keys', payload: { provider: 'openai', label: 'k', key, base_url: provider.base } })).json().data;
    const a = await create(KEY);
    const b = await create(KEY_2);
    expect(b.sort_order).toBe(1);

    const verified = await h.app.inject({ method: 'POST', url: `/admin/provider-keys/${a.id}/verify` });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().data).toMatchObject({ verification_state: 'valid', verification_reason: 'ok (HTTP 200)' });
    expect(provider.seen[0]?.authorization).toBe(`Bearer ${KEY}`);

    const patched = await h.app.inject({ method: 'PATCH', url: `/admin/provider-keys/${a.id}`, payload: { label: 'renamed', base_url: null } });
    expect(patched.json().data).toMatchObject({ label: 'renamed', base_url: null, effective_base_url: 'https://api.openai.com/v1', verification_state: 'unverified' });
    expect((await h.app.inject({ method: 'PATCH', url: `/admin/provider-keys/${a.id}`, payload: {} })).statusCode).toBe(400);
    const missing = await h.app.inject({ method: 'PATCH', url: '/admin/provider-keys/999', payload: { label: 'x' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('provider_key_not_found');

    const paused = await h.app.inject({ method: 'POST', url: `/admin/provider-keys/${b.id}/state`, payload: { state: 'paused' } });
    expect(paused.json().data.state).toBe('paused');
    expect((await h.app.inject({ method: 'POST', url: `/admin/provider-keys/${b.id}/state`, payload: { state: 'off' } })).statusCode).toBe(400);

    const reordered = await h.app.inject({ method: 'POST', url: '/admin/provider-keys/order', payload: { provider: 'openai', ids: [b.id, a.id] } });
    expect(reordered.json().data.keys.map((k: { id: number; sort_order: number }) => [k.id, k.sort_order])).toEqual([[b.id, 0], [a.id, 1]]);
    const mismatch = await h.app.inject({ method: 'POST', url: '/admin/provider-keys/order', payload: { provider: 'openai', ids: [a.id] } });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().code).toBe('provider_key_order_mismatch');

    const deleted = await h.app.inject({ method: 'DELETE', url: `/admin/provider-keys/${b.id}` });
    expect(deleted.json().data).toMatchObject({ id: b.id });
    expect((await h.app.inject({ method: 'DELETE', url: `/admin/provider-keys/${b.id}` })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'POST', url: '/admin/provider-keys/abc/verify' })).statusCode).toBe(400);
    expect(h.published.map((event) => (event as { payload: { action: string } }).payload.action)).toEqual([
      'created',
      'created',
      'verified',
      'updated',
      'state',
      'reordered',
      'deleted',
    ]);
  });

  it('records an invalid key without echoing the provider body', async () => {
    const h = await harness();
    const provider = await fakeProvider(401);
    const created = (
      await h.app.inject({ method: 'POST', url: '/admin/provider-keys', payload: { provider: 'xai', label: 'x', key: 'xai-ABCDEFGHIJKLMNOPQRSTUVWXYZ', base_url: provider.base } })
    ).json().data;
    const verified = await h.app.inject({ method: 'POST', url: `/admin/provider-keys/${created.id}/verify` });
    expect(verified.json().data).toMatchObject({ verification_state: 'invalid', verification_reason: 'unauthorized (HTTP 401)' });
    expect(verified.body).not.toContain('Incorrect API key');
    const list = (await h.app.inject('/admin/provider-keys')).json().data;
    expect(list.providers.find((p: { provider: string }) => p.provider === 'xai').counts).toEqual({ total: 1, active: 1, usable: 0 });
  });

  it('switches a surface source only with a usable key and an enabled engine', async () => {
    const h = await harness([['claude_engine_disabled', '1']]);
    const set = (surface: string, source: unknown) =>
      h.app.inject({ method: 'POST', url: `/admin/api/surfaces/${surface}/source`, payload: { source } });

    const none = await set('openai', 'upstream');
    expect(none.statusCode).toBe(409);
    expect(none.json().code).toBe('provider_key_missing');
    await h.app.inject({ method: 'POST', url: '/admin/provider-keys', payload: { provider: 'openai', label: 'k', key: KEY } });
    const upstream = await set('openai', 'upstream');
    expect(upstream.statusCode, upstream.body).toBe(200);
    expect(upstream.json().data).toMatchObject({ surface: 'openai', source: 'upstream', provider: 'openai', provider_keys: { active: 1, usable: 1 } });
    expect(h.state.snapshot().setting('api_surface_source_openai')).toBe('upstream');
    expect((await set('openai', 'emulated')).json().data.source).toBe('emulated');

    const anthropic = (
      await h.app.inject({ method: 'POST', url: '/admin/provider-keys', payload: { provider: 'anthropic', label: 'k', key: 'sk-ant-api03-ABCDEFGHIJKLMNOP' } })
    ).json().data;
    const off = await set('anthropic', 'upstream');
    expect(off.statusCode).toBe(409);
    expect(off.json()).toMatchObject({ code: 'engine_disabled', engine: 'claude' });
    // A suspended engine makes no provider call, not even a verification.
    const verify = await h.app.inject({ method: 'POST', url: `/admin/provider-keys/${anthropic.id}/verify` });
    expect(verify.statusCode).toBe(409);
    expect(verify.json()).toMatchObject({ code: 'engine_disabled', engine: 'claude' });
    expect((await h.app.inject({ method: 'POST', url: '/admin/provider-keys/999/verify' })).statusCode).toBe(404);
    expect((await set('anthropic', 'emulated')).statusCode).toBe(200);

    expect((await set('claude', 'upstream')).statusCode).toBe(400);
    expect((await set('openai', 'proxy')).statusCode).toBe(400);
    const actions = persisted(h.fake, schema.logs).map((row) => [row.action, JSON.parse(String(row.details))]);
    expect(actions).toEqual([
      ['admin.api.surface_source', { surface: 'openai', source: 'upstream', previous: 'emulated' }],
      ['admin.api.surface_source', { surface: 'openai', source: 'emulated', previous: 'upstream' }],
    ]);
  });
});
