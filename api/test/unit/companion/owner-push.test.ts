import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnerCompanionPush } from '../../../src/services/companion/push-owner.js';
import { ownerWorkerFixture } from '../../helpers/owner-worker.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import type { RouteContext } from '../../../src/routes/index.js';

afterEach(() => vi.useRealTimers());
describe('owner companion notification obligations', () => {
  it('leaves a quiet fleet with future expiry completely idle for ten minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-10-24T10:00:00Z');
    const seed = {
      companionPairings: [{ tokenHash: 'pair', deviceId: null, userId: 1, expiresAt: '2026-10-24T11:00:00Z' }],
      versions: [{ name: 'owner_portal_event_id', version: '0', updatedAt: new Date().toISOString() }],
    } satisfies StateSeed;
    const f = await ownerWorkerFixture(seed);
    const push = new OwnerCompanionPush({
      db: f.db,
      env: loadTestEnv(),
      keyring: testKeyring(),
    } as RouteContext);
    const worker = push.start(f.error);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.runtime.execute).not.toHaveBeenCalled();
    expect(f.error).not.toHaveBeenCalled();
    expect(push.obligations(f.state.snapshot())).toEqual([
      { key: 'pairing:pair', dueAt: Date.parse('2026-10-24T11:00:00Z'), revision: '2026-10-24T11:00:00Z' },
    ]);
    await worker.close();
    await f.close();
  });
  it('discovers new portal events using committed RAM cursors and schedules pending retries only when configured', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-10-24T10:00:00Z');
    const seed = {
      adminUsers: [{ id: 1, active: 1, accessLevel: 'owner' }],
      companionDevices: [
        {
          id: 'device',
          userId: 1,
          eventCursor: 10,
          notifications: 1,
          revokedAt: null,
          expiresAt: '2026-10-25T00:00:00Z',
          pushTokenDigest: 'digest',
        },
      ],
      versions: [{ name: 'owner_portal_event_id', version: '11', updatedAt: new Date().toISOString() }],
    } as unknown as StateSeed;
    const f = await ownerWorkerFixture(seed);
    const push = new OwnerCompanionPush({
      db: f.db,
      env: {
        ...loadTestEnv(),
        COMPANION_FIREBASE_PROJECT_ID: 'test',
        COMPANION_FIREBASE_CREDENTIAL_FILE: '/not-read',
      },
      keyring: testKeyring(),
    } as RouteContext);
    expect(push.obligations(f.state.snapshot())).toEqual([
      { key: 'events:device', dueAt: 0, revision: '10:11' },
    ]);
    const draft = f.state.begin();
    draft.upsert('companionDevices', { ...draft.table('companionDevices').get('device')!, eventCursor: 11 });
    f.state.publish(draft.seal({ ...f.state.revision(), sequence: 1n }));
    expect(push.obligations(f.state.snapshot())).toEqual([]);
    expect(f.runtime.execute).not.toHaveBeenCalled();
    await f.close();
  });
});
