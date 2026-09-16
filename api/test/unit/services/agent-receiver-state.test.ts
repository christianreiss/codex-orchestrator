import { describe, expect, it } from 'vitest';
import {
  newReceiverProbe,
  receiverReady,
  receiverView,
  type ReceiverState,
} from '../../../src/services/agent-receiver-state.js';

const now = Date.parse('2026-09-16T12:00:00Z');
function state(): ReceiverState {
  return {
    generation: 'one',
    protocol: 'codex-queue-v1',
    native_session_id: 'thread',
    heartbeat_at: new Date(now).toISOString(),
    failure: null,
    probes: {
      peer: newReceiverProbe(new Date(now).toISOString()),
      portal: newReceiverProbe(new Date(now).toISOString()),
    },
  };
}
describe('receiver evidence', () => {
  it('does not confuse a live transport with a model acknowledgment', () => {
    const s = state();
    expect(receiverReady(s, 'peer', now)).toBe(false);
    expect(receiverView(s, now)?.state).toBe('verifying');
    expect(JSON.stringify(receiverView(s, now))).not.toContain(s.probes.peer!.nonce);
  });
  it('requires independent evidence for each source and expires even if the wrapper lives', () => {
    const s = state();
    s.probes.peer!.acknowledged_at = s.heartbeat_at;
    expect(receiverReady(s, 'peer', now)).toBe(true);
    expect(receiverReady(s, 'portal', now)).toBe(false);
    expect(receiverReady(s, 'peer', now + 45_000)).toBe(false);
    expect(receiverReady(s, 'peer', now - 1)).toBe(false);
    s.failure = 'adapter_disconnected';
    expect(receiverReady(s, 'peer', now)).toBe(false);
  });
  it('reports a probe timeout while the transport still reports health', () => {
    const s = state();
    s.probes.peer!.delivered_at = s.heartbeat_at;
    s.heartbeat_at = new Date(now + 120_000).toISOString();
    expect(receiverView(s, now + 120_000)?.state).toBe('failed');
  });
});
