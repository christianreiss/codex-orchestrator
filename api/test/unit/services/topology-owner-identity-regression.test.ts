import { describe, expect, it, vi } from 'vitest';
import { CommunicatorRegistry, type CommunicatorView } from '../../../src/services/topology/communicator-registry.js';

// Host/user is deliberately identical: distinct runtime roots can have distinct
// owner processes on the same account. Only a process identity proves redial.
const view = (id: string): CommunicatorView => ({
  id, host_id: 42, username: 'fixture', version: '0.9.76',
  connected_at: new Date(1000).toISOString(), sessions: 0, requests: 0, synced_at: null,
});
const handle = () => ({ close: vi.fn(), remoteAddress: null });
const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function register(registry: CommunicatorRegistry, id: string, owner: string | undefined, at: number) {
  registry.register(view(id), handle(), at);
  // Identity moved from the proposed view field into the negotiated capabilities
  // frame. The assertions stay identical; unrelated processes use different roots.
  if (owner) registry.setCapabilities(id, {
    terminate: true, pid: 100, started_at: null, instance_id: owner,
    runtime_id: owner === OWNER_A ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb',
  }, at);
}

describe('topology successor requires process identity', () => {
  it('correlates a same-process redial when no unrelated owner intervenes', () => {
    const registry = new CommunicatorRegistry();
    register(registry, 'socket-a', OWNER_A, 1000);
    registry.unregister('socket-a', 2000);
    register(registry, 'socket-a-redial', OWNER_A, 3000);
    expect(registry.tombstones(3001)[0]!.successor_id).toBe('socket-a-redial');
  });

  it('does not claim an unrelated owner on the same host/user as the successor', () => {
    const registry = new CommunicatorRegistry();
    register(registry, 'socket-a', OWNER_A, 1000);
    registry.unregister('socket-a', 2000);
    register(registry, 'socket-b', OWNER_B, 3000);
    expect(registry.tombstones(3001)[0]!.successor_id).toBeNull();
  });

  it('leaves legacy owners without identity uncorrelated', () => {
    const registry = new CommunicatorRegistry();
    register(registry, 'legacy-a', undefined, 1000);
    registry.unregister('legacy-a', 2000);
    register(registry, 'legacy-b', undefined, 3000);
    expect(registry.tombstones(3001)[0]!.successor_id).toBeNull();
  });

  it('skips an unrelated owner then correlates a real redial of the original process', () => {
    const registry = new CommunicatorRegistry();
    register(registry, 'socket-a', OWNER_A, 1000);
    registry.unregister('socket-a', 2000);
    register(registry, 'socket-b', OWNER_B, 3000);
    register(registry, 'socket-a-redial', OWNER_A, 4000);
    expect(registry.tombstones(4001)[0]!.successor_id).toBe('socket-a-redial');
  });
});
