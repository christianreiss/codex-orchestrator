import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OwnerStateSnapshot, OwnerStateDraft } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { RetentionProjection } from '../../../src/services/server-retention/projection.js';

const draft = (seed: unknown) =>
  new OwnerStateDraft(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed as StateSeed));
describe('retention declared FK projection', () => {
  it('removes daemon children including composite device-follow keys', () => {
    const state = draft({
      hostDaemonSessions: [{ id: 'daemon' }, { id: 'keep' }],
      hostDaemonOperations: [{ id: 'operation', sessionId: 'daemon' }],
      hostDaemonPortalBindings: [{ daemonSessionId: 'daemon', portalSessionId: 'portal' }],
      companionDaemonFollows: [{ deviceId: 'device', daemonSessionId: 'daemon' }],
    });
    const projection = new RetentionProjection(state);
    projection.removeWhere('hostDaemonSessions', (row) => row.id === 'daemon');
    expect(
      state
        .table('hostDaemonSessions')
        .all()
        .map((row) => row.id),
    ).toEqual(['keep']);
    expect(state.table('hostDaemonOperations').size).toBe(0);
    expect(state.table('hostDaemonPortalBindings').size).toBe(0);
    expect(state.table('companionDaemonFollows').size).toBe(0);
  });
  it('removes native control and daemon binding when portal session is deleted', () => {
    const state = draft({
      agentSessions: [{ id: 'portal' }],
      agentNativeControls: [{ sessionId: 'portal' }],
      hostDaemonPortalBindings: [{ daemonSessionId: 'daemon', portalSessionId: 'portal' }],
    });
    new RetentionProjection(state).removeWhere('agentSessions', (row) => row.id === 'portal');
    expect(state.table('agentNativeControls').size).toBe(0);
    expect(state.table('hostDaemonPortalBindings').size).toBe(0);
  });
});
