import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseMtls } from '../../../src/security/mtls.js';
import { makeAuthMtlsPlugin } from '../../../src/http/plugins/auth-mtls.js';
import type { Env } from '../../../src/env.js';

/**
 * `parseMtls` reads whatever `x-mtls-*` headers arrive and verifies none of
 * them, so the one property that keeps it honest is that it never answers a
 * question it cannot answer: `cnameMatches` stays unset because no expected-CN
 * allowlist exists to compare `subject` against. A change that defaulted it to
 * `true` would hand every caller a forged "the certificate matches" — hence the
 * static scan at the bottom of this file alongside the header-parsing cases.
 */

function request(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe('parseMtls header parsing', () => {
  it('reports no claims when the headers are absent', () => {
    const claims = parseMtls(request({}));
    expect(claims).toEqual({
      present: false,
      fingerprint: undefined,
      subject: undefined,
      issuer: undefined,
    });
  });

  it('drops empty-string headers', () => {
    const claims = parseMtls(
      request({ 'x-mtls-fingerprint': '', 'x-mtls-subject': '', 'x-mtls-issuer': '' }),
    );
    expect(claims.fingerprint).toBeUndefined();
    expect(claims.subject).toBeUndefined();
    expect(claims.issuer).toBeUndefined();
    expect(claims.present).toBe(false);
  });

  it('passes single-valued headers through', () => {
    const claims = parseMtls(
      request({
        'x-mtls-fingerprint': 'AA:BB:CC',
        'x-mtls-subject': 'CN=worker.example.com',
        'x-mtls-issuer': 'CN=Internal CA',
      }),
    );
    expect(claims).toEqual({
      present: true,
      fingerprint: 'AA:BB:CC',
      subject: 'CN=worker.example.com',
      issuer: 'CN=Internal CA',
    });
  });

  it('takes the first element of an array-valued header', () => {
    // A duplicated header is a client that sent two; the proxy-injected value
    // is the first one, and the trailing copies are ignored rather than joined.
    const claims = parseMtls(
      request({
        'x-mtls-fingerprint': ['AA:BB:CC', 'DD:EE:FF'],
        'x-mtls-subject': ['CN=worker.example.com', 'CN=attacker.example.com'],
        'x-mtls-issuer': ['CN=Internal CA', 'CN=Other CA'],
      }),
    );
    expect(claims).toEqual({
      present: true,
      fingerprint: 'AA:BB:CC',
      subject: 'CN=worker.example.com',
      issuer: 'CN=Internal CA',
    });

    // An empty array has no first element at all.
    expect(parseMtls(request({ 'x-mtls-fingerprint': [] })).fingerprint).toBeUndefined();
    // The array branch does not apply the emptiness check the string branch
    // does, so a leading blank copy survives as ''  -- `present` is derived from
    // the fingerprint's truthiness, so it still reads as no certificate.
    const blankFirst = parseMtls(request({ 'x-mtls-fingerprint': ['', 'AA:BB:CC'] }));
    expect(blankFirst.fingerprint).toBe('');
    expect(blankFirst.present).toBe(false);
  });

  it('derives `present` from the fingerprint alone', () => {
    // A subject and issuer with no fingerprint is not a presented certificate.
    const claims = parseMtls(
      request({ 'x-mtls-subject': 'CN=worker.example.com', 'x-mtls-issuer': 'CN=Internal CA' }),
    );
    expect(claims.present).toBe(false);
    expect(claims.subject).toBe('CN=worker.example.com');
    expect(claims.issuer).toBe('CN=Internal CA');
  });

  it('never sets cnameMatches, whatever the subject says', () => {
    const cases = [
      {},
      { 'x-mtls-subject': '' },
      { 'x-mtls-fingerprint': 'AA:BB:CC', 'x-mtls-subject': 'CN=worker.example.com' },
      { 'x-mtls-fingerprint': ['AA:BB:CC'], 'x-mtls-subject': ['CN=worker.example.com'] },
    ];
    for (const headers of cases) {
      const claims = parseMtls(request(headers));
      expect(claims.cnameMatches).toBeUndefined();
      // Not merely undefined: the key is absent, so a `in`-style check cannot
      // read it as an answered question either.
      expect('cnameMatches' in claims).toBe(false);
    }
  });
});

describe('authMtlsPlugin wiring', () => {
  const CLAIM_HEADERS = {
    'x-mtls-fingerprint': 'AA:BB:CC',
    'x-mtls-subject': 'CN=worker.example.com',
    'x-mtls-issuer': 'CN=Internal CA',
  };

  /**
   * `light-my-request` reports `127.0.0.1` as the peer, so a CIDR covering it
   * models "the request arrived from our own reverse proxy" and any other CIDR
   * models "it arrived from somewhere else".
   */
  async function buildProbe(env: Partial<Env> = {}) {
    const app = Fastify({ logger: false });
    await app.register(
      makeAuthMtlsPlugin({
        TRUST_X_FORWARDED: true,
        TRUSTED_PROXY_CIDRS: '127.0.0.0/8',
        ...env,
      } as Env),
    );
    app.get('/probe', async (req) => req.mtls);
    await app.ready();
    return app;
  }

  it('decorates the request and fills it from the onRequest hook', async () => {
    const app = await buildProbe();
    expect(app.hasRequestDecorator('mtls')).toBe(true);

    const res = await app.inject({ method: 'GET', url: '/probe', headers: CLAIM_HEADERS });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      present: true,
      fingerprint: 'AA:BB:CC',
      subject: 'CN=worker.example.com',
      issuer: 'CN=Internal CA',
    });
    await app.close();
  });

  it('leaves claims on a header-less request rather than the null decoration', async () => {
    const app = await buildProbe();
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(200);
    // The decorator's placeholder is `null`; seeing the parsed shape here is
    // what proves the hook ran on a request that carried no `x-mtls-*` at all.
    expect(res.json()).toEqual({ present: false });
    await app.close();
  });

  /**
   * This server verifies no certificate — the headers are a proxy's report, and
   * a report is only worth the hop that made it. A caller who reaches the port
   * directly can type the same bytes our edge does, so the claims have to be
   * discarded unless the peer is one we were told to believe.
   */
  it('discards claims from a peer outside TRUSTED_PROXY_CIDRS', async () => {
    const app = await buildProbe({ TRUSTED_PROXY_CIDRS: '10.9.9.0/24' });
    const res = await app.inject({ method: 'GET', url: '/probe', headers: CLAIM_HEADERS });
    expect(res.json()).toEqual({ present: false });
    await app.close();
  });

  it('discards claims when forwarded headers are not trusted at all', async () => {
    const app = await buildProbe({ TRUST_X_FORWARDED: false });
    const res = await app.inject({ method: 'GET', url: '/probe', headers: CLAIM_HEADERS });
    expect(res.json()).toEqual({ present: false });
    await app.close();
  });

  // An allowlist left empty by accident must not read as "trust everyone".
  it('discards claims when trust is on but no CIDRs are configured', async () => {
    const app = await buildProbe({ TRUSTED_PROXY_CIDRS: '' });
    const res = await app.inject({ method: 'GET', url: '/probe', headers: CLAIM_HEADERS });
    expect(res.json()).toEqual({ present: false });
    await app.close();
  });
});

const API = resolve(import.meta.dirname, '../../..');
const API_SRC = resolve(API, 'src');

/**
 * Block comments keep their line count so a hit stays locatable, and the
 * `[^:'"`]` guard keeps a `://` inside a URL from eating its own line. The
 * trust-boundary prose in `security/mtls.ts` is exactly the kind of comment
 * that must not read as code.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, '$1');
}

/** Every `.ts` under `api/src`, keyed as `src/...`. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) found.push(relative(API, path).replace(/\\/g, '/'));
    }
  };
  walk(API_SRC);
  return found.sort();
}

const FILES = sourceFiles();

/**
 * `cnameMatches = x` and its compound forms, `cnameMatches: x` as an object
 * literal or type property, and the `{ cnameMatches }` shorthand that sets the
 * field from a same-named binding. The optional declaration `cnameMatches?:`
 * in the `MtlsClaims` interface is the one form that is not a set, and a
 * comparison (`=== true`) is a read.
 */
const SETS_CNAME = /cnameMatches\s*(?:\?\?|\|\||&&)?=(?!=)|cnameMatches\s*:|cnameMatches\s*[,}]/;

/** `src/file.ts:12 <line>` for every line of code that sets the field. */
function cnameSetters(): string[] {
  return FILES.flatMap((file) =>
    stripComments(readFileSync(join(API, file), 'utf8'))
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => SETS_CNAME.test(line))
      .map(({ line, number }) => `${file}:${number} ${line.trim()}`),
  );
}

describe('the cnameMatches invariant', () => {
  it('scans the sources the invariant is held against', () => {
    // A walk or a pattern that quietly matched nothing would pass everything.
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES).toContain('src/security/mtls.ts');
    // The declaration the scan exempts. If the field is renamed or made
    // required, this fails first and the pattern below gets updated with it.
    expect(readFileSync(join(API_SRC, 'security/mtls.ts'), 'utf8')).toContain(
      'cnameMatches?: boolean;',
    );

    for (const set of [
      'claims.cnameMatches = true;',
      'req.mtls.cnameMatches ||= true;',
      'claims.cnameMatches ??= subject === expected;',
      'return { present: true, cnameMatches: true };',
      'return { present, cnameMatches };',
      'const claims = { cnameMatches, present: true };',
    ]) {
      expect(SETS_CNAME.test(set)).toBe(true);
    }

    for (const kept of [
      '  cnameMatches?: boolean;',
      'if (req.mtls.cnameMatches === true) return;',
      'expected.cnameMatches !== false',
    ]) {
      expect(SETS_CNAME.test(kept)).toBe(false);
    }

    // Prose about the field is not the field being set.
    expect(SETS_CNAME.test(stripComments('// never write cnameMatches = true here\n'))).toBe(false);
  });

  it('sets cnameMatches nowhere in api/src', () => {
    // There is no expected-CN allowlist to compare `subject` against, so any
    // value here would be fabricated -- and callers would authorize on it.
    // Land the allowlist and its verification first, then this scan.
    expect(cnameSetters()).toEqual([]);
  });
});
