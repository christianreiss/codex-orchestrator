import { describe, it, expect } from 'vitest';
import { buildAppWithDb } from '../helpers/build-app.js';
import type { TestDb } from '../helpers/test-db.js';

/**
 * Smoke test for `buildAppWithDb` — exercises the full plugin stack without
 * actually hitting the database. We pass a stub `db` so the integration is
 * purely about plugin registration order; routes can mount on top and tests
 * by other Phase 2 worktrees will exercise the real db paths.
 */

// The minimal app stack doesn't actually issue queries, but it does
// `app.decorate('db', db)` and the rate-limit plugin reads it via the
// factory. We give it a placeholder object that satisfies the decorator
// API without exposing any query surface.
const stubDb = {} as unknown as TestDb;

describe('buildAppWithDb', () => {
  it('registers plugins in production-equivalent order (minimal mode)', async () => {
    const app = await buildAppWithDb(stubDb, { minimal: true });
    app.get('/probe', async () => ({ probed: true }));
    const r = await app.inject({ method: 'GET', url: '/probe' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body).toMatchObject({ status: 'ok', probed: true });
    await app.close();
  });

  it('decorates db/env/keyring/rateLimiter on the instance', async () => {
    const app = await buildAppWithDb(stubDb, { minimal: true });
    expect(app.db).toBeDefined();
    expect(app.env).toBeDefined();
    expect(app.keyring).toBeDefined();
    expect(app.rateLimiter).toBeDefined();
    await app.close();
  });

  it('renders 404 through the standard envelope when no route matches', async () => {
    const app = await buildAppWithDb(stubDb, { minimal: true });
    const r = await app.inject({ method: 'GET', url: '/nope' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.payload)).toMatchObject({ status: 'error', code: 'not_found' });
    await app.close();
  });
});
