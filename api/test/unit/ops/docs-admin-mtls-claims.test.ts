import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Six shipped docs used to tell operators that `/admin/*` is gated on a client
 * certificate by the app whenever `ADMIN_ACCESS_MODE=mtls` (the default). It
 * never was: the app has no client-certificate check at all, and the real
 * certificate gate was `caddy/Caddyfile` -- a compose profile a plain
 * `docker compose up` does not start. An operator who believed the docs left
 * `/admin` reachable with a session cookie alone.
 *
 * So this scan keeps the docs describing the layering that exists.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const DOCS = resolve(ROOT, 'docs');

const DOC_NAMES = ['API.md', 'interface-api.md', 'ADMIN.md', 'LOGIN.md', 'USAGE.md', 'INSTALL.md'] as const;

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
    // certificate gate, if any, is a proxy in front. Name the layer that enforces it.
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
