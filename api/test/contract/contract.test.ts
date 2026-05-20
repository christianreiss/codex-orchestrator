import { describe, it } from 'vitest';
import { discoverFixtures, FIXTURE_ROOT, fixtureLabel, loadFixture, replayFixture } from './helpers/replay.js';
import { buildTestApp } from '../helpers/build-app.js';
import { getTestDb } from '../helpers/test-db.js';

/**
 * Contract suite — walks every fixture under `test/contract/fixtures/`,
 * replays it against the Node server, and asserts the response shape matches
 * the expected envelope and key set. Fixtures are hand-authored and checked in
 * as the contract evolves; there is no automated recorder.
 */

const fixtures = discoverFixtures(FIXTURE_ROOT);

describe('contract suite', () => {
  if (fixtures.length === 0) {
    it.skip('no fixtures checked in yet', () => {
      /* intentionally empty */
    });
    return;
  }

  for (const fixturePath of fixtures) {
    const label = fixtureLabel(fixturePath);
    it(label, async (ctx) => {
      const fixture = loadFixture(fixturePath);
      // For now, until Phase 2 routes land + a test DB is configured, we use
      // the lightweight envelope app. Once routes exist callers can switch
      // to buildAppWithDb(db) here and exercise the full plugin stack.
      const dbHandle = await getTestDb();
      const app = await buildTestApp();
      try {
        if (!dbHandle) {
          // Without DB, only envelope-level fixtures are meaningful. Skip the
          // rest with a clear message — they need DB-backed routes.
          if (fixture.request.url !== '/healthz' && fixture.request.url !== '/healthz/') {
            ctx.skip();
            return;
          }
        }
        await replayFixture(app, fixture);
      } finally {
        await app.close();
      }
    });
  }
});
