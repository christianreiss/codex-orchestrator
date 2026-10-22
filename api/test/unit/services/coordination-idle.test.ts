import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentCoordination } from '../../../src/services/agent-coordination/index.js';
import { coordinationTickInput } from '../../../src/services/agent-coordination/idle-tick.js';
import { agentScopeEvents } from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/client.js';
import type { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

vi.mock('../../../src/services/agent-coordination/idle-tick.js', () => ({ coordinationTickInput: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function fixture(events: Record<string, unknown>[] = []) {
  const db = createDbFake(new Map([[agentScopeEvents, events]]));
  const service = new AgentCoordination(
    db as unknown as Database,
    loadTestEnv(),
    testKeyring(),
    {} as AgentMessagingService,
  );
  const run = vi
    .spyOn(service, 'run')
    .mockImplementation(async (_id, _token, action) => action(db as never, null));
  const reconcile = vi.spyOn(service, 'reconcile').mockResolvedValue(undefined);
  return { db, service, run, reconcile };
}
const stable = {
  fingerprint: 'same',
  pending: false,
  enabled: true,
  fleet: { codex: true, claude: true, grok: true },
};

describe('coordination background idle certificate', () => {
  it('drains more than one batch even when the input fingerprint is unchanged', async () => {
    const events = Array.from({ length: 501 }, (_, i) => ({
      id: String(i + 1),
      scopeId: 'room',
      sequence: i + 1,
      dispatched: 0,
      createdAt: '2000-01-01T00:00:00Z',
    }));
    const { service, reconcile } = fixture(events);
    vi.mocked(coordinationTickInput).mockImplementation(async () => ({
      ...stable,
      pending: events.some((event) => event.dispatched === 0),
    }));
    const dispatch = vi.spyOn(service, 'dispatch').mockImplementation(async (_tx, batch) => {
      for (const row of batch) events.find((event) => event.id === row.id)!.dispatched = 1;
    });
    await service.tick();
    await service.tick();
    await service.tick();
    expect(dispatch.mock.calls.map((call) => call[1].length)).toEqual([500, 1]);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('coalesces overlapping local ticks so certificates cannot finish out of order', async () => {
    const { service, run } = fixture();
    let release!: (input: typeof stable) => void;
    vi.mocked(coordinationTickInput)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(stable);
    const ticks = [service.tick(), service.tick(), service.tick()];
    release(stable);
    await Promise.all(ticks);
    expect(run).toHaveBeenCalledTimes(1);
    expect(coordinationTickInput).toHaveBeenCalledTimes(2);
  });

  it('does not certify an unsuccessful transaction', async () => {
    const { service, run } = fixture();
    vi.mocked(coordinationTickInput).mockResolvedValue(stable);
    run.mockRejectedValueOnce(new Error('commit failed'));
    await expect(service.tick()).rejects.toThrow('commit failed');
    await service.tick();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
