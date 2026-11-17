import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { slopRuns, type SlopRun } from '../../../src/db/schema.js';
import { SlopJobsService } from '../../../src/services/slop-jobs.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

function fixture(status: string, address: string | null = null) {
  const run = { id: randomUUID(), status: 'reviewing', mode: 'full', createdAt: new Date().toISOString(),
    advisorSessionId: randomUUID(), advisorCallerId: randomUUID(), advisorReplyEnc: null,
    scanJson: JSON.stringify({ findings: [], errors: [], sources: {}, coverage: ['Quick scan only.'] }),
    reportJson: null,
  } as SlopRun;
  const db = createDbFake(new Map([[slopRuns, [run as unknown as Record<string, unknown>]]]));
  const service = new SlopJobsService({ db, env: loadTestEnv(), keyring: testKeyring() } as never);
  const statusFor = vi.fn().mockResolvedValue({ status, advisor_address: address, diagnostic: {
    code: status === 'failed' ? 'advisor_startup_timeout' : 'advisor_startup_pending', phase: 'queued',
  } });
  const finish = vi.fn(async (_id: string, status: string, patch: object) => { Object.assign(run, { status }, patch); });
  Object.assign(service, { advisor: { statusFor }, finish });
  return { service, run, statusFor, finish };
}

describe('full Slop advisor launch', () => {
  it('finishes a failed launch and preserves the quick report rather than waiting for a nonexistent reply', async () => {
    const f = fixture('failed');
    await f.service.advance(f.run.id);
    expect(f.statusFor).toHaveBeenCalledWith(f.run.advisorCallerId, f.run.advisorSessionId);
    expect(f.finish).toHaveBeenCalledWith(f.run.id, 'failed', {
      reportJson: f.run.scanJson, error: expect.stringContaining('advisor_startup_timeout'),
    }, true);
  });
  it('retains an answer that commits between the run read and the terminal advisor observation', async () => {
    const f = fixture('closed');
    delete (f.service as unknown as Record<string, unknown>).finish;
    const drop = vi.fn();
    Object.assign(f.service, { dropRunDir: drop });
    f.statusFor.mockImplementation(async () => {
      f.run.advisorReplyEnc = 'concurrently committed answer';
      return { status: 'closed', advisor_address: null, diagnostic: null };
    });
    await f.service.advance(f.run.id);
    expect(f.run.status).toBe('reviewing');
    expect(f.run.advisorReplyEnc).toBe('concurrently committed answer');
    expect(drop).not.toHaveBeenCalled();
  });
  it.each([null, 'agent:reviewer'])('describes launch separately from an attached reviewer (%s)', async (address) => {
    const f = fixture('starting', address);
    const response = await (f.service as unknown as { runResponse(run: SlopRun, wait: number): Promise<Record<string, unknown>> }).runResponse(f.run, 0);
    expect(response.run).toMatchObject({ review_phase: address ? 'reviewing' : 'starting', advisor: { status: 'starting' } });
    expect(response.next).toContain(address ? 'is reviewing' : 'launch is pending');
    expect(f.finish).not.toHaveBeenCalled();
  });
});
