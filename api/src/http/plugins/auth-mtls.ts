import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { Env } from '../../env.js';
import { parseMtls, type MtlsClaims } from '../../security/mtls.js';
import { makeTrustedProxyCheck } from './client-ip.js';

declare module 'fastify' {
  interface FastifyRequest {
    mtls: MtlsClaims;
  }
}

const ABSENT: MtlsClaims = Object.freeze({ present: false });

/**
 * Publishes whatever client-certificate claims a reverse proxy in front of this
 * server attached to the request, and nothing else. This server does not
 * terminate mTLS, does not issue client certificates and does not verify them —
 * that is the proxy's job, and `X-MTLS-*` is how the proxy reports the result.
 *
 * Which means the headers are only worth as much as the hop that set them. A
 * direct caller can type `X-MTLS-Fingerprint` as easily as our edge can, so the
 * claims are populated only when the connecting peer is inside
 * `TRUSTED_PROXY_CIDRS` — the same gate `client-ip` applies to
 * `X-Forwarded-For`, for the same reason. Everyone else gets `present: false`
 * regardless of what they sent.
 *
 * With `TRUST_X_FORWARDED=0` (the default) that is *every* caller, so a server
 * with no proxy configured sees no claims at all. Correct: with nothing in front
 * verifying certificates, any claim reaching this process is unfounded.
 */
export function makeAuthMtlsPlugin(env: Env) {
  const fromTrustedProxy = makeTrustedProxyCheck(env);

  return fp(
    async function authMtlsPlugin(app: FastifyInstance) {
      app.decorateRequest('mtls', null as unknown as MtlsClaims);
      app.addHook('onRequest', async (req) => {
        req.mtls = fromTrustedProxy(req) ? parseMtls(req) : ABSENT;
      });
    },
    { name: 'auth-mtls' },
  );
}
