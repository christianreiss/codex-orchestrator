import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeClientIpPlugin } from '../../../src/http/plugins/client-ip.js';
import { loadTestEnv } from '../../helpers/test-keyring.js';
import type { Env } from '../../../src/env.js';

/**
 * `req.clientIp` is what host API-key IP binding keys off, so a client that can
 * talk the plugin into echoing back its own `X-Forwarded-For` can rebind
 * another host's key. The gate is fail-closed by design (docs/SECURITY.md):
 * forwarded headers count only when `TRUST_X_FORWARDED` is on *and* the direct
 * caller sits inside one of `TRUSTED_PROXY_CIDRS`.
 */

async function buildProbe(overrides: Partial<Env>): Promise<FastifyInstance> {
  const env = { ...loadTestEnv(), ...overrides } as Env;
  const app = Fastify({ logger: false });
  await app.register(makeClientIpPlugin(env));
  app.get('/probe', async (req) => ({ ip: req.clientIp }));
  await app.ready();
  return app;
}

async function clientIp(
  app: FastifyInstance,
  remoteAddress: string,
  headers: Record<string, string | string[]> = {},
): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/probe', remoteAddress, headers });
  expect(res.statusCode).toBe(200);
  return (res.json() as { ip: string }).ip;
}

const SPOOFED = { 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '203.0.113.8' };

describe('client-ip forwarded-header trust gate', () => {
  it('ignores forwarded headers when TRUST_X_FORWARDED is off', async () => {
    const app = await buildProbe({
      TRUST_X_FORWARDED: false,
      // Even a matching CIDR must not re-enable the headers.
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
    });
    expect(await clientIp(app, '10.1.2.3', SPOOFED)).toBe('10.1.2.3');
    await app.close();
  });

  it('ignores forwarded headers when no trusted proxy CIDR is configured', async () => {
    const app = await buildProbe({ TRUST_X_FORWARDED: true, TRUSTED_PROXY_CIDRS: '   ' });
    expect(await clientIp(app, '10.1.2.3', SPOOFED)).toBe('10.1.2.3');
    await app.close();
  });

  it('ignores forwarded headers from a caller outside every trusted CIDR', async () => {
    const app = await buildProbe({
      TRUST_X_FORWARDED: true,
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8,2001:db8::/32',
    });
    expect(await clientIp(app, '192.0.2.55', SPOOFED)).toBe('192.0.2.55');
    // An IPv6 caller must not be matched against the IPv4 range.
    expect(await clientIp(app, '2001:dbf::1', SPOOFED)).toBe('2001:dbf::1');
    await app.close();
  });

  it('takes the first X-Forwarded-For hop from a trusted proxy', async () => {
    const app = await buildProbe({ TRUST_X_FORWARDED: true, TRUSTED_PROXY_CIDRS: '10.0.0.0/8' });
    expect(
      await clientIp(app, '10.1.2.3', {
        'x-forwarded-for': ' 198.51.100.9 , 10.1.2.3 ',
        'x-real-ip': '203.0.113.8',
      }),
    ).toBe('198.51.100.9');
    // Duplicated header: the first occurrence wins.
    expect(
      await clientIp(app, '10.1.2.3', {
        'x-forwarded-for': ['198.51.100.9', '203.0.113.7'],
      }),
    ).toBe('198.51.100.9');
    await app.close();
  });

  it('falls back to X-Real-IP, then the socket address, behind a trusted proxy', async () => {
    const app = await buildProbe({ TRUST_X_FORWARDED: true, TRUSTED_PROXY_CIDRS: '10.0.0.0/8' });
    expect(await clientIp(app, '10.1.2.3', { 'x-real-ip': '198.51.100.9' })).toBe('198.51.100.9');
    // An empty or all-blank XFF is no hop at all.
    expect(
      await clientIp(app, '10.1.2.3', { 'x-forwarded-for': ' , ', 'x-real-ip': '198.51.100.9' }),
    ).toBe('198.51.100.9');
    expect(await clientIp(app, '10.1.2.3')).toBe('10.1.2.3');
    await app.close();
  });

  it('normalises IPv6-mapped and bracketed addresses on both sides of the gate', async () => {
    const app = await buildProbe({
      TRUST_X_FORWARDED: true,
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8,2001:db8::/32',
    });
    // A mapped socket address still has to match the IPv4 CIDR.
    expect(await clientIp(app, '::ffff:10.1.2.3', { 'x-forwarded-for': '198.51.100.9' })).toBe(
      '198.51.100.9',
    );
    expect(await clientIp(app, '::ffff:192.0.2.55', SPOOFED)).toBe('192.0.2.55');
    // ...and mapped / bracketed forwarded values are unwrapped.
    expect(await clientIp(app, '10.1.2.3', { 'x-forwarded-for': '::ffff:1.2.3.4' })).toBe('1.2.3.4');
    expect(await clientIp(app, '10.1.2.3', { 'x-real-ip': '[2001:db8::5]:443' })).toBe(
      '2001:db8::5',
    );
    expect(await clientIp(app, '2001:db8::1', { 'x-forwarded-for': '198.51.100.9' })).toBe(
      '198.51.100.9',
    );
    await app.close();
  });

  it('skips malformed TRUSTED_PROXY_CIDRS entries without disabling the valid ones', async () => {
    const app = await buildProbe({
      TRUST_X_FORWARDED: true,
      TRUSTED_PROXY_CIDRS: 'not-a-cidr, 10.0.0.0/8, ,999.0.0.0/8,10.0.0.0',
    });
    expect(await clientIp(app, '10.1.2.3', { 'x-forwarded-for': '198.51.100.9' })).toBe(
      '198.51.100.9',
    );
    expect(await clientIp(app, '192.0.2.55', SPOOFED)).toBe('192.0.2.55');
    await app.close();
  });
});
