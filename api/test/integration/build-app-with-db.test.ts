import { describe, it, expect } from 'vitest';
import { buildAppWithDb } from '../helpers/build-app.js';
import type { TestDb } from '../helpers/test-db.js';

/**
 * Smoke test for `buildAppWithDb` — exercises the full plugin stack without
 * actually hitting the database. We pass a stub `db` so the integration is
 * purely about plugin registration order; routes can mount on top and tests
 * by other Phase 2 worktrees will exercise the real db paths.
 */

// The minimal app stack doesn't actually issue queries, but it does decorate
// the Fastify instance with the database handle. This placeholder satisfies
// that contract without exposing any query surface.
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

  it('decorates db/env/keyring on the instance', async () => {
    const app = await buildAppWithDb(stubDb, { minimal: true });
    expect(app.db).toBeDefined();
    expect(app.env).toBeDefined();
    expect(app.keyring).toBeDefined();
    await app.close();
  });

  it('renders 404 through the standard envelope when no route matches', async () => {
    const app = await buildAppWithDb(stubDb, { minimal: true });
    const r = await app.inject({ method: 'GET', url: '/nope' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.payload)).toMatchObject({ status: 'error', code: 'not_found' });
    await app.close();
  });

  /**
   * This helper is what DB-backed route suites mount real route modules on, so
   * a plugin missing from it is not a gap in a test fixture — it is a gap in
   * what those suites are able to observe. The capability layer was added to
   * `src/server.ts` without being added here, and the suites went on asserting
   * against routes that production gates and the harness did not. The two
   * checks below are the structural one and the live one: that the decorators
   * exist, and that the `onRoute` hook behind them is actually running.
   */
  describe('carries the capability layer, not just the session check', () => {
    it('decorates the capability API onto the instance', async () => {
      const app = await buildAppWithDb(stubDb);
      expect(app.requireCapability).toBeTypeOf('function');
      expect(app.assertCapability).toBeTypeOf('function');
      await app.close();
    });

    it('refuses to serve a governed route that carries no capability', async () => {
      const app = await buildAppWithDb(stubDb);
      app.get('/admin/invented-endpoint', async () => ({ reached: 'handler' }));
      await expect(app.ready()).rejects.toThrow(
        /no entry in src\/security\/route-capabilities\.ts/,
      );
    });

    it('leaves a minimal app alone, having no session to authorize', async () => {
      const app = await buildAppWithDb(stubDb, { minimal: true });
      expect(app.hasDecorator('requireCapability')).toBe(false);
      await app.close();
    });
  });
});
