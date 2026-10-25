import { stageUpdate } from '../../src/control-plane/state/rows.js';
import { agentSessions } from '../../src/db/schema.js';
import { randomUUID } from 'node:crypto';
import type { OwnerRuntime } from '../../src/control-plane/state/runtime.js';
import { mutateOwnerState } from '../../src/control-plane/state/runtime.js';
import type { ConnectionPresence } from '../../src/control-plane/presence.js';
import { sha256 } from '../../src/security/hash.js';

export async function resumeNativeFixture(owner: OwnerRuntime, presence: ConnectionPresence, oldId: string) {
  const id = randomUUID(),
    instance = randomUUID(),
    token = 'resumed-' + id,
    nativeId = randomUUID();
  await mutateOwnerState(owner, {
    kind: 'test.native-resume',
    payload: {},
    prepare(ctx) {
      const old = ctx.snapshot.sessions.get(oldId)!;
      stageUpdate(ctx, 'agentSessions', old.id, {
        status: 'completed',
        endedAt: new Date().toISOString(),
        bindingGeneration: old.bindingGeneration + 1,
        upstreamSessionId: nativeId,
      });
      ctx.draft.upsert('agentSessions', {
        ...old,
        id,
        status: 'running',
        endedAt: null,
        upstreamSessionId: nativeId,
        bindingGeneration: old.bindingGeneration + 2,
        bridgeTokenHash: sha256(token),
      });
      ctx.write(tx => tx.insert(agentSessions).values(ctx.draft.table('agentSessions').get(id)!));
      const address = ctx.snapshot.addresses.get(old.agentBusAddressId!)!;
      stageUpdate(ctx, 'agentBusAddresses', address.id, {
        currentSessionId: id,
        lastUpstreamSessionId: nativeId,
        bindingGeneration: old.bindingGeneration + 2,
      });
      return null;
    },
  });
  const session = owner.state.snapshot().sessions.get(id)!;
  const live = presence.attach({
    connectionId: randomUUID(),
    hostId: session.hostId,
    username: session.username,
    scope: {
      topic: 'session',
      session_id: id,
      binding_generation: session.bindingGeneration,
      native_instance_id: instance,
    },
  });
  return { id, instance, token, nativeId, live };
}
