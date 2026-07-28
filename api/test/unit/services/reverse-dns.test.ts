import { beforeEach, describe, expect, it, vi } from 'vitest';

const dnsMock = vi.hoisted(() => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  reverse: vi.fn(),
}));

vi.mock('node:dns', () => ({ promises: dnsMock }));

import {
  normalizeHostname,
  normalizeIp,
  resolveForwardIps,
  resolvePtrHosts,
  validateReverseDns,
  assertReverseDnsMatch,
} from '../../../src/services/reverse-dns.js';
import { ForbiddenError } from '../../../src/http/errors.js';

beforeEach(() => {
  vi.clearAllMocks();
  // Every case states its own DNS answers; the default is "nothing resolves".
  dnsMock.resolve4.mockRejectedValue(new Error('ENOTFOUND'));
  dnsMock.resolve6.mockRejectedValue(new Error('ENOTFOUND'));
  dnsMock.reverse.mockRejectedValue(new Error('ENOTFOUND'));
});

describe('normalizeHostname', () => {
  it('lowercases, trims and strips trailing dots', () => {
    expect(normalizeHostname('  Host.Example.COM.  ')).toBe('host.example.com');
    expect(normalizeHostname('host.example.com...')).toBe('host.example.com');
  });
  it('returns null for empty or non-string input', () => {
    expect(normalizeHostname('')).toBeNull();
    expect(normalizeHostname('   ')).toBeNull();
    expect(normalizeHostname('.')).toBeNull();
    expect(normalizeHostname(null)).toBeNull();
    expect(normalizeHostname(undefined)).toBeNull();
    expect(normalizeHostname(42 as unknown as string)).toBeNull();
  });
});

describe('normalizeIp', () => {
  it('maps ::ffff: v4-mapped addresses down to the v4 form', () => {
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp('::FFFF:1.2.3.4')).toBe('1.2.3.4');
  });
  it('keeps v4 as-is and lowercases other v6', () => {
    expect(normalizeIp(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1');
  });
  it('returns null for junk and non-string input', () => {
    expect(normalizeIp('not-an-ip')).toBeNull();
    expect(normalizeIp('1.2.3')).toBeNull();
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp(null)).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
    expect(normalizeIp(1234 as unknown as string)).toBeNull();
  });
});

describe('resolveForwardIps', () => {
  it('unions resolve4 and resolve6, normalized and deduped', async () => {
    dnsMock.resolve4.mockResolvedValue(['203.0.113.7', '203.0.113.7']);
    dnsMock.resolve6.mockResolvedValue(['2001:DB8::1', '::ffff:203.0.113.7']);

    await expect(resolveForwardIps('host.example.com')).resolves.toEqual([
      '203.0.113.7',
      '2001:db8::1',
    ]);
  });
  it('returns the half that resolves when the other rejects', async () => {
    dnsMock.resolve4.mockResolvedValue(['203.0.113.7']);

    await expect(resolveForwardIps('host.example.com')).resolves.toEqual(['203.0.113.7']);
  });
  it('degrades to an empty list when both lookups reject', async () => {
    await expect(resolveForwardIps('host.example.com')).resolves.toEqual([]);
  });
});

describe('resolvePtrHosts', () => {
  it('normalizes the PTR targets', async () => {
    dnsMock.reverse.mockResolvedValue(['Host.Example.COM.', 'host.example.com']);

    await expect(resolvePtrHosts('203.0.113.7')).resolves.toEqual(['host.example.com']);
  });
  it('degrades to an empty list when dns.reverse rejects', async () => {
    await expect(resolvePtrHosts('203.0.113.7')).resolves.toEqual([]);
  });
});

describe('validateReverseDns', () => {
  it('matches only when forward and PTR both hold', async () => {
    dnsMock.resolve4.mockResolvedValue(['203.0.113.7']);
    dnsMock.reverse.mockResolvedValue(['Host.Example.COM.']);

    await expect(validateReverseDns('Host.Example.com.', '::ffff:203.0.113.7')).resolves.toEqual({
      match: true,
      forwardMatch: true,
      ptrMatch: true,
      forwardIps: ['203.0.113.7'],
      ptrHosts: ['host.example.com'],
    });
  });
  it('reports forward-only as a mismatch', async () => {
    dnsMock.resolve4.mockResolvedValue(['203.0.113.7']);
    dnsMock.reverse.mockResolvedValue(['other.example.com']);

    await expect(validateReverseDns('host.example.com', '203.0.113.7')).resolves.toMatchObject({
      match: false,
      forwardMatch: true,
      ptrMatch: false,
    });
  });
  it('reports PTR-only as a mismatch', async () => {
    dnsMock.resolve4.mockResolvedValue(['198.51.100.9']);
    dnsMock.reverse.mockResolvedValue(['host.example.com']);

    await expect(validateReverseDns('host.example.com', '203.0.113.7')).resolves.toMatchObject({
      match: false,
      forwardMatch: false,
      ptrMatch: true,
    });
  });
  it('fails closed when neither side resolves', async () => {
    await expect(validateReverseDns('host.example.com', '203.0.113.7')).resolves.toEqual({
      match: false,
      forwardMatch: false,
      ptrMatch: false,
      forwardIps: [],
      ptrHosts: [],
    });
  });
  it('fails closed on an unusable fqdn or ip without asking the resolver', async () => {
    await expect(validateReverseDns('', '203.0.113.7')).resolves.toMatchObject({ match: false });
    await expect(validateReverseDns('host.example.com', 'not-an-ip')).resolves.toMatchObject({
      match: false,
    });
    expect(dnsMock.resolve4).not.toHaveBeenCalled();
    expect(dnsMock.reverse).not.toHaveBeenCalled();
  });
});

describe('assertReverseDnsMatch', () => {
  it('resolves on a full match', async () => {
    dnsMock.resolve4.mockResolvedValue(['203.0.113.7']);
    dnsMock.reverse.mockResolvedValue(['host.example.com']);

    await expect(assertReverseDnsMatch('host.example.com', '203.0.113.7')).resolves.toBeUndefined();
  });
  it('rejects with a ForbiddenError carrying reverse_dns_mismatch', async () => {
    dnsMock.resolve4.mockResolvedValue(['203.0.113.7']);
    dnsMock.reverse.mockResolvedValue(['other.example.com']);

    const err = await assertReverseDnsMatch('host.example.com', '203.0.113.7').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).toMatchObject({ code: 'reverse_dns_mismatch', status: 403 });
  });
});
