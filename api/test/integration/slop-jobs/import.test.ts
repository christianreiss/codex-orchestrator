import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { coordProjects, slopJobFiles, slopJobs, slopRuns, type Host } from '../../../src/db/schema.js';
import { SlopJobsService } from '../../../src/services/slop-jobs.js';
import { AgentTransfersService } from '../../../src/services/agent-transfers.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const handle = await getTestDb();
const host = { id: 1 } as Host;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe.skipIf(!handle)('atomic slop source import on MySQL', () => {
  let root: string, projectId: number, service: SlopJobsService;
  const jobIds: string[] = [];
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'slop-import-db-'));
    const at = new Date().toISOString();
    const result = await handle!.db.insert(coordProjects).values({ slug: `slop-import-${randomUUID()}`, createdAt: at, updatedAt: at });
    projectId = Number(result[0].insertId);
    service = new SlopJobsService({ db: handle!.db, env: { ...loadTestEnv(), DATA_ROOT: root }, keyring: testKeyring() } as never);
    vi.spyOn(AgentTransfersService.prototype, 'getEnabled').mockResolvedValue(true);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    for (const id of jobIds) {
      await handle!.db.delete(slopRuns).where(eq(slopRuns.jobId, id));
      await handle!.db.delete(slopJobFiles).where(eq(slopJobFiles.jobId, id));
      await handle!.db.delete(slopJobs).where(eq(slopJobs.id, id));
    }
    await handle!.db.delete(coordProjects).where(eq(coordProjects.id, projectId));
    await rm(root, { recursive: true, force: true });
    await handle!.pool.end();
  });
  const job = async () => {
    const id = randomUUID(), at = new Date().toISOString();
    await handle!.db.insert(slopJobs).values({ id, projectId, title: 'import', status: 'open', createdBy: 'test', createdAt: at, updatedAt: at, lastActivityAt: at });
    jobIds.push(id); return id;
  };
  function transfer(files: Array<{ path: string; content: string }>, options: { badHash?: boolean; truncated?: boolean; afterRead?: () => Promise<void> } = {}) {
    const bytes = Buffer.from(JSON.stringify({ version: 1, files }));
    vi.spyOn(AgentTransfersService.prototype, 'info').mockResolvedValue({ size_bytes: bytes.length, content_sha256: options.badHash ? '0'.repeat(64) : hash(bytes) } as never);
    vi.spyOn(AgentTransfersService.prototype, 'get').mockImplementation(async () => {
      await options.afterRead?.();
      return { content_b64: (options.truncated ? bytes.subarray(0, -1) : bytes).toString('base64'), next_offset: null } as never;
    });
  }
  it('preserves individual file bytes, appends revisions and retries unchanged imports', async () => {
    const id = await job();
    transfer([{ path: 'src/a.ts', content: 'ä\r\nsecond\n' }, { path: 'src/b.ts', content: 'other\n' }]);
    const imported = await service.importSources({ job_id: id, transfer_id: 'transfer' }, host);
    expect(imported.imported).toBe(2);
    const digest = imported.files[0]!.sha256!;
    expect(await readFile(join(root, 'slop/blobs', digest.slice(0, 2), digest), 'utf8')).toBe('ä\r\nsecond\n');
    expect((await service.importSources({ job_id: id, transfer_id: 'transfer' }, host)).unchanged).toBe(2);
    await service.put({ job_id: id, path: 'src/a.ts', content: 'changed' }, host);
    expect((await service.importSources({ job_id: id, transfer_id: 'transfer' }, host)).files[0]!.rev).toBe(3);
  });
  it('rolls back all entries on a late collision and rejects partial/hash-corrupted transfers', async () => {
    const id = await job();
    await service.put({ job_id: id, path: 'existing/nested.ts', content: 'old' }, host);
    transfer([{ path: 'valid.ts', content: 'valid' }, { path: 'existing', content: 'collision' }]);
    await expect(service.importSources({ job_id: id, transfer_id: 'transfer' }, host)).rejects.toThrow('collision');
    expect((await handle!.db.select().from(slopJobFiles).where(eq(slopJobFiles.jobId, id))).length).toBe(1);
    for (const options of [{ badHash: true }, { truncated: true }]) {
      transfer([{ path: 'valid.ts', content: 'valid' }], options);
      await expect(service.importSources({ job_id: id, transfer_id: 'transfer' }, host)).rejects.toThrow('mismatch');
    }
  });
  it('serializes concurrent import, single put and removal on the same job', async () => {
    const id = await job();
    await service.put({ job_id: id, path: 'shared.ts', content: 'base' }, host);
    transfer([{ path: 'shared.ts', content: 'batch' }, { path: 'other.ts', content: 'other' }]);
    await Promise.all([
      service.importSources({ job_id: id, transfer_id: 'transfer' }, host),
      service.put({ job_id: id, path: 'shared.ts', content: 'single' }, host),
      service.put({ job_id: id, path: 'shared.ts', remove: true }, host),
    ]);
    const rows = await handle!.db.select().from(slopJobFiles).where(eq(slopJobFiles.jobId, id));
    expect(rows.filter((row) => row.path === 'shared.ts').map((row) => row.rev).sort()).toEqual([1, 2, 3, 4]);
    expect(rows.filter((row) => row.path === 'other.ts')).toHaveLength(1);
  });
  it('enforces the current-file cap under a concurrent single put', async () => {
    const id = await job();
    transfer(Array.from({ length: 200 }, (_, i) => ({ path: `batch-${i}.ts`, content: 'source' })));
    const outcomes = await Promise.allSettled([
      service.importSources({ job_id: id, transfer_id: 'transfer' }, host),
      service.put({ job_id: id, path: 'single.ts', content: 'single' }, host),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rows = await handle!.db.select().from(slopJobFiles).where(eq(slopJobFiles.jobId, id));
    expect([1, 200]).toContain(rows.length);
  });
  it('pins a run to either complete source revision set across a concurrent import', async () => {
    const id = await job();
    await service.put({ job_id: id, path: 'a.ts', content: 'old-a' }, host);
    await service.put({ job_id: id, path: 'b.ts', content: 'old-b' }, host);
    transfer([{ path: 'a.ts', content: 'new-a' }, { path: 'b.ts', content: 'new-b' }]);
    await Promise.all([
      service.importSources({ job_id: id, transfer_id: 'transfer' }, host),
      service.run({ job_id: id, mode: 'quick', client_message_id: randomUUID(), wait_seconds: 0 }, host),
    ]);
    const [run] = await handle!.db.select().from(slopRuns).where(eq(slopRuns.jobId, id));
    const snapshot = JSON.parse(run!.snapshotJson) as Record<string, { rev: number }>;
    expect([1, 2]).toContain(snapshot['a.ts']!.rev);
    expect(snapshot['a.ts']!.rev).toBe(snapshot['b.ts']!.rev);
  });
  it('rechecks close or expiry after reading a transfer, before publishing any revisions', async () => {
    for (const mode of ['closed', 'expired']) {
      const id = await job();
      transfer([{ path: 'valid.ts', content: 'valid' }], { afterRead: async () => {
        await handle!.db.update(slopJobs).set(mode === 'closed' ? { status: 'closed' } : { lastActivityAt: '2000-01-01T00:00:00.000Z' }).where(eq(slopJobs.id, id));
      } });
      await expect(service.importSources({ job_id: id, transfer_id: 'transfer' }, host)).rejects.toThrow('closed or expired');
      expect(await handle!.db.select().from(slopJobFiles).where(eq(slopJobFiles.jobId, id))).toHaveLength(0);
    }
  });
});
