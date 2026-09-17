import { describe, expect, it } from 'vitest';
import {
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
    probes: { peer: {}, portal: {} },
  };
}
describe('receiver transport health', () => {
  it.each(['codex-queue-v1', 'claude-channel-v1'] as const)(
    'needs no model acknowledgment for %s',
    (protocol) => {
      const s = { ...state(), protocol };
      expect(receiverReady(s, 'peer', now)).toBe(true);
      expect(receiverReady(s, 'portal', now)).toBe(true);
      expect(receiverView(s, now)?.state).toBe('ready');
    },
  );
  it('expires health independently of wrapper heartbeats and rejects future health', () => {
    const s = state();
    expect(receiverReady(s, 'peer', now + 45_000)).toBe(false);
    expect(receiverView(s, now + 45_000)?.state).toBe('unavailable');
    expect(receiverReady(s, 'peer', now - 1)).toBe(false);
    s.failure = 'adapter_disconnected';
    expect(receiverReady(s, 'peer', now)).toBe(false);
    expect(receiverView(s, now)?.state).toBe('failed');
  });
  it('keeps disabled and closed sources unavailable without closing the peer source', () => {
    const s = state();
    s.portal_closed = true;
    expect(receiverReady(s, 'portal', now)).toBe(false);
    expect(receiverView(s, now)?.sources.map((p) => p.source)).toEqual(['peer']);
    expect(receiverReady(s, 'peer', now)).toBe(true);
    delete s.probes.peer;
    expect(receiverReady(s, 'peer', now)).toBe(false);
    expect(receiverView(s, now)?.state).toBe('unavailable');
  });
  it('ignores old pending, expired, or acknowledged probes without exposing their evidence', () => {
    for (const acknowledged_at of [null, new Date(now - 180_000).toISOString()]) {
      const s = state();
      s.probes.peer = {
        id: 'old',
        nonce: 'secret-nonce',
        delivered_at: new Date(now - 180_000).toISOString(),
        acknowledged_at,
        latency_ms: 7,
      };
      expect(receiverReady(s, 'peer', now)).toBe(true);
      expect(receiverView(s, now)?.state).toBe('ready');
      expect(receiverView(s, now)?.sources[0]).toMatchObject({
        delivery_id: null,
        acknowledged_at: null,
        latency_ms: null,
      });
      expect(JSON.stringify(receiverView(s, now))).not.toContain('secret-nonce');
    }
  });
});
