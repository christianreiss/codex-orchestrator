import { mutateOwnerState } from '../../../src/control-plane/state/runtime.js';
import { stageUpdate } from '../../../src/control-plane/state/rows.js';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { createOwnedControlPlane } from '../../../src/control-plane/bootstrap.js';
import { runBootMigrations } from '../../../src/ops/boot-migrations.js';
import { FeedbackService } from '../../../src/services/feedback.js';
import {
  MattPocockSkillsService,
  MATTPOCOCK_STATE_KEY,
  MATTPOCOCK_SOURCE_TYPE,
} from '../../../src/services/mattpocock-skills.js';
import {
  startRolloutOnPublish,
  haltRollout,
  loadWrapperRollout,
  parseRolloutStages,
  WRAPPER_ROLLOUT_KEY,
} from '../../../src/services/wrapper-rollout.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { installSqlBudget } from '../../helpers/sql-budget.js';
import { fixture } from '../../helpers/mattpocock-upstream.js';

const config = readDbConfig();
describe.skipIf(!config)('auxiliary owner commands on real MySQL', () => {
  it(
    'commits feedback claims, skill snapshots and rollout transitions and reads current metadata without SQL',
    { timeout: 90_000 },
    async () => {
      const pool = mysql.createPool({ ...config!, connectionLimit: 3 });
      const db = drizzle(pool, { schema, mode: 'default' });
      const budget = installSqlBudget(pool);
      const env = { ...loadTestEnv(), DB_DATABASE: String(config!.database) };
      const keys = [MATTPOCOCK_STATE_KEY, WRAPPER_ROLLOUT_KEY];
      const saved = await db.select().from(schema.versions).where(inArray(schema.versions.name, keys));
      const errors: unknown[] = [];
      const feedbackIds: string[] = [];
      let ownsSourceRows = false;
      let owner: Awaited<ReturnType<typeof createOwnedControlPlane>> | undefined;
      try {
        expect(
          await db
            .select({ id: schema.skills.id })
            .from(schema.skills)
            .where(eq(schema.skills.sourceType, MATTPOCOCK_SOURCE_TYPE)),
        ).toEqual([]);
        ownsSourceRows = true;
        await db.delete(schema.versions).where(inArray(schema.versions.name, keys));
        await runBootMigrations(env, pool);
        owner = await createOwnedControlPlane({
          pool,
          handle: db,
          env,
          keyring: testKeyring(),
          error: (error) => errors.push(error),
        });
        const feedback = new FeedbackService(db, testKeyring());
        const actor = { host_id: null, engine: null, admin_user_id: 989898 };
        const input = {
          client_request_id: randomUUID(),
          type: 'bug',
          title: 'Owner transaction integration',
          description: 'Atomic claim lifecycle integration fixture',
        };
        const submitted = await feedback.submit(input, actor);
        feedbackIds.push(submitted.feedback.id);
        expect((await feedback.submit(input, actor)).replayed).toBe(true);
        const request = { id: submitted.feedback.id, client_request_id: randomUUID() };
        const claimed = await feedback.claim(request, actor);
        expect(claimed.feedback.status).toBe('in_progress');
        expect((await feedback.claim(request, actor)).claim_token).toBe(claimed.claim_token);
        await feedback.claim({ id: request.id, action: 'release', claim_token: claimed.claim_token }, actor);
        expect(owner.runtime.state.snapshot().table('feedbackItems').get(request.id)?.status).toBe('open');
        const open = owner.runtime.state.snapshot().table('feedbackItems').get(request.id)!;
        const closed = await feedback.update(
          {
            id: request.id,
            expected_version: open.version,
            status: 'dismissed',
            reason: 'Historical fixture',
          },
          actor,
        );
        if (owner.runtime.state.snapshot().table('feedbackPipeline').has(request.id)) {
          expect(owner.runtime.state.snapshot().table('feedbackItems').has(request.id)).toBe(true);
          await mutateOwnerState(owner.runtime, {
            kind: 'fixture.publication.completed',
            payload: { id: request.id },
            prepare(context) {
              stageUpdate(context, 'feedbackPipeline', request.id, {
                nextAttemptAt: null,
                leaseToken: null,
                leaseExpiresAt: null,
                deliveryState: 'sent',
              });
              return null;
            },
          });
        }
        expect(owner.runtime.state.snapshot().table('feedbackItems').has(request.id)).toBe(false);
        expect((await feedback.get(request.id, actor)).feedback.status).toBe('dismissed');
        expect((await feedback.submit(input, actor)).replayed).toBe(true);
        await feedback.update(
          { id: request.id, expected_version: closed.feedback.version, status: 'open' },
          actor,
        );
        expect(owner.runtime.state.snapshot().table('feedbackItems').get(request.id)?.status).toBe('open');
        const upstream = fixture();
        const skills = new MattPocockSkillsService(db, { fetch: upstream.fetch });
        await skills.configure({ enabled: true, auto_update: false });
        const imported = owner.runtime.state
          .snapshot()
          .table('skills')
          .all()
          .filter((row) => row.sourceType === MATTPOCOCK_SOURCE_TYPE);
        expect(imported).toHaveLength(2);
        expect(owner.runtime.state.snapshot().table('skillFiles').all().length).toBeGreaterThan(0);
        await skills.configure({ enabled: false });
        const fetched = upstream.calls.length;
        await skills.configure({ enabled: true });
        expect(upstream.calls).toHaveLength(fetched);
        await startRolloutOnPublish(
          db,
          { enabled: true, stages: parseRolloutStages('canary,100'), soakMinutes: 30 },
          '0.9.80',
          '0.9.81',
          'integration',
        );
        expect((await haltRollout(db, 'integration', 'test pause')).status).toBe('halted');
        budget.reset();
        for (let index = 0; index < 100; index++) {
          await feedback.list({ status: 'open' }, actor);
          await feedback.summary(actor);
          await skills.getState();
          await loadWrapperRollout(db, { fresh: true });
        }
        expect(budget.snapshot()).toEqual([]);
        const tables = [
          'feedbackItems',
          'feedbackPipeline',
          'agentSchedules',
          'agentScheduleRuns',
          'agentWatchdogs',
        ] as const;
        const ids = () =>
          tables.map((table) =>
            owner!.runtime.state
              .snapshot()
              .table(table)
              .all()
              .map((row) => {
                const item = row as unknown as { id?: string; feedbackId?: string };
                return item.id ?? item.feedbackId!;
              })
              .sort(),
          );
        const expected = ids(),
          oldEpoch = owner.runtime.state.revision().epoch;
        await owner.close();
        await pool.execute('DELETE FROM control_plane_command_receipts WHERE owner_epoch = ?', [oldEpoch]);
        owner = await createOwnedControlPlane({
          pool,
          handle: drizzle(pool, { schema, mode: 'default' }),
          env,
          keyring: testKeyring(),
          error: (error) => errors.push(error),
        });
        expect(ids()).toEqual(expected);
        expect(errors).toEqual([]);
      } finally {
        const epoch = owner?.runtime.state.revision().epoch;
        await owner?.close();
        if (epoch)
          await pool.execute('DELETE FROM control_plane_command_receipts WHERE owner_epoch = ?', [epoch]);
        for (const id of feedbackIds) {
          await db.delete(schema.feedbackEvents).where(eq(schema.feedbackEvents.feedbackId, id));
          await db.delete(schema.feedbackItems).where(eq(schema.feedbackItems.id, id));
        }
        if (ownsSourceRows)
          await db.delete(schema.skills).where(eq(schema.skills.sourceType, MATTPOCOCK_SOURCE_TYPE));
        await db.delete(schema.versions).where(inArray(schema.versions.name, keys));
        if (saved.length) await db.insert(schema.versions).values(saved);
        budget.restore();
        await pool.end();
      }
    },
  );
});
