import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import {
  authCanonicalHeads,
  authEntries,
  authPayloads,
  chatgptUsageSnapshots,
  hostAuthDigests,
  hostAuthStates,
  hosts as hostsTable,
  logs as logsTable,
  versions as versionsTable,
} from '../../../src/db/schema.js';
import { Keyring } from '../../../src/security/keyring.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';

const baseEnv = {
  INSTALLATION_ID: 'inst-platform',
  ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  INSECURE_GRACE_MINUTES: 60,
  STATIC_ROOT: '',
  ADMIN_ACCESS_MODE: 'open',
  PUBLIC_BASE_URL: 'https://orchestrator.example',
} as unknown as Parameters<typeof buildHostApiTestApp>[0]['env'];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('host API wrapper platform projection', () => {
  it.each(['/auth', '/sync/status', '/sync/bootstrap'])(
    'projects Darwin arm64 cxx metadata on %s',
    async (url) => {
      await withDarwinArtifact(async ({ dataRoot, sha256 }) => {
        const apiKey = `sk-platform-${url.replaceAll('/', '-')}`;
        const db = seedDb(apiKey);
        const app = await buildHostApiTestApp({
          db: db as never,
          env: { ...baseEnv, DATA_ROOT: dataRoot },
          keyring: makeKeyring(),
        });
        try {
          const payload =
            url === '/auth'
              ? { command: 'retrieve', engine: 'codex', wrapper_version: '1.9.0' }
              : {
                  engine: 'codex',
                  wrapper_version: '1.9.0',
                  include_auth: true,
                };
          const response = await app.inject({
            method: 'POST',
            url,
            headers: {
              authorization: `Bearer ${apiKey}`,
              'content-type': 'application/json',
              'x-wrapper-platform': 'darwin-arm64',
            },
            payload: JSON.stringify(payload),
          });
          expect(response.statusCode).toBe(200);
          const body = JSON.parse(response.payload);
          const expected = {
            wrapper_version: '2.0.0',
            wrapper_sha256: sha256,
            wrapper_url:
              'https://orchestrator.example/wrapper/v2/bin/cxx/darwin-arm64/v2.0.0/cxx',
          };
          expect(body.versions).toMatchObject(expected);
          if (url !== '/auth') expect(body.auth.versions).toMatchObject(expected);
        } finally {
          await app.close();
        }
      });
    },
  );

  it('projects Darwin arm64 cxx metadata on a successful auth store response', async () => {
    await withDarwinArtifact(async ({ dataRoot, sha256 }) => {
      const apiKey = 'sk-platform-auth-store';
      const db = seedDb(apiKey);
      const env = {
        ...baseEnv,
        DATA_ROOT: dataRoot,
        AUTH_RUNNER_URL: 'https://runner.example/verify',
        AUTH_RUNNER_TIMEOUT: 2,
      } as typeof baseEnv;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify({ status: 'ok', reachable: true }), { status: 200 }),
        ),
      );
      const app = await buildHostApiTestApp({ db: db as never, env, keyring: makeKeyring() });
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/auth',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'x-wrapper-platform': 'darwin-arm64',
          },
          payload: JSON.stringify({
            command: 'store',
            engine: 'codex',
            wrapper_version: '1.9.0',
            auth: {
              last_refresh: new Date().toISOString(),
              tokens: {
                access_token: 'sk-openai-platform-specific-valid-token',
                refresh_token: 'platform-specific-refresh-token',
              },
            },
          }),
        });
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload).versions).toMatchObject({
          wrapper_version: '2.0.0',
          wrapper_sha256: sha256,
          wrapper_url:
            'https://orchestrator.example/wrapper/v2/bin/cxx/darwin-arm64/v2.0.0/cxx',
        });
      } finally {
        await app.close();
      }
    });
  });
});

function seedDb(apiKey: string) {
  const db = createDbFake();
  db.tables.set(hostsTable, [hostRow(apiKey)]);
  db.tables.set(versionsTable, [
    { name: 'client_version_codex', version: '0.130.0' },
    { name: 'wrapper_version_codex', version: '2.0.0' },
    // Deliberately Linux/stale: request projection must replace both fields.
    { name: 'wrapper_sha256_codex', version: 'a'.repeat(64) },
    {
      name: 'wrapper_url_codex',
      version: 'https://orchestrator.example/wrapper/v2/bin/cxx/linux-amd64/v2.0.0/cxx',
    },
    { name: 'auto_update_enabled', version: '1' },
  ]);
  db.tables.set(authPayloads, []);
  db.tables.set(authCanonicalHeads, []);
  db.tables.set(authEntries, []);
  db.tables.set(hostAuthDigests, []);
  db.tables.set(hostAuthStates, []);
  db.tables.set(logsTable, []);
  db.tables.set(chatgptUsageSnapshots, []);
  return db;
}

function hostRow(apiKey: string) {
  return {
    id: 41,
    fqdn: 'darwin-arm64.example',
    apiKey,
    apiKeyHash: hashApiKey(apiKey),
    apiKeyEnc: null,
    status: 'active',
    secure: 1,
    allowRoamingIps: 0,
    reverseDnsMode: null,
    apiCalls: 0,
    createdAt: '2026-07-29T00:00:00Z',
    updatedAt: '2026-07-29T00:00:00Z',
    engines: 'codex,claude',
    vip: 0,
    scalingExempt: 0,
    curlInsecure: 0,
    browserosMcpEnabled: 0,
    configVersion: 0,
    wrapperTrack: 'v2',
    lastRefresh: null,
    authDigest: null,
    ip4: null,
    ip6: null,
    insecureEnabledUntil: null,
    insecureGraceUntil: null,
    insecureWindowMinutes: null,
    insecureRequestedAt: null,
    lanePreference: null,
    modelOverride: null,
    reasoningEffortOverride: null,
    autoUpdateOverride: 0,
    lastCronCheck: null,
    claudeLastRefresh: null,
    claudeClientVersion: null,
    claudeClientVersionOverride: null,
    claudeWrapperVersion: null,
    claudeAuthDigest: null,
    claudeModelOverride: null,
    claudeReasoningEffortOverride: null,
    clientVersion: null,
    clientVersionOverride: null,
    wrapperVersion: null,
    agentsDocumentIdOverride: null,
  };
}

function makeKeyring(): Keyring {
  return Keyring.fromEnv({
    ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  } as unknown as Parameters<typeof Keyring.fromEnv>[0]);
}

async function withDarwinArtifact(
  run: (artifact: { dataRoot: string; sha256: string }) => Promise<void>,
): Promise<void> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'host-platform-projection-'));
  const payload = 'cxx darwin arm64 binary';
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const binaryPath = join(
    dataRoot,
    'wrapper',
    'v2',
    'bin',
    'cxx',
    'darwin-arm64',
    'v2.0.0',
    'cxx',
  );
  await mkdir(dirname(binaryPath), { recursive: true });
  await writeFile(binaryPath, payload);
  await writeFile(
    join(dataRoot, 'wrapper', 'v2', 'bin', 'cxx', 'darwin-arm64', 'manifest.json'),
    JSON.stringify({
      engine: 'cxx',
      os: 'darwin',
      arch: 'arm64',
      current: '2.0.0',
      builds: [{ version: '2.0.0', sha256, size_bytes: Buffer.byteLength(payload) }],
    }),
  );
  try {
    await run({ dataRoot, sha256 });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}
