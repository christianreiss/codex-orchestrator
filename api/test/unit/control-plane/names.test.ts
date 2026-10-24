import { describe, expect, it } from 'vitest';
import { ownedNameLeaseState } from '../../../src/control-plane/state/names.js';

describe('connection-owned launch names', () => {
  it('keeps a disconnected or credential-expired lifecycle reserved until explicitly ended', () => {
    const session = { endedAt: null, bridgeExpiresAt: '2026-01-01T00:00:00.000Z' };
    expect(
      ownedNameLeaseState({ endedAt: null, cooldownUntil: null }, session, '2026-10-24T00:00:00.000Z'),
    ).toEqual({ endedAt: null, cooldownUntil: null, reserved: true });
  });
  it('starts cooldown at the actual lifecycle end and releases only after the deadline', () => {
    const endedAt = '2026-10-24T00:00:00.000Z';
    const lease = { endedAt: null, cooldownUntil: null };
    const ended = ownedNameLeaseState(lease, { endedAt }, endedAt);
    expect(ended.reserved).toBe(true);
    expect(ended.endedAt).toBe(endedAt);
    expect(ownedNameLeaseState(lease, { endedAt }, ended.cooldownUntil!).reserved).toBe(false);
  });
});
