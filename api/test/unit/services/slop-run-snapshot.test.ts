import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { slopJobs } from '../../../src/db/schema.js';
import { SlopJobsService } from '../../../src/services/slop-jobs.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

describe('Slop immutable review snapshot', () => {
  it('materializes Go/PTY sources and passes original screenshot hashes to the worker', async () => {
    const job = { id: randomUUID(), status: 'open', projectId: 1, runCount: 0, descriptionRev: 1 };
    const db = createDbFake(new Map([[slopJobs, [job]]]));
    const service = new SlopJobsService({ db, env: loadTestEnv(), keyring: testKeyring() } as never);
    const writeAtomic = vi.fn();
    const latest = [
      { path: 'view.go', kind: 'source', sha256: 'a'.repeat(64), rev: 1, sizeBytes: 10 },
      { path: 'evidence/terminal.txt', kind: 'source', sha256: 'b'.repeat(64), rev: 1, sizeBytes: 10 },
      { path: 'evidence/terminal.png', kind: 'screenshot', sha256: 'c'.repeat(64), rev: 1, sizeBytes: 10 },
    ];
    Object.assign(service, {
      job: vi.fn().mockResolvedValue(job),
      advisorCaller: vi.fn().mockResolvedValue({ session: { agentBusAddressId: randomUUID() } }),
      advisor: { availability: vi.fn().mockResolvedValue({ enabled: true }) },
      transfers: { getEnabled: vi.fn().mockResolvedValue(true) },
      write: (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
      currentFiles: vi.fn().mockResolvedValue({ latest }),
      actor: () => 'test', projectSlug: async () => 'test', publish: vi.fn(),
      readBlob: async () => Buffer.from('snapshot'), writeAtomic,
      // Stop after materialization: no worker, DB or live Advisor in this unit test.
      waitForResult: vi.fn().mockResolvedValue(null), finish: vi.fn(),
      runRow: vi.fn().mockResolvedValue({}), runResponse: vi.fn().mockResolvedValue({}),
    });
    await service.run({ job_id: job.id, mode: 'full', client_message_id: randomUUID() }, {} as never);
    const writes = writeAtomic.mock.calls as [string, string | Buffer][];
    expect(writes.map(([path]) => path)).toEqual(expect.arrayContaining([
      expect.stringContaining('/tree/view.go'), expect.stringContaining('/tree/evidence/terminal.txt'),
      expect.stringContaining('/out/evidence/terminal.png'),
    ]));
    const request = writes.find(([path]) => path.endsWith('/scan.request.json'))!;
    expect(JSON.parse(String(request[1]))).toEqual({ task: 'scan', full: true, artifacts: { 'evidence/terminal.png': 'c'.repeat(64) } });
  });
});
