/**
 * Smoke tests for the admin-content route registration. We build a thin
 * Fastify app, register the routes against a stubbed Drizzle db, and
 * exercise each endpoint via `app.inject()` to verify:
 *
 *   - the route exists at the expected URL + method
 *   - it is gated by `requireAdmin` (401 without an admin context)
 *   - successful responses are wrapped by the envelope plugin
 *
 * The stubbed db only needs to honor the calls the service classes make on
 * the happy paths exercised here. We do not test full DB semantics; the
 * service-level unit tests do that.
 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it, vi } from 'vitest';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { registerAdminContentRoutes } from '../../../src/routes/admin-content/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { ApiError } from '../../../src/http/errors.js';

interface ChainShape {
  select?: unknown;
  insert?: unknown;
  update?: unknown;
  delete?: unknown;
}

/**
 * Build a Drizzle stub. Every builder method returns a thenable that
 * resolves to []. Test cases override via `partial`.
 */
function emptyResultBuilder(rows: unknown[] = []) {
  const chain: Record<string, unknown> = {
    where: () => chain,
    for: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    innerJoin: () => chain,
    then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(resolve(rows)),
  };
  return chain;
}

function makeDbStub(partial: Partial<ChainShape> = {}): unknown {
  const stub = {
    select: partial.select ?? (() => ({
      from: () => emptyResultBuilder([]),
    })),
    insert: partial.insert ?? (() => ({
      values: () => ({
        $returningId: () => Promise.resolve([{ id: 1 }]),
        then: (r: (v: void) => unknown) => Promise.resolve(r(undefined as unknown as void)),
      }),
    })),
    update: partial.update ?? (() => ({
      set: () => ({
        where: () => Promise.resolve(undefined),
      }),
    })),
    delete: partial.delete ?? (() => ({
      where: () => Promise.resolve(undefined),
    })),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(stub),
  };
  return stub;
}

async function buildApp(overrides: Partial<ChainShape> = {}, options: { withAdmin?: boolean } = {}) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);

  // Decorate requireAdmin so route handlers can attach it as preHandler.
  app.decorate('requireAdmin', async (req: import('fastify').FastifyRequest) => {
    if (options.withAdmin) {
      req.admin = {
        // Minimal shape sufficient for handlers that only need presence.
        user: { id: 1, active: 1 } as never,
        session: { id: 1 } as never,
      };
      return;
    }
    throw new ApiError('Admin session required', { status: 401, code: 'admin_required', type: 'authentication_error' });
  });
  app.decorate('resolveAdmin', vi.fn());

  const ctx = {
    db: makeDbStub(overrides) as unknown,
    env: {} as unknown,
    keyring: {} as unknown,
  } as unknown as RouteContext;

  await registerAdminContentRoutes(app, ctx);
  return app;
}

describe('admin-content routes registration', () => {
  it('gates GET /admin/config behind requireAdmin', async () => {
    const app = await buildApp({}, { withAdmin: false });
    const r = await app.inject({ method: 'GET', url: '/admin/config' });
    expect(r.statusCode).toBe(401);
    expect(JSON.parse(r.payload)).toMatchObject({ status: 'error', code: 'admin_required' });
    await app.close();
  });

  it('returns "missing" envelope for GET /admin/config when no doc exists', async () => {
    const app = await buildApp({}, { withAdmin: true });
    const r = await app.inject({ method: 'GET', url: '/admin/config' });
    expect(r.statusCode).toBe(200);
    // The standard formatter spreads object data into root. The handler
    // returns { status: 'missing' }, which wins over the formatter's 'ok'.
    expect(JSON.parse(r.payload)).toMatchObject({ status: 'missing' });
    await app.close();
  });

  it('renders TOML from POST /admin/config/render', async () => {
    const app = await buildApp({}, { withAdmin: true });
    const r = await app.inject({
      method: 'POST',
      url: '/admin/config/render',
      payload: { settings: { model: 'gpt-6-astra', model_reasoning_effort: 'high' } },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.status).toBe('ok');
    expect(body.content).toContain('model = "gpt-6-astra"');
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    await app.close();
  });

  it('returns a "missing" agents state when no documents exist', async () => {
    const app = await buildApp({}, { withAdmin: true });
    const r = await app.inject({ method: 'GET', url: '/admin/agents' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    // The agents handler returns { status: 'missing', engine: 'codex', ... };
    // the standard formatter spreads it, so the top-level status reflects
    // the handler payload.
    expect(body.status).toBe('missing');
    expect(body.engine).toBe('codex');
    expect(body.versions).toEqual([]);
    await app.close();
  });

  it('gates rendered AGENTS.md preview behind requireAdmin', async () => {
    const app = await buildApp({}, { withAdmin: false });
    const r = await app.inject({ method: 'GET', url: '/admin/agents/render?host_id=1' });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('returns 401 on /admin/skills without admin', async () => {
    const app = await buildApp({}, { withAdmin: false });
    const r = await app.inject({ method: 'GET', url: '/admin/skills' });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('returns the skills list (managed only, no rows) when admin', async () => {
    const app = await buildApp({}, { withAdmin: true });
    const r = await app.inject({ method: 'GET', url: '/admin/skills' });
    expect(r.statusCode).toBe(200);
    // No `skills` rows in the stub, but the unconditional code-derived Skills
    // are still listed so the admin surface shows what hosts actually receive.
    expect(JSON.parse(r.payload)).toMatchObject({
      status: 'ok',
      skills: [
        { slug: 'afk', managed: true },
        { slug: 'conference', managed: true },
        { slug: 'skill-manager', managed: true },
      ],
    });
    await app.close();
  });

  it('lists projects (empty) when admin', async () => {
    const app = await buildApp({}, { withAdmin: true });
    const r = await app.inject({ method: 'GET', url: '/admin/projects' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({ status: 'ok', projects: [] });
    await app.close();
  });

  it('returns the projects state with default enabled=false', async () => {
    const app = await buildApp({}, { withAdmin: true });
    const r = await app.inject({ method: 'GET', url: '/admin/projects/state' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.status).toBe('ok');
    expect(body.enabled).toBe(false);
    expect(body.managed_skill).toMatchObject({ slug: 'coco' });
    await app.close();
  });

  it('rejects projects/state when enabled flag is missing', async () => {
    const app = await buildApp({}, { withAdmin: true });
    const r = await app.inject({
      method: 'POST',
      url: '/admin/projects/state',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(422);
    expect(JSON.parse(r.payload)).toMatchObject({ status: 'error', code: 'validation_failed' });
    await app.close();
  });

  it('returns 503 for /admin/skills/assist (runner unavailable)', async () => {
    const app = await buildApp({}, { withAdmin: true });
    const r = await app.inject({
      method: 'POST',
      url: '/admin/skills/assist',
      payload: { messages: [{ role: 'user', content: 'help' }], slug: 'foo' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(503);
    const body = JSON.parse(r.payload);
    expect(body).toMatchObject({ status: 'error', code: 'runner_unavailable' });
    expect(body.next_step).toBeTruthy();
    await app.close();
  });

  it('returns 503 for /admin/projects/:slug/assist (runner unavailable)', async () => {
    const app = await buildApp({}, { withAdmin: true });
    const r = await app.inject({
      method: 'POST',
      url: '/admin/projects/myproj/assist',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.payload)).toMatchObject({ status: 'error', code: 'runner_unavailable' });
    await app.close();
  });

  it('returns 422 when projects/:slug/notes is missing header', async () => {
    // The handler resolves the project first; we make findBySlug return a row.
    const projectRow = {
      id: 1,
      slug: 'myproj',
      aboutJson: null,
      rosterMarkdown: '',
      latestEventSeq: 0,
      createdAt: 'now',
      updatedAt: 'now',
      archivedAt: null,
    };
    const dbStub = makeDbStub({
      select: () => ({
        from: () => emptyResultBuilder([projectRow]),
      }),
    });
    const app = Fastify({ logger: false });
    await app.register(cookie);
    await app.register(requestIdPlugin);
    await app.register(envelopePlugin);
    app.decorate('requireAdmin', async (req: import('fastify').FastifyRequest) => {
      req.admin = { user: { id: 1 } as never, session: { id: 1 } as never };
    });
    app.decorate('resolveAdmin', vi.fn());
    await registerAdminContentRoutes(app, { db: dbStub as unknown, env: {} as unknown, keyring: {} as unknown } as unknown as RouteContext);

    const r = await app.inject({
      method: 'POST',
      url: '/admin/projects/myproj/notes',
      payload: { body: 'no header' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(422);
    expect(JSON.parse(r.payload)).toMatchObject({ status: 'error', code: 'validation_failed' });
    await app.close();
  });

  it('rejects DELETE /admin/skills/managed-skill if reserved', async () => {
    const app = await buildApp({}, { withAdmin: true });
    const r = await app.inject({ method: 'DELETE', url: '/admin/skills/codex-project-coordination' });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.payload)).toMatchObject({ status: 'error', code: 'managed_skill' });
    await app.close();
  });

  it('returns 404 when DELETE /admin/skills/:slug misses', async () => {
    const app = await buildApp({}, { withAdmin: true });
    const r = await app.inject({ method: 'DELETE', url: '/admin/skills/no-such-skill' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.payload)).toMatchObject({ status: 'error', code: 'skill_not_found' });
    await app.close();
  });
});
