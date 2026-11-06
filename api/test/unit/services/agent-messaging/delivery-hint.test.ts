import { describe, expect, it } from 'vitest';
import {
  deliveryHint,
  deliveryReceiptFields,
  stuckClaimGate,
  STUCK_CLAIM_GATE_SECONDS,
} from '../../../../src/services/agent-messaging/presence-feedback.js';

describe('send receipt delivery hint', () => {
  it('names a claim gate closed longer than two minutes (feedback f2b100b0)', () => {
    const gate = { state: 'thread_other', seconds: 867 };
    expect(deliveryHint('listening', { claimGate: gate })).toContain('claim gate has been thread_other for 867s');
    expect(deliveryReceiptFields('listening', { claimGate: gate })).toMatchObject({
      recipient_presence: 'listening',
      recipient_claim_gate: 'thread_other',
      recipient_claim_gate_seconds: 867,
    });
  });

  it('keeps the ready hint for admitting or young gates', () => {
    const ready = deliveryHint('listening');
    for (const gate of [
      { state: 'open', seconds: 9000 },
      { state: 'work_active', seconds: 9000 },
      { state: 'unknown', seconds: 9000 },
      { state: 'held_delivery', seconds: STUCK_CLAIM_GATE_SECONDS },
    ]) {
      expect(stuckClaimGate(gate)).toBeNull();
      expect(deliveryHint('listening', { claimGate: gate })).toBe(ready);
      expect(deliveryReceiptFields('listening', { claimGate: gate })).not.toHaveProperty('recipient_claim_gate');
    }
    // A gate only qualifies a listening recipient.
    expect(deliveryReceiptFields('online', { claimGate: { state: 'thread_other', seconds: 900 } })).not.toHaveProperty(
      'recipient_claim_gate',
    );
  });

  it('says when no daemon relay can resume an idle daemon helper (feedback f4b31207)', () => {
    for (const presence of ['offline', 'resumable'] as const) {
      const missing = deliveryReceiptFields(presence, { daemonRelay: 'missing' });
      expect(missing.recipient_daemon_relay).toBe('missing');
      expect(missing.delivery_hint).toContain('no daemon relay is connected');
      expect(missing.delivery_hint).not.toContain('may resume');
      const connected = deliveryReceiptFields(presence, { daemonRelay: 'connected' });
      expect(connected.recipient_daemon_relay).toBe('connected');
      expect(connected.delivery_hint).toBe(deliveryHint(presence));
    }
    expect(deliveryHint('offline')).toContain('a background worker may resume');
    expect(deliveryReceiptFields('listening', { daemonRelay: 'missing' })).not.toHaveProperty('recipient_daemon_relay');
  });
});
