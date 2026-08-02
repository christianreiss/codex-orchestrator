import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { UnauthorizedError } from '../../../src/http/errors.js';
import { registerAdminDoctorRoutes } from '../../../src/routes/admin/doctor/index.js';
import type { AdminDoctorOverrides } from '../../../src/routes/admin/doctor/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { createMockDb } from '../../helpers/in-memory-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import type { OpenaiApiKey } from '../../../src/db/schema.js';
import type { Engine } from '../../../src/util/engine.js';

/**
 * Mirrors the `buildApp()` shape `test/integration/anthropic-v1/admin-keys.test.ts`
 * uses to smoke-test route protection: cookie + request-id + envelope, a
 * hand-decorated `requireAdmin`/`resolveAdmin` pair (no real session/DB auth
 * flow — that's covered by `admin-route-auth-guard.test.ts` and the
 * auth-admin plugin's own tests), plus a no-op `rateLimiter` decoration since
 * the real one needs a DB-backed bucket table the in-memory mock can't serve.
 */
async function buildApp(
  opts: { authed: boolean; overrides?: AdminDoctorOverrides } = { authed: true },
): Promise<{ app: FastifyInstance; mock: ReturnType<typeof createMockDb> }> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);

  if (opts.authed) {
    app.decorate('requireAdmin', async () => {});
  } else {
    app.decorate('requireAdmin', async () => {
      throw new UnauthorizedError('Admin session required', 'admin_required');
    });
  }
  app.decorate('resolveAdmin', async () => null);
  app.decorate('rateLimiter', {
    hit: async () => ({ ok: true, resetAt: new Date().toISOString(), count: 1 }),
  });

  const mock = createMockDb();
  const ctx: RouteContext = { db: mock.db, env: loadTestEnv(), keyring: testKeyring() };
  await registerAdminDoctorRoutes(app, ctx, opts.overrides ?? {});
  return { app, mock };
}

describe('GET /admin/doctor', () => {
  it('requires an admin session', async () => {
    const { app } = await buildApp({ authed: false });
    const r = await app.inject({ method: 'GET', url: '/admin/doctor' });
    expect([401, 403]).toContain(r.statusCode);
    const body = JSON.parse(r.payload);
    expect(body.status).toBe('error');
    await app.close();
  });

  it('returns 200 with the documented shape for an authenticated admin request', async () => {
    const { app } = await buildApp({ authed: true });
    const r = await app.inject({ method: 'GET', url: '/admin/doctor' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload).data as {
      generated_at: string;
      rows: Array<{ id: string; label: string; status: string; detail: string; hint: string | null; owner_route: string | null }>;
      hosts: { total: number; synced: number };
      canonical_auth: { codex: boolean; claude: boolean };
    };

    expect(typeof body.generated_at).toBe('string');
    expect(Number.isNaN(Date.parse(body.generated_at))).toBe(false);

    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
    for (const row of body.rows) {
      expect(typeof row.id).toBe('string');
      expect(typeof row.label).toBe('string');
      expect(['ok', 'warn', 'fail']).toContain(row.status);
      expect(typeof row.detail).toBe('string');
      expect(row.hint === null || typeof row.hint === 'string').toBe(true);
      expect(row.owner_route === null || typeof row.owner_route === 'string').toBe(true);
    }

    const rowIds = body.rows.map((row) => row.id);
    // The rows the plan requires beyond the wrapped SetupStatusService checks.
    for (const id of [
      'keyring',
      'kill_switch_master',
      'kill_switch_openai',
      'kill_switch_claude',
      'keys_openai',
      'keys_claude',
    ]) {
      expect(rowIds).toContain(id);
    }
    const apiKeysRows = body.rows.filter((row) => row.owner_route === '/api-keys');
    expect(apiKeysRows.map((row) => row.id).sort()).toEqual(
      ['keys_claude', 'keys_openai', 'kill_switch_claude', 'kill_switch_master', 'kill_switch_openai'].sort(),
    );

    expect(typeof body.hosts.total).toBe('number');
    expect(typeof body.hosts.synced).toBe('number');
    expect(typeof body.canonical_auth.codex).toBe('boolean');
    expect(typeof body.canonical_auth.claude).toBe('boolean');

    await app.close();
  });
});

describe('POST /admin/doctor/test-key', () => {
  it('requires an admin session', async () => {
    const { app } = await buildApp({ authed: false });
    const r = await app.inject({
      method: 'POST',
      url: '/admin/doctor/test-key',
      payload: { engine: 'openai', key: 'sk-cdx-anything' },
    });
    expect([401, 403]).toContain(r.statusCode);
    await app.close();
  });

  it('rejects a request missing key with 400', async () => {
    const { app } = await buildApp({ authed: true });
    const r = await app.inject({
      method: 'POST',
      url: '/admin/doctor/test-key',
      payload: { engine: 'openai' },
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a request missing engine with 400', async () => {
    const { app } = await buildApp({ authed: true });
    const r = await app.inject({
      method: 'POST',
      url: '/admin/doctor/test-key',
      payload: { key: 'sk-cdx-anything' },
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an engine value outside openai/claude with 400', async () => {
    const { app } = await buildApp({ authed: true });
    const r = await app.inject({
      method: 'POST',
      url: '/admin/doctor/test-key',
      payload: { engine: 'codex', key: 'sk-cdx-anything' },
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  /**
   * The hard security constraint from the plan: this endpoint accepts only a
   * pasted key and must never resolve a stored key by id. `KeyLookup` (the
   * type the route depends on) doesn't even expose a `findById`-shaped
   * method, so nothing here *could* look one up — this test proves the
   * literal pasted string is what determines the outcome, not any other
   * field in the body.
   */
  it('uses only the literal pasted key, never an id in the body', async () => {
    const calls: Array<{ key: string; engine: string }> = [];
    const fakeKeys: AdminDoctorOverrides['keys'] = {
      async findActiveByBearer(key: string, engine: Engine = 'codex') {
        calls.push({ key, engine });
        if (key !== 'sk-cdx-the-real-pasted-key') return null;
        return {
          id: 999999, // deliberately NOT the `id`/`key_id` sent in the body below
          rateLimitRpm: 60,
        } as unknown as OpenaiApiKey;
      },
      async touch() {
        /* no-op */
      },
      async listByEngine() {
        return [];
      },
    };

    const { app } = await buildApp({ authed: true, overrides: { keys: fakeKeys } });

    // A malicious/confused client sends both a pasted key AND an id pointing
    // at some other stored key. The id must be silently dropped.
    const r = await app.inject({
      method: 'POST',
      url: '/admin/doctor/test-key',
      payload: { engine: 'openai', key: 'sk-cdx-the-real-pasted-key', id: 1, key_id: 1, keyId: 1 },
    });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload).data as { ok: boolean; model_count?: number };
    expect(body.ok).toBe(true);
    // findActiveByBearer was called exactly once, with the pasted string —
    // never with the id fields, and never anything id-shaped.
    expect(calls).toEqual([{ key: 'sk-cdx-the-real-pasted-key', engine: 'codex' }]);
    await app.close();
  });

  it('reports failure for a bogus pasted key even while a "real" key exists in the lookup', async () => {
    const fakeKeys: AdminDoctorOverrides['keys'] = {
      async findActiveByBearer(key: string) {
        // Only the exact real key ever matches — proves there is no
        // fallback to "any active key" / "the first configured key".
        if (key !== 'sk-ant-the-real-pasted-key') return null;
        return { id: 1, rateLimitRpm: 60 } as unknown as OpenaiApiKey;
      },
      async touch() {},
      async listByEngine() {
        return [];
      },
    };
    const { app } = await buildApp({ authed: true, overrides: { keys: fakeKeys } });

    const r = await app.inject({
      method: 'POST',
      url: '/admin/doctor/test-key',
      payload: { engine: 'claude', key: 'sk-ant-totally-bogus' },
    });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload).data as { ok: boolean; status: number | null; error?: string };
    expect(body.ok).toBe(false);
    expect(body.status).toBe(401);
    await app.close();
  });

  it('increments use_count for a real key on a successful pasted-key test (documented side effect)', async () => {
    const { OpenAiKeyService } = await import('../../../src/services/openai-keys.js');
    const { sha256 } = await import('../../../src/security/hash.js');

    const app = Fastify({ logger: false });
    await app.register(cookie);
    await app.register(requestIdPlugin);
    await app.register(envelopePlugin);
    app.decorate('requireAdmin', async () => {});
    app.decorate('resolveAdmin', async () => null);
    app.decorate('rateLimiter', {
      hit: async () => ({ ok: true, resetAt: new Date().toISOString(), count: 1 }),
    });

    const mock = createMockDb();
    mock.insertRow('openai_api_keys', {
      id: 42,
      name: 'ci-runner',
      key_prefix: 'sk-cdx-real...',
      key_hash: sha256('sk-cdx-the-real-pasted-key'),
      key_enc: 'sbox:v1:irrelevant-for-this-path',
      admin_user_id: null,
      rate_limit_rpm: 60,
      is_active: 1,
      use_count: 0,
      last_used_at: null,
      expires_at: null,
      engine: 'codex',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    const ctx: RouteContext = { db: mock.db, env: loadTestEnv(), keyring: testKeyring() };
    const keys = new OpenAiKeyService({ db: mock.db, keyring: ctx.keyring });
    await registerAdminDoctorRoutes(app, ctx, { keys });

    const r = await app.inject({
      method: 'POST',
      url: '/admin/doctor/test-key',
      payload: { engine: 'openai', key: 'sk-cdx-the-real-pasted-key' },
    });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload).data as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mock.rows('openai_api_keys')[0]?.use_count).toBe(1);
    await app.close();
  });
});

describe('GET /admin/doctor degradation', () => {
  it('reports a fail row instead of 500ing when the status service throws', async () => {
    const app = Fastify({ logger: false });
    await app.register(cookie);
    await app.register(requestIdPlugin);
    await app.register(envelopePlugin);
    app.decorate('requireAdmin', async () => {});
    app.decorate('resolveAdmin', async () => null);
    app.decorate('rateLimiter', {
      hit: async () => ({ ok: true, resetAt: new Date().toISOString(), count: 1 }),
    });

    // Break exactly one of SetupStatusService's several parallel queries
    // (the un-guarded `signerCheck`) rather than every query: `status()` runs
    // its checks via `Promise.all`, and rejecting more than one member of
    // that array produces "unhandled rejection" noise for every reject past
    // the first — a pre-existing property of Promise.all with concurrent
    // rejections, not something this route can fix. One broken query is
    // enough to prove the route degrades instead of 500ing.
    const { wrapperSigningKeys } = await import('../../../src/db/schema.js');
    const mock = createMockDb();
    const realSelect = mock.db.select.bind(mock.db);
    const dbWithBrokenSigner = {
      ...mock.db,
      select: (...args: Parameters<typeof realSelect>) => {
        const builder = realSelect(...args) as { from: (table: unknown) => unknown };
        const realFrom = builder.from.bind(builder);
        builder.from = (table: unknown) => {
          if (table === wrapperSigningKeys) throw new Error('wrapper_signing_keys query failed');
          return realFrom(table);
        };
        return builder;
      },
    } as unknown as RouteContext['db'];
    const ctx: RouteContext = { db: dbWithBrokenSigner, env: loadTestEnv(), keyring: testKeyring() };
    await registerAdminDoctorRoutes(app, ctx);

    const r = await app.inject({ method: 'GET', url: '/admin/doctor' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload).data as {
      rows: Array<{ id: string; status: string }>;
      hosts: { total: number; synced: number };
      canonical_auth: { codex: boolean; claude: boolean };
    };
    expect(body.rows.some((row) => row.status === 'fail')).toBe(true);
    // The keyring row needs no DB access, so it still shows up even during
    // an outage of everything else.
    expect(body.rows.some((row) => row.id === 'keyring')).toBe(true);
    expect(body.hosts).toEqual({ total: 0, synced: 0 });
    expect(body.canonical_auth).toEqual({ codex: false, claude: false });
    await app.close();
  });
});

/**
 * Static backstop for the same constraint: even if a future edit widens
 * `KeyLookup` or swaps the override away, the route source itself must never
 * read an id out of the request and must never touch the decrypt path (the
 * only place a stored key's plaintext could be recovered).
 */
describe('admin/doctor/index.ts source constraints', () => {
  it('never reads req.params or decrypts a stored key', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/routes/admin/doctor/index.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/req\.params/);
    // `decrypt`/`encrypt` are used only for the keyring canary round-trip
    // (a throwaway string, never a stored row) — the actual back door would
    // be reading a stored ciphertext column and decrypting it, or resolving
    // a key by database id instead of by the pasted string.
    expect(source).not.toMatch(/\.keyEnc\b/);
    expect(source).not.toMatch(/\bdecryptOrNull\(/);
    expect(source).not.toMatch(/\bfindById\(/);
  });
});
