import { describe, expect, it } from 'vitest';
import { pageAgentAddresses } from '../../../src/services/agent-messaging/discovery.js';

const peers = Array.from({ length: 53 }, (_, i) => ({
  address: {
    address: `agent:${String(i).padStart(3, '0')}`,
    launchName: i === 52 ? 'Amelie' : `Peer ${i}`,
    displayAlias: i === 51 ? 'Release Ops' : null,
  },
}));

describe('agent discovery pages', () => {
  it('makes every peer beyond the default cap reachable and ends without another offset', () => {
    const first = pageAgentAddresses(peers, {});
    expect(first).toMatchObject({ total: 53, truncated: true, next_offset: 50 });
    expect(first.addresses).toHaveLength(50);
    const last = pageAgentAddresses(peers, { offset: first.next_offset });
    expect(last.addresses).toEqual(peers.slice(50));
    expect(last).not.toHaveProperty('next_offset');
    expect(pageAgentAddresses(peers, { offset: 100 }).addresses).toEqual([]);
  });
  it('filters names and aliases before paging, including peers beyond the cap', () => {
    expect(pageAgentAddresses(peers, { name: ' aMeLiE ' })).toMatchObject({
      addresses: [peers[52]],
      total: 1,
    });
    expect(pageAgentAddresses(peers, { name: 'release ops' }).addresses).toEqual([peers[51]]);
    expect(pageAgentAddresses(peers, { name: 'agent:052' }).addresses).toEqual([peers[52]]);
    expect(pageAgentAddresses(peers, { name: '%' }).total).toBe(0);
    expect(pageAgentAddresses(peers, { name: 'Peer', limit: 2, offset: 2 })).toMatchObject({
      addresses: peers.slice(2, 4),
      total: 52,
      next_offset: 4,
    });
  });
  it.each([
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { offset: -1 },
    { offset: 0.5 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid bounds %j', (filters) => {
    expect(() => pageAgentAddresses(peers, filters)).toThrow();
  });
});
