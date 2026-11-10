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
  const scope = { id: roomId, scopeKey: 'host:32', kind: 'host', title: 'Test host', sequence: 2, createdAt: '2026-11-09T09:00:00Z' };
  const db = createDbFake(new Map<unknown, Record<string, unknown>[]>([
    [agentScopeEvents, [1, 2].map(sequence => ({
      id: `scope-${sequence}`, scopeId: roomId, sequence, kind: 'chat', actor: 'session',
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

describe.each([false, true])('scope history coverage (owner=%s)', owner => {
  it('identifies the missing chat stream and supplies a same-room unified history call', async () => {
    const { service } = fixture(owner);
    const result = await service.read(null, null, { scope_id: roomId, after: 0, limit: 1 });
    // A separate shared-chat event exists, but this numeric cursor covers scope events only.
    expect(result.events.map(event => event.id)).toEqual(['scope-1']);
    expect(result).toMatchObject({ cursor: 2, has_more: true, next_after: 1, next_before: null });
    expect(result).toMatchObject({
      history: {
        coverage: 'scope_events_only',
        notice: expect.stringContaining('agent_chat_send'),
        unified_chat: { tool: 'agent_chat_read', arguments: { room_id: roomId } },
      },
    });
    expect(result.history.unified_chat.arguments).toEqual({ room_id: roomId });
    expect(result.history.notice).toContain('do not reuse scope cursors');
  });

  it('still advertises unified history on an empty scope page', async () => {
    const { service, db } = fixture(owner);
    db.tables.set(agentScopeEvents, []);
    const result = await service.read(null, null, { scope_id: roomId });
    expect(result.events).toEqual([]);
    expect(result).toMatchObject({ has_more: false, history: { coverage: 'scope_events_only' } });
  });

  it('does not turn the history hint into a membership bypass', async () => {
    const { service, membership } = fixture(owner);
    if (owner) vi.mocked(requireScopeMembership).mockImplementation(() => { throw new Error('membership required'); });
    else membership.mockRejectedValue(new Error('membership required'));
    await expect(service.read(null, null, { scope_id: roomId })).rejects.toThrow('membership required');
  });
});
