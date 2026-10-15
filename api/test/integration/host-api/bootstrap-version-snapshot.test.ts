import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { hosts, versions, authPayloads, authCanonicalHeads } from '../../../src/db/schema.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';
import { Keyring } from '../../../src/security/keyring.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { createRunnerValidationService } from '../../../src/services/runner-validation.js';
import { ServiceUnavailableError } from '../../../src/http/errors.js';
import { ClientVersionsService } from '../../../src/services/client-versions.js';
import { ProviderAccountsService } from '../../../src/services/provider-accounts.js';
import * as pooledAuth from '../../../src/services/pooled-auth-store.js';
import * as grokOwner from '../../../src/services/grok-auth-owner.js';
import * as wrapperProjection from '../../../src/services/wrapper-version-projection.js';
import type { Engine } from '../../../src/util/engine.js';

const apiKey = 'sk-bootstrap-version-snapshot';
const env = {
  INSTALLATION_ID: 'inst', ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  STATIC_ROOT: '', PUBLIC_BASE_URL: 'https://o.example',
} as Parameters<typeof buildHostApiTestApp>[0]['env'];
const createAuthStore = pooledAuth.createPooledAuthStoreService;
const candidate = { last_refresh: '2026-07-01T00:00:00Z', auths: { 'api.openai.com': { token: 'new-token', token_type: 'bearer' } } };

function fixture(engine: Engine, latest = false) {
  const db = createDbFake();
  db.tables.set(hosts, [{ id: 1, fqdn: 'host.example', apiKey, apiKeyHash: hashApiKey(apiKey),
    status: 'active', secure: 1, engines: 'codex,claude,grok', apiCalls: 0,
    autoUpdateOverride: null, reverseDnsMode: 0 }]);
  const runnerKey = engine === 'codex' ? 'runner_state' : `runner_state_${engine}`;
  const rows = [
    { name: `client_version_${engine}`, version: latest ? 'latest' : '2.1.300' },
    { name: runnerKey, version: 'ok' },
    { name: `github_release_${engine}-cli`, version: JSON.stringify({ version: '2.1.300' }) },
  ];
  db.tables.set(versions, rows);
  const payload = { engine, include_content: false, metadata_only: engine === 'grok' };
  const inject = { method: 'POST' as const, url: '/sync/bootstrap', headers: { authorization: `Bearer ${apiKey}` }, payload };
  const app = () => buildHostApiTestApp({ db: db as never, env, keyring: Keyring.fromEnv(env) });
  return { db, rows, runnerKey, inject, app };
}

afterEach(() => vi.restoreAllMocks());

describe('bootstrap request version snapshot', () => {
  it.each(['codex', 'claude', 'grok'] as const)('%s refreshes and projects once per request, including nested auth', async engine => {
    const f = fixture(engine, true);
    // The minimal Drizzle fake does not implement the unrelated pool-count join.
    if (engine === 'grok') vi.spyOn(ProviderAccountsService.prototype, 'countLeasable').mockResolvedValue(0);
    let expectedVersion = '2.1.301';
    const refresh = vi.spyOn(ClientVersionsService.prototype, 'availableClientVersion').mockImplementation(async (_force, requestedEngine) => {
      expect(requestedEngine).toBe(engine);
      f.rows.find(row => row.name === `github_release_${engine}-cli`)!.version = JSON.stringify({ version: expectedVersion });
      return null;
    });
    const projection = vi.spyOn(wrapperProjection, 'projectWrapperVersionSnapshot');
    const app = await f.app();
    try {
      for (const includeAuth of [false, true]) {
        const response = await app.inject({ ...f.inject, payload: { ...f.inject.payload, include_auth: includeAuth } });
        expect(response.statusCode, response.body).toBe(200);
        const body = response.json();
        expect(body.versions.client_version).toBe(expectedVersion);
        if (includeAuth) expect(body.auth.versions).toEqual(body.versions);
        else expect(body.auth).toBeUndefined();
        expectedVersion = '2.1.302';
      }
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(projection).toHaveBeenCalledTimes(2);
    } finally { await app.close(); }
  });

  it('also reuses the snapshot for a candidate already matching verified canonical auth', async () => {
    const f = fixture('codex', true);
    const keyring = Keyring.fromEnv(env);
    const validation = createRunnerValidationService({ db: f.db as never, keyring });
    const canonical = validation.canonicalizeAuthPayload(candidate,
      validation.normalizeAuthEntries(candidate, 'codex'), candidate.last_refresh, 'codex');
    const body = JSON.stringify(canonical);
    f.db.tables.set(authPayloads, [{ id: 71, engine: 'codex', body: encrypt(body, keyring),
      lastRefresh: candidate.last_refresh, sha256: validation.calculateDigest(body), generation: 1,
      verificationState: 'verified', verificationCheckedAt: candidate.last_refresh }]);
    f.db.tables.set(authCanonicalHeads, [{ engine: 'codex', payloadId: 71, generation: 1 }]);
    const refresh = vi.spyOn(ClientVersionsService.prototype, 'availableClientVersion').mockResolvedValue(null);
    const projection = vi.spyOn(wrapperProjection, 'projectWrapperVersionSnapshot');
    const store = vi.fn();
    vi.spyOn(pooledAuth, 'createPooledAuthStoreService').mockImplementation(deps => ({ ...createAuthStore(deps), storeCandidate: store }));
    const app = await f.app();
    try {
      const response = await app.inject({ ...f.inject, payload: { ...f.inject.payload, auth_candidate: candidate } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().auth.status).toBe('valid');
      expect(response.json().auth.versions).toEqual(response.json().versions);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(projection).toHaveBeenCalledTimes(1);
      expect(store).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('preserves refresh failures and re-reads on the next request', async () => {
    const f = fixture('codex', true);
    const refresh = vi.spyOn(ClientVersionsService.prototype, 'availableClientVersion')
      .mockRejectedValueOnce(new Error('release refresh failed')).mockResolvedValue(null);
    const app = await f.app();
    try {
      expect((await app.inject(f.inject)).statusCode).toBe(500);
      const response = await app.inject(f.inject);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().versions.client_version).toBe('2.1.300');
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally { await app.close(); }
  });

  it.each(['stored', 'rejected', 'projection retry'] as const)('re-reads after an auth candidate is %s', async outcome => {
    const f = fixture('codex');
    vi.spyOn(ProviderAccountsService.prototype, 'resolveCandidate').mockResolvedValue({ id: 2 } as never);
    const store = vi.fn(async () => {
      f.rows.find(row => row.name === f.runnerKey)!.version = 'fail';
      if (outcome === 'rejected') throw new ServiceUnavailableError('runner offline');
      return { status: 'updated' as const, engine: 'codex' as const, canonical_last_refresh: candidate.last_refresh,
        canonical_digest: 'a'.repeat(64), verification_state: 'verified' as const, pending_payload_id: 2, runner_applied: true };
    });
    vi.spyOn(pooledAuth, 'createPooledAuthStoreService').mockImplementation(deps => ({ ...createAuthStore(deps), storeCandidate: store }));
    const project = wrapperProjection.projectWrapperVersionSnapshot;
    const projection = vi.spyOn(wrapperProjection, 'projectWrapperVersionSnapshot').mockImplementationOnce(project);
    if (outcome === 'projection retry') projection.mockRejectedValueOnce(new Error('temporary artifact read failure'));
    projection.mockImplementation(project);
    const app = await f.app();
    try {
      const response = await app.inject({ ...f.inject, payload: { ...f.inject.payload, auth_candidate: candidate } });
      expect(response.statusCode, response.body).toBe(200);
      expect(store).toHaveBeenCalledTimes(1);
      const body = response.json();
      expect(body.versions.runner_state).toBe('ok');
      expect(body.auth.versions.runner_state).toBe('fail');
      expect(body.auth.status).toBe(outcome === 'stored' ? 'updated' : 'missing');
      expect(projection).toHaveBeenCalledTimes(outcome === 'projection retry' ? 3 : 2);
    } finally { await app.close(); }
  });

  it('refreshes the nested Grok version snapshot after ensureFresh', async () => {
    const f = fixture('grok');
    const ensureFresh = vi.fn(async () => {
      f.rows.find(row => row.name === f.runnerKey)!.version = 'fail';
      return { row: { id: 3 }, auth: {}, digest: 'b'.repeat(64), last_refresh: candidate.last_refresh,
        canonical_generation: 3, access_token_digest: 'c'.repeat(64), expires_at: '2030-01-01T00:00:00Z', refresh_state: 'idle' };
    });
    vi.spyOn(grokOwner, 'createGrokAuthOwner').mockReturnValue({ ensureFresh } as never);
    const projection = vi.spyOn(wrapperProjection, 'projectWrapperVersionSnapshot');
    const app = await f.app();
    try {
      const response = await app.inject({ ...f.inject, payload: { ...f.inject.payload, metadata_only: false } });
      expect(response.statusCode, response.body).toBe(200);
      expect(ensureFresh).toHaveBeenCalledTimes(1);
      expect(response.json().versions.runner_state).toBe('ok');
      expect(response.json().auth.versions.runner_state).toBe('fail');
      expect(projection).toHaveBeenCalledTimes(2);
    } finally { await app.close(); }
  });
});
