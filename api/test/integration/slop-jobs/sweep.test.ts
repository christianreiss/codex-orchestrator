import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coordProjects, slopJobs, slopRuns } from '../../../src/db/schema.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { SlopJobsService } from '../../../src/services/slop-jobs.js';
import {
  createIsolatedTestDb,
  isolatedDbSetupTimeoutMs,
  isolatedDbTeardownTimeoutMs,
  readDbConfig,
} from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

describe.skipIf(!readDbConfig())('Slop worker recovery on MySQL', () => {
  let handle: Awaited<ReturnType<typeof createIsolatedTestDb>>;
  beforeAll(async () => {
    handle = await createIsolatedTestDb('slop');
  }, isolatedDbSetupTimeoutMs);
  afterAll(async () => { await handle?.close(); }, isolatedDbTeardownTimeoutMs);

  it('retains an active expired job and removes expired idle and orphaned jobs', async () => {
    const db = handle.db;
    const root = await mkdtemp(join(tmpdir(), 'slop-sweep-'));
    const now = new Date().toISOString();
    const expired = new Date(Date.now() - 25 * 3600_000).toISOString();
    const [project] = await db.insert(coordProjects).values({ slug: `sweep-${randomUUID()}`, createdAt: now, updatedAt: now });
    const projectId = Number(project.insertId);
    const service = new SlopJobsService({ db, env: { ...loadTestEnv(), DATA_ROOT: root }, keyring: testKeyring() } as RouteContext);
    const active = randomUUID(), idle = randomUUID(), orphan = randomUUID(), run = randomUUID();
    const ids = [active, idle, orphan];
    try {
      const values = { projectId, title: 'cleanup fixture', createdBy: 'fixture', createdAt: expired, updatedAt: now };
      await db.insert(slopJobs).values([
        { ...values, id: active, lastActivityAt: expired },
        { ...values, id: idle, lastActivityAt: expired },
        { ...values, id: orphan, projectId: 0, lastActivityAt: now },
      ]);
      await db.insert(slopRuns).values({
        id: run, jobId: active, seq: 1, clientKey: run, mode: 'quick', status: 'scanning', snapshotJson: '{}',
        createdBy: 'fixture', createdAt: now, updatedAt: now,
      });
      expect(await service.purge(active, now)).toBe(false);
      expect(await service.purge(idle, expired)).toBe(false);
      const next = await service.sweep();
      expect(next).toBeGreaterThan(Date.now());
      const retained = await db.select({ id: slopJobs.id }).from(slopJobs).where(inArray(slopJobs.id, ids));
      expect(retained).toEqual([{ id: active }]);
      await db.update(slopRuns).set({ status: 'completed' }).where(eq(slopRuns.id, run));
      await service.sweep();
      expect(await db.select().from(slopJobs).where(eq(slopJobs.id, active))).toEqual([]);
    } finally {
      await db.delete(slopRuns).where(eq(slopRuns.id, run));
      await db.delete(slopJobs).where(inArray(slopJobs.id, ids));
      await db.delete(coordProjects).where(eq(coordProjects.id, projectId));
      await rm(root, { recursive: true, force: true });
    }
  });
});
