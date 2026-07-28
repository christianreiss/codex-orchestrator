import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Six shipped docs used to tell operators that `/admin/*` is gated on a client
 * certificate by the app whenever `ADMIN_ACCESS_MODE=mtls` (the default). It
 * never was: `ADMIN_ACCESS_MODE` is read in one route (the CLI device-approval
 * page), `auth-mtls` only parses `X-MTLS-*` into `req.mtls` and no route reads
 * that, and the real certificate gate is `caddy/Caddyfile` — a compose profile
 * a plain `docker compose up` does not start. An operator who believed the docs
 * left `/admin` reachable with a session cookie alone.
 *
 * So this scan pins both halves: the app layer keeps exactly one consumer of
 * each signal, and the six docs keep describing the layering that exists.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const API = resolve(ROOT, 'api');
const API_SRC = resolve(API, 'src');
const DOCS = resolve(ROOT, 'docs');

/** The file allowed to read `ADMIN_ACCESS_MODE`, and what it uses it for. */
const ADMIN_ACCESS_MODE_READERS: Record<string, string> = {
  'src/routes/cli-auth/index.ts': 'GET /cli/auth/verify demands an admin session unless the mode is `open`',
};

/** The file allowed to read `req.mtls`, and what it does with it. */
const MTLS_READERS: Record<string, string> = {
  'src/http/plugins/auth-mtls.ts':
    'assigns req.mtls = parseMtls(req); the claims are surfaced, never authorized on',
};

const DOC_NAMES = ['API.md', 'interface-api.md', 'ADMIN.md', 'LOGIN.md', 'USAGE.md', 'INSTALL.md'] as const;

/**
 * A property read (`ctx.env.ADMIN_ACCESS_MODE`, `env['ADMIN_ACCESS_MODE']`),
 * which the `env.ts` schema key `ADMIN_ACCESS_MODE: z.enum([...])` is not.
 */
const ADMIN_ACCESS_MODE_READ = /[\w$)\]]\.ADMIN_ACCESS_MODE\b|\[\s*['"]ADMIN_ACCESS_MODE['"]\s*\]/;

/** `req.mtls`, but not the `auth-mtls.js`/`security/mtls.js` module paths. */
const MTLS_READ = /[\w$)\]]\.mtls\b/;

/**
 * Comments only, so that prose about a gate is never mistaken for the gate:
 * `security/mtls.ts` documents `ADMIN_ACCESS_MODE` and `req.mtls` at length.
 * The `[^:'"`]` guard keeps a `://` inside a URL from eating its own line.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, '$1');
}

/** Every `.ts` under `api/src`, keyed as `src/...` like the allowlists. */
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

/** The files whose code — not comments — matches `pattern`. */
function readers(pattern: RegExp): string[] {
  return FILES.filter((file) => pattern.test(stripComments(readFileSync(join(API, file), 'utf8'))));
}

const MTLS_TERM = /(?<![\w-])(?:mTLS|client certificates?|client certs?)(?![\w-])/i;

/**
 * "requires mTLS", "protected by client certificates", and the same claim with
 * the verb trailing ("mTLS is required for `/admin/*`"). `[^.]` keeps a claim
 * inside its own sentence, so a denial followed by an unrelated requirement
 * does not read as one.
 */
const CLAIMS = [
  new RegExp(
    `(?:requires?|enforces?|protected by|gated (?:on|by)|sits (?:behind|inside)|blocks?)[^.]{0,80}?${MTLS_TERM.source}`,
    'i',
  ),
  new RegExp(`${MTLS_TERM.source}[^.]{0,80}?(?:required|enforced|mandatory)`, 'i'),
];

/** Naming the layer that does enforce it is the correction, not the drift. */
const PROXY_LAYER = /caddy|proxy/i;

/** Lines claiming the app requires a certificate for admin, one per hit. */
function mtlsClaims(name: string, markdown: string): string[] {
  return markdown
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(
      ({ line }) =>
        /admin/i.test(line) && !PROXY_LAYER.test(line) && CLAIMS.some((claim) => claim.test(line)),
    )
    .map(({ number, line }) => `docs/${name}:${number} ${line.trim()}`);
}

describe('ADMIN_ACCESS_MODE and req.mtls consumers', () => {
  it('reads the sources the allowlists are held against', () => {
    // A walk or a pattern that quietly matched nothing would pass everything.
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES).toContain('src/env.ts');
    expect(FILES).toContain('src/security/mtls.ts');

    expect(ADMIN_ACCESS_MODE_READ.test("if (ctx.env.ADMIN_ACCESS_MODE !== 'open')")).toBe(true);
    // The schema key declares the var; it does not consume it.
    expect(ADMIN_ACCESS_MODE_READ.test("ADMIN_ACCESS_MODE: z.enum(['mtls']).default('mtls')")).toBe(false);
    expect(MTLS_READ.test('req.mtls = parseMtls(req);')).toBe(true);
    expect(MTLS_READ.test("import { parseMtls } from '../../security/mtls.js';")).toBe(false);

    const comment = stripComments('// a gate on ctx.env.ADMIN_ACCESS_MODE would read req.mtls\n');
    expect(ADMIN_ACCESS_MODE_READ.test(comment)).toBe(false);
    expect(MTLS_READ.test(comment)).toBe(false);
  });

  it('reads ADMIN_ACCESS_MODE in exactly one file', () => {
    // A second reader means the env var now decides something else. Say what
    // that is in the docs listed here, then add the file to the allowlist.
    expect(readers(ADMIN_ACCESS_MODE_READ)).toEqual(Object.keys(ADMIN_ACCESS_MODE_READERS));
  });

  it('reads req.mtls in exactly one file', () => {
    // `parseMtls` verifies nothing (see the trust boundary note in
    // src/security/mtls.ts): a route reading req.mtls to authorize would be
    // trusting spoofable headers unless a proxy overwrites them first.
    expect(readers(MTLS_READ)).toEqual(Object.keys(MTLS_READERS));
  });

  it('keeps both allowlists to files that still read them', () => {
    const stale = [
      ...Object.keys(ADMIN_ACCESS_MODE_READERS).filter(
        (file) => !readers(ADMIN_ACCESS_MODE_READ).includes(file),
      ),
      ...Object.keys(MTLS_READERS).filter((file) => !readers(MTLS_READ).includes(file)),
    ];

    // An exemption that outlives its read is how the next one gets waved
    // through: drop the entry once the file stops reading the signal.
    expect(stale).toEqual([]);
  });
});

describe('admin mTLS claims in docs', () => {
  it('catches the claims these docs used to carry', () => {
    // The six sentences this scan exists to keep out, verbatim.
    const drift = [
      '- **Admin TLS**: `/admin/*` requires mTLS while `ADMIN_ACCESS_MODE=mtls` (default).',
      '- Admin endpoints require mTLS (`X-mTLS-Present` header) when `ADMIN_ACCESS_MODE=mtls` (default).',
      '- Admin routes are protected by mTLS (client certificates) when `ADMIN_ACCESS_MODE=mtls` (default).',
      '  - Enforces mTLS unless `ADMIN_ACCESS_MODE=none`.',
      '  - `mtls` (default): mTLS is required for `/admin/*` and login sits behind that TLS gate.',
      '- With `ADMIN_ACCESS_MODE=mtls` (default), passkey login still sits inside the mTLS gate.',
    ];
    expect(mtlsClaims('sample.md', drift.join('\n'))).toHaveLength(drift.length);

    // Attributing the gate to the proxy that performs it is the fix, not drift.
    expect(mtlsClaims('sample.md', 'Bundled Caddy requires a client certificate for `/admin*`.')).toEqual([]);
  });

  it('no longer claims the API itself requires mTLS for /admin', () => {
    const claims = DOC_NAMES.flatMap((name) => mtlsClaims(name, readFileSync(join(DOCS, name), 'utf8')));

    // `/admin/*` is gated by the admin session cookie (`requireAdmin`); the
    // certificate gate is the optional caddy profile, and ADMIN_ACCESS_MODE
    // only reaches the CLI-approval guard. Name the layer that enforces it.
    expect(claims).toEqual([]);
  });

  it('names the layer that does enforce client certificates', () => {
    const silent = DOC_NAMES.filter((name) => {
      const markdown = readFileSync(join(DOCS, name), 'utf8');
      return MTLS_TERM.test(markdown) && !PROXY_LAYER.test(markdown);
    });

    // A doc may drop the subject entirely, but one that still mentions client
    // certificates without naming the proxy leaves the reader guessing who
    // checks them.
    expect(silent).toEqual([]);
  });
});
