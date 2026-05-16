import { describe, expect, it } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbShim } from '../../helpers/db-shim.js';
import { versions as versionsTable } from '../../../src/db/schema.js';
import { Keyring } from '../../../src/security/keyring.js';

const env = {
  INSTALLATION_ID: 'inst-test',
  ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', // 32 bytes b64
  INSECURE_GRACE_MINUTES: 60,
  PUBLIC_BASE_URL: 'https://orchestrator.example',
  STATIC_ROOT: '',
  ADMIN_ACCESS_MODE: 'open',
} as unknown as Parameters<typeof buildHostApiTestApp>[0]['env'];

describe('GET /versions', () => {
  it('returns the version snapshot when api_disabled is off', async () => {
    const db = createDbShim();
    db.tables.set(versionsTable, [
      { name: 'client_version_codex', version: '0.42.0' },
      { name: 'wrapper_version_codex', version: '1.0.0' },
      { name: 'auto_update_enabled', version: '1' },
    ]);
    const keyring = makeKeyring();
    const app = await buildHostApiTestApp({ db: db as any, env, keyring });
    const r = await app.inject({ method: 'GET', url: '/versions' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.status).toBe('ok');
    expect(body.client_version).toBe('0.42.0');
    expect(body.wrapper_version).toBe('1.0.0');
    expect(body.auto_update_enabled).toBe(true);
    expect(body.installation_id).toBe('inst-test');
    await app.close();
  });

  it('returns 503 when api_disabled is on', async () => {
    const db = createDbShim();
    db.tables.set(versionsTable, [{ name: 'api_disabled', version: '1' }]);
    const keyring = makeKeyring();
    const app = await buildHostApiTestApp({ db: db as any, env, keyring });
    const r = await app.inject({ method: 'GET', url: '/versions' });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.payload)).toMatchObject({ status: 'error', code: 'api_disabled' });
    await app.close();
  });
});

function makeKeyring(): Keyring {
  process.env.ENCRYPTION_ACTIVE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  return Keyring.fromEnv({
    ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    AUTH_ENCRYPTION_KEY: undefined,
  } as unknown as Parameters<typeof Keyring.fromEnv>[0]);
}
