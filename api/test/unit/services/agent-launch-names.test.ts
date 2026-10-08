import { describe, expect, it } from 'vitest';
import {
  agentNameKey,
  namedSessionTitle,
  nameLeaseState,
} from '../../../src/services/agent-messaging/names.js';

describe('launch name policy', () => {
  it('keeps the exact 24h quarantine boundary and derives expiry when reaping is delayed', () => {
    const lease = {
      sessionId: 'launch',
      addressId: 'uuid',
      name: 'Claudia',
      nameKey: 'claudia',
      startedAt: '2026-10-07T08:00:00Z',
      endedAt: null,
      cooldownUntil: null,
    };
    const session = { endedAt: null, bridgeExpiresAt: '2026-10-07T09:00:00Z' };
    expect(nameLeaseState(lease, session, '2026-10-08T08:59:59Z')).toEqual({
      endedAt: '2026-10-07T09:00:00Z',
      cooldownUntil: '2026-10-08T09:00:00Z',
      reserved: true,
    });
    expect(nameLeaseState(lease, session, '2026-10-08T09:00:00Z').reserved).toBe(false);
    expect(
      nameLeaseState(lease, { ...session, bridgeExpiresAt: '2026-10-09T00:00:00Z' }, '2026-10-08T09:00:00Z')
        .reserved,
    ).toBe(true);
  });
  it('composes names once, preserves unnamed records and shows an assigned name before a task is known', () => {
    expect(namedSessionTitle('Claudia', 'API review')).toBe('(Claudia) API review');
    expect(namedSessionTitle('Claudia', '(Claudia) API review')).toBe('(Claudia) API review');
    expect(namedSessionTitle('Claudia', null)).toBe('(Claudia)');
    expect(namedSessionTitle(null, 'API review')).toBe('API review');
  });
  it('accepts Unicode and ASCII German name spellings consistently', () => {
    expect(agentNameKey(' BÄRBEL ')).toBe('baerbel');
    expect(agentNameKey('Do\u0308rte')).toBe('doerte');
    expect(agentNameKey('Anna-Lena')).toBe('anna-lena');
  });
});
