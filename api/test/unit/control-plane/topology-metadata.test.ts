import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/db/client.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { ConnectionPresence, bindOwnerPresence } from '../../../src/control-plane/presence.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { AgentPortalService } from '../../../src/services/agent-portal.js';
import { TopologyService } from '../../../src/services/topology/service.js';
import { CommunicatorRegistry } from '../../../src/services/topology/communicator-registry.js';
import { loadSessionWork } from '../../../src/services/agent-session-work.js';
import { sha256 } from '../../../src/services/git-director.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

afterEach(() => vi.restoreAllMocks());

describe('owned topology and session work metadata', () => {
  it('reads no SQL and reflects commits and transport detachment immediately', async () => {
    const session = randomUUID(),
      instance = randomUUID(),
      address = randomUUID();
    const db = {
      select: vi.fn(() => {
        throw new Error('Unexpected SQL');
      }),
    } as unknown as Database;
    const state = new OwnerStateStore(
      new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
        hosts: [{ id: 1, fqdn: 'before.example', internalRole: null }],
        agentBusAddresses: [
          {
            id: address,
            address: `agent:${address}`,
            currentSessionId: session,
            displayAlias: 'Before',
            bindingGeneration: 1,
          },
        ],
        agentNativeControls: [
          {
            sessionId: session,
            instanceId: instance,
            bindingGeneration: 1,
            status: 'ready',
            requestId: null,
            updatedAt: '2000-01-01T00:00:00Z',
          },
        ],
        gitWorktrees: [
          {
            id: 'tree',
            hostId: 1,
            worktreeHash: sha256('/work'),
            worktreePath: '/work',
            status: 'active',
            task: 'Before',
            branch: 'main',
            targetBranch: 'main',
            declaredPaths: ['api'],
          },
        ],
      } as unknown as StateSeed),
    );
    const deadlines = new DeadlineQueue((error) => {
      throw error;
    });
    const runtime: OwnerRuntime = {
      state,
      deadlines,
      assertOwner: vi.fn(),
      execute: async () => {
        throw new Error('Read only');
      },
    };
    bindOwnerRuntime(db, runtime);
    const presence = new ConnectionPresence((error) => {
      throw error;
    });
    bindOwnerPresence(runtime, presence);
    const native = presence.attach({
      connectionId: 'socket',
      hostId: 1,
      username: 'user',
      scope: { topic: 'session', session_id: session, native_instance_id: instance, binding_generation: 1 },
    });
    vi.spyOn(AgentPortalService.prototype, 'isEnabled').mockResolvedValue(true);
    vi.spyOn(AgentPortalService.prototype, 'listAgentsSnapshot').mockResolvedValue({
      generated_at: new Date().toISOString(),
      sessions: [
        {
          id: session,
          engine: 'codex',
          host_id: 1,
          host: 'before.example',
          username: 'user',
          cwd: '/work/api',
          presence: 'listening',
          status: 'running',
          relay_ready: true,
          started_at: new Date().toISOString(),
          ended_at: null,
        },
      ],
    } as Awaited<ReturnType<AgentPortalService['listAgentsSnapshot']>>);
    const registry = new CommunicatorRegistry();
    registry.register(
      {
        id: 'socket',
        host_id: 1,
        username: 'user',
        version: 'test',
        connected_at: new Date().toISOString(),
        sessions: 1,
        requests: 0,
        synced_at: null,
      },
      { close() {}, remoteAddress: null },
    );
    const topology = new TopologyService({ db, env: loadTestEnv(), keyring: testKeyring() }, registry);
    const inputs = [{ id: session, host_id: 1, cwd: '/work/api' }];
    try {
      const before = await topology.snapshot();
      expect(before.communicators[0]?.host).toBe('before.example');
      expect(before.agents[0]?.native_control?.available).toBe(true);
      expect((await loadSessionWork(db, inputs)).get(session)).toMatchObject({
        task: 'Before',
        address_alias: 'Before',
      });

      const draft = state.begin();
      draft.upsert('hosts', { ...state.snapshot().hosts.get(1)!, fqdn: 'after.example' });
      draft.upsert('agentBusAddresses', {
        ...state.snapshot().addresses.get(address)!,
        displayAlias: 'After',
      });
      draft.upsert('gitWorktrees', { ...state.snapshot().table('gitWorktrees').get('tree')!, task: 'After' });
      state.publish(draft.seal({ ...state.revision(), sequence: state.revision().sequence + 1n }));
      native.detach();
      const after = await topology.snapshot();
      expect(after.communicators[0]?.host).toBe('after.example');
      expect(after.agents[0]?.native_control?.available).toBe(false);
      expect((await loadSessionWork(db, inputs)).get(session)).toMatchObject({
        task: 'After',
        address_alias: 'After',
      });
      expect(db.select).not.toHaveBeenCalled();
      vi.mocked(runtime.assertOwner).mockImplementation(() => {
        throw new Error('Owner fenced');
      });
      await expect(topology.snapshot()).rejects.toThrow('Owner fenced');
      await expect(loadSessionWork(db, inputs)).rejects.toThrow('Owner fenced');
    } finally {
      presence.close();
      deadlines.close();
    }
  });
});
