import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { hosts as hostsTable, logs as logsTable, versions as versionsTable } from '../../../src/db/schema.js';
import { Keyring } from '../../../src/security/keyring.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';
import { WRAPPER_ROLLOUT_KEY, resetWrapperRolloutCache } from '../../../src/services/wrapper-rollout.js';

/**
 * /cron/check under a staged cxx rollout: a held host is offered the build it
 * already runs, an admitted one the new release, and the feature flag is a
 * kill switch over any stored rollout.
 */

const baseEnv = {
  INSTALLATION_ID: 'inst-rollout',
  ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  INSECURE_GRACE_MINUTES: 60,
  STATIC_ROOT: '',
  ADMIN_ACCESS_MODE: 'open',
  PUBLIC_BASE_URL: 'https://orchestrator.example',
} as unknown as Parameters<typeof buildHostApiTestApp>[0]['env'];

afterEach(() => resetWrapperRolloutCache());

describe('POST /cron/check with a staged cxx rollout', () => {
  it.each([
    { enabled: true, hostId: 1, action: 'update', target: '0.9.81' },
    { enabled: true, hostId: 2, action: 'no_update', target: '0.9.80' },
    { enabled: false, hostId: 2, action: 'update', target: '0.9.81' },
  ])('flag $enabled, host $hostId -> $action $target', async ({ enabled, hostId, action, target }) => {
    await withArtifacts(async ({ dataRoot, sha }) => {
      const apiKey = `sk-rollout-${hostId}-${enabled}`;
      const db = createDbFake();
      db.tables.set(hostsTable, [hostRow(apiKey, hostId)]);
      db.tables.set(versionsTable, [
        { name: 'wrapper_version_codex', version: '0.9.81' },
        { name: 'auto_update_enabled', version: '1' },
        {
          name: WRAPPER_ROLLOUT_KEY,
          version: JSON.stringify({
            id: 'r1', target_version: '0.9.81', from_version: '0.9.80',
            stages: [{ kind: 'canary' }, { kind: 'percent', percent: 100 }],
            stage_index: 0, stage_started_at: new Date().toISOString(), soak_minutes: 30,
            status: 'active', halted_reason: null, admitted_host_ids: [1],
            started_at: new Date().toISOString(), updated_at: new Date().toISOString(), history: [],
          }),
        },
      ]);
      db.tables.set(logsTable, []);
      const app = await buildHostApiTestApp({
        db: db as never,
        env: { ...baseEnv, DATA_ROOT: dataRoot, CXX_WRAPPER_ROLLOUT_ENABLED: enabled } as typeof baseEnv,
        keyring: makeKeyring(),
      });
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/cron/check',
          headers: { authorization: `Bearer ${apiKey}`, 'x-wrapper-platform': 'linux-amd64' },
          payload: { engine: 'codex', wrapper_version: '0.9.80', probe: true },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().wrapper).toMatchObject({ action, target_version: target, sha256: sha[target] });
      } finally {
        await app.close();
      }
    });
  });
});

function hostRow(apiKey: string, id: number) {
  return {
    id,
    fqdn: `rollout-${id}.example`,
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
    wrapperTrack: 'v2', wrapperCanary: 0, internalRole: null,
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
    autoUpdateOverride: null,
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

async function withArtifacts(
  run: (artifact: { dataRoot: string; sha: Record<string, string> }) => Promise<void>,
): Promise<void> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'host-wrapper-rollout-'));
  const platformDir = join(dataRoot, 'wrapper', 'v2', 'bin', 'cxx', 'linux-amd64');
  const sha: Record<string, string> = {};
  const builds = [];
  for (const version of ['0.9.80', '0.9.81']) {
    const payload = `cxx linux amd64 ${version}`;
    sha[version] = createHash('sha256').update(payload).digest('hex');
    const binaryPath = join(platformDir, `v${version}`, 'cxx');
    await mkdir(dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, payload);
    builds.push({ version, sha256: sha[version], size_bytes: Buffer.byteLength(payload) });
  }
  await writeFile(
    join(platformDir, 'manifest.json'),
    JSON.stringify({ engine: 'cxx', os: 'linux', arch: 'amd64', current: '0.9.81', builds }),
  );
  try {
    await run({ dataRoot, sha });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}
