import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../../../src/env.js';
import type { AdminContext } from '../../../src/http/plugins/auth-admin.js';
import { registerCliAuthRoutes } from '../../../src/routes/cli-auth/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';

/**
 * `GET /cli/auth/verify` used to read `<STATIC_ROOT>/cli-auth-verify.html` — a
 * file no build step produces — so it always fell into its catch and answered
 * 404, and every operator following the `verify_url` a `cdx`/`clx` device-code
 * login prints landed on a dead page. The approval form is a SPA route
 * (`frontend/src/routes/cli-auth/verify/+page.svelte`, served under the SPA's
 * `/admin` base), and nothing drove this handler, so these cases pin both the
 * redirect target and the admin gate in front of it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY_PAGE = resolve(HERE, '../../../..', 'frontend/src/routes/cli-auth/verify/+page.svelte');

/** Only its presence opens the gate; the handler reads no field of it. */
const ADMIN = {} as AdminContext;

interface VerifyOptions {
  publicBaseUrl?: string;
  adminAccessMode?: Env['ADMIN_ACCESS_MODE'];
  /** Left out for the anonymous browser that has no admin session yet. */
  admin?: AdminContext;
}

async function getVerify(options: VerifyOptions = {}) {
  const app = await buildRouteApp();
  const admin = options.admin;
  if (admin) app.resolveAdmin = async () => admin;
  const env = {
    PUBLIC_BASE_URL: options.publicBaseUrl,
    ADMIN_ACCESS_MODE: options.adminAccessMode ?? 'mtls',
  } as Env;
  // The verify handler touches neither the DB nor the keyring; the services
  // this registrar builds only capture them.
  await registerCliAuthRoutes(app, { db: {} as never, env, keyring: {} as never } as RouteContext);
  const response = await app.inject({ method: 'GET', url: '/cli/auth/verify' });
  await app.close();
  return response;
}

describe('GET /cli/auth/verify', () => {
  it('redirects to the SPA approval page under PUBLIC_BASE_URL', async () => {
    const response = await getVerify({ publicBaseUrl: 'https://codex-auth.uggs.io', admin: ADMIN });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('https://codex-auth.uggs.io/admin/cli-auth/verify');
  });

  it('redirects to the relative SPA path when PUBLIC_BASE_URL is unset', async () => {
    const response = await getVerify({ admin: ADMIN });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/admin/cli-auth/verify');
  });

  it('401s an anonymous browser unless ADMIN_ACCESS_MODE is open', async () => {
    const response = await getVerify({ publicBaseUrl: 'https://codex-auth.uggs.io' });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.payload)).toMatchObject({ status: 'error', code: 'admin_required' });
    expect(response.headers.location).toBeUndefined();
  });

  it('redirects an anonymous browser when ADMIN_ACCESS_MODE is open', async () => {
    const response = await getVerify({ adminAccessMode: 'open' });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/admin/cli-auth/verify');
  });

  it('points at a page the frontend still ships', () => {
    // A redirect to a route the SPA does not define is the same dead end the
    // missing HTML file was.
    expect(existsSync(VERIFY_PAGE), `${VERIFY_PAGE} is missing`).toBe(true);
  });
});
