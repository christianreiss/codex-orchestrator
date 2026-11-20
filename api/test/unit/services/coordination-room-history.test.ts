import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentCoordination } from '../../../src/services/agent-coordination/index.js';
import { ownerRuntimeFor } from '../../../src/control-plane/state/runtime.js';
import { coordinationSession, requireScopeMembership, scopeMembers } from '../../../src/control-plane/state/coordination.js';
import { agentRoomEvents, agentScopeEvents } from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/client.js';
import type { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

vi.mock('../../../src/control-plane/state/runtime.js', async (original) => ({
  ...await original<typeof import('../../../src/control-plane/state/runtime.js')>(),
  ownerRuntimeFor: vi.fn(),
}));
vi.mock('../../../src/control-plane/state/coordination.js', async (original) => ({
  ...await original<typeof import('../../../src/control-plane/state/coordination.js')>(),
  coordinationSession: vi.fn(), requireScopeMembership: vi.fn(), scopeMembers: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

const roomId = 'e105d461-6e41-453c-b63b-b381a97dedbb';
function fixture(owner: boolean) {
  const env = loadTestEnv(), keyring = testKeyring();
  const scope = { id: roomId, scopeKey: 'host:32', kind: 'host', title: 'Test host', sequence: 3, createdAt: '2026-11-09T09:00:00Z' };
  const db = createDbFake(new Map<unknown, Record<string, unknown>[]>([
    // A historic chat row sits between two bookkeeping events: agent_room_read must skip it.
    [agentScopeEvents, [[1, 'presence'], [2, 'chat'], [3, 'claim']].map(([sequence, kind]) => ({
      id: `scope-${sequence}`, scopeId: roomId, sequence, kind, actor: 'session',
      bodyEnc: encrypt(JSON.stringify({ content: `scope message ${sequence}` }), keyring), createdAt: scope.createdAt,
    }))],
    [agentRoomEvents, [{ id: 'shared-chat', roomId, kind: 'chat', contentEnc: encrypt('shared chat contribution', keyring) }]],
  ]));
  const service = new AgentCoordination(db as unknown as Database, env, keyring, {} as AgentMessagingService);
  vi.spyOn(service, 'run').mockImplementation(async (_id, _token, action) => action(db as never, null));
  const membership = vi.spyOn(service, 'membership').mockResolvedValue(scope);
  vi.spyOn(service, 'members').mockResolvedValue([]);
  if (owner) {
    vi.mocked(ownerRuntimeFor).mockReturnValue({ state: { snapshot: () => ({}) } } as never);
    vi.mocked(coordinationSession).mockReturnValue(null);
    vi.mocked(requireScopeMembership).mockReturnValue({ ...scope, roomHead: { eventCount: 0, lastAt: null, actorCounts: {} } });
    vi.mocked(scopeMembers).mockReturnValue([]);
  }
  return { service, db, membership };
}

describe.each([false, true])('scope room read (owner=%s)', owner => {
  it('returns membership and claim events only, never chat', async () => {
    const { service } = fixture(owner);
    const all = await service.read(null, null, { scope_id: roomId, after: 0 });
    // Historic scope chat and the shared room-chat stream are read with agent_chat_read.
    expect(all.events.map(event => event.id)).toEqual(['scope-1', 'scope-3']);
    expect(all.events.map(event => event.kind)).toEqual(['presence', 'claim']);
    expect(all).not.toHaveProperty('history');
    const paged = await service.read(null, null, { scope_id: roomId, after: 0, limit: 1 });
    expect(paged.events.map(event => event.id)).toEqual(['scope-1']);
    expect(paged).toMatchObject({ cursor: 3, has_more: true, next_after: 1, next_before: null });
  });

  it('returns an empty page without a history hint', async () => {
    const { service, db } = fixture(owner);
    db.tables.set(agentScopeEvents, []);
    const result = await service.read(null, null, { scope_id: roomId });
    expect(result.events).toEqual([]);
    expect(result).toMatchObject({ has_more: false });
    expect(result).not.toHaveProperty('history');
  });

  it('still requires membership', async () => {
    const { service, membership } = fixture(owner);
    if (owner) vi.mocked(requireScopeMembership).mockImplementation(() => { throw new Error('membership required'); });
    else membership.mockRejectedValue(new Error('membership required'));
    await expect(service.read(null, null, { scope_id: roomId })).rejects.toThrow('membership required');
  });
});

describe('agent_room_send compatibility alias', () => {
  it('delegates to the shared room-chat send with room_id equal to the scope ID', async () => {
    const { service } = fixture(false);
    const send = vi.fn().mockResolvedValue({ id: 'event' });
    (service as unknown as { roomChatService: { send: typeof send } }).roomChatService = { send };
    const request = { scope_id: roomId, content: 'coordinate', client_request_id: 'c0f6d31e-0c3b-4f5d-9d0e-2f1b7a6c1e11' };
    await expect(service.send('session-1', 'bridge-token', request)).resolves.toEqual({ id: 'event' });
    expect(send).toHaveBeenCalledWith(
      { sessionId: 'session-1', token: 'bridge-token' },
      { room_id: roomId, content: 'coordinate', client_request_id: request.client_request_id },
    );
  });

  it('keeps the strict legacy request shape', async () => {
    const { service } = fixture(false);
    await expect(service.send('s', 't', { room_id: roomId, content: 'x', client_request_id: 'c0f6d31e-0c3b-4f5d-9d0e-2f1b7a6c1e11' })).rejects.toThrow();
  });
});
