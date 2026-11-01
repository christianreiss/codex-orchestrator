import { describe, expect, it } from 'vitest';
import { covers, overlaps, resourceSchema } from '../../../src/services/agent-coordination/model.js';

const remote = (fqdn: string, service = 'ssh') => resourceSchema.parse({ kind: 'remote', fqdn, service });
describe('canonical unmanaged remote resource targets', () => {
  it.each([
    ['10.255.230.2', '10.255.230.2'],
    ['BHKW-Control.', 'bhkw-control'],
    ['EXAMPLE.COM.', 'example.com'],
    ['2001:0DB8:0:0:0:0:0:1', '2001:db8::1'],
  ])('accepts and canonicalizes %s as %s', (input, canonical) => {
    expect(remote(input)).toMatchObject({ fqdn: canonical });
    expect(overlaps(remote(input), remote(canonical))).toBe(true);
    expect(covers(remote(canonical, '*'), remote(input))).toBe(true);
  });
  it.each(['', 'https://example.com', 'user@server', '../server', 'server:22', '999.255.230.2', '[2001:db8::1]', 'bad_host'])('rejects ambiguous target %s', input => {
    expect(() => remote(input)).toThrow();
  });
  it('keeps different targets and services separate without DNS alias inference', () => {
    expect(overlaps(remote('10.255.230.2'), remote('bhkw-control'))).toBe(false);
    expect(overlaps(remote('bhkw-control', 'ssh'), remote('bhkw-control', 'api'))).toBe(false);
  });
});
