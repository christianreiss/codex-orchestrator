import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../../src/control-plane/state/store.js';
import type { StateSeed, StateRow } from '../../../../src/control-plane/state/catalog.js';
import type { OwnerRuntime } from '../../../../src/control-plane/state/runtime.js';
import { DeadlineQueue } from '../../../../src/control-plane/deadlines.js';
import { bindOwnerPresence, ConnectionPresence } from '../../../../src/control-plane/presence.js';
import { communicatorRegistry } from '../../../../src/services/topology/communicator-registry.js';
import { claimConnectionError } from '../../../../src/services/agent-coordination/claim-connection-error.js';

const registered: string[] = [];
afterEach(() => {
  for (const id of registered.splice(0)) communicatorRegistry.unregister(id);
});

function fixture(version: string) {
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {} as StateSeed));
  const deadlines = new DeadlineQueue((error) => {
    throw error;
  });
  const runtime: OwnerRuntime = { state, deadlines, assertOwner() {}, execute: () => Promise.reject(new Error('unused')) };
  bindOwnerPresence(runtime, new ConnectionPresence((error) => { throw error; }));
  const id = randomUUID();
  registered.push(id);
  communicatorRegistry.register(
    { id, host_id: 244, username: 'root', version, connected_at: new Date().toISOString(), sessions: 0, requests: 0, synced_at: null, api_version: null },
    { close() {}, terminate() {}, send() {}, remoteAddress: null },
  );
  const session = { id: randomUUID(), hostId: 244, username: 'root', engine: 'codex', bindingGeneration: 1, upstreamSessionId: null } as unknown as Readonly<StateRow<'agentSessions'>>;
  return { runtime, session, close: () => deadlines.close() };
}

describe('claimConnectionError', () => {
  it('names a pre-proof cxx instead of blaming the connection', () => {
    const f = fixture('0.9.123');
    const error = claimConnectionError(f.runtime, f.runtime.state.snapshot(), f.session) as Error & { details?: any };
    f.close();
    expect(error.message).toContain('cxx 0.9.123 predates connection proof');
    expect(error.message).toContain('cxx update');
    expect(JSON.stringify(error)).toContain('client_too_old');
  });

  it('keeps the reconnect guidance for a current cxx', () => {
    const f = fixture('0.9.157');
    const error = claimConnectionError(f.runtime, f.runtime.state.snapshot(), f.session);
    f.close();
    expect(error.message).toContain('reconnect the original managed native process');
    expect(error.message).not.toContain('predates');
  });
});
