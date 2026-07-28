import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { discoverFixtures, FIXTURE_ROOT, fixtureLabel, loadFixture, replayFixture } from './helpers/replay.js';
import { buildHostApiTestApp } from '../helpers/build-host-api-app.js';
import { createDbFake } from '../helpers/db-fake.js';
import { compileContract } from '../helpers/contract-schema.js';
import {
  authCanonicalHeads,
  authPayloads,
  hosts as hostsTable,
  versions as versionsTable,
} from '../../src/db/schema.js';
import { Keyring } from '../../src/security/keyring.js';
import { encrypt } from '../../src/security/secret-box.js';
import { hashApiKey } from '../../src/util/api-key-helpers.js';
import { createRunnerValidationService } from '../../src/services/runner-validation.js';

/**
 * Contract suite — walks every fixture under `test/contract/fixtures/`,
 * replays it against the host-api app on the db-fake, and asserts the response
 * shape matches the recorded envelope and key set. Fixtures are checked in as
 * the contract evolves; there is no automated recorder, so a fixture that no
 * longer matches means either the route drifted or the fixture is stale.
 *
 * Every fixture is replayed against the same seeded world, described by
 * `seedContractWorld()`: one dual-engine host holding `CONTRACT_API_KEY`, a
 * published version snapshot, and a verified Codex canonical payload that is
 * newer than the host's (absent) local copy.
 */

const fixtures = discoverFixtures(FIXTURE_ROOT);

const contractSchemas = [
  'auth-retrieve.schema.json',
  'auth-store.schema.json',
  'sync-bootstrap.schema.json',
  'sync-status.schema.json',
  'versions.schema.json',
] as const;

const CONTRACT_API_KEY = 'sk-contract-fixture';
const CANONICAL_STAMP = '2026-06-08T15:26:33Z';

const env = {
  INSTALLATION_ID: 'inst-contract',
  ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  INSECURE_GRACE_MINUTES: 60,
  STATIC_ROOT: '',
  ADMIN_ACCESS_MODE: 'open',
  PUBLIC_BASE_URL: 'https://o.example',
  AUTH_RUNNER_URL: 'https://runner.example/verify',
  AUTH_RUNNER_TIMEOUT: 2,
} as unknown as Parameters<typeof buildHostApiTestApp>[0]['env'];

function makeKeyring(): Keyring {
  return Keyring.fromEnv({
    ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  } as unknown as Parameters<typeof Keyring.fromEnv>[0]);
}

function hostRow(): Record<string, unknown> {
  return {
    id: 1,
    fqdn: 'contract.example',
    apiKey: CONTRACT_API_KEY,
    apiKeyHash: hashApiKey(CONTRACT_API_KEY),
    apiKeyEnc: null,
    status: 'active',
    secure: 1,
    allowRoamingIps: 0,
    reverseDnsMode: null,
    apiCalls: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
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

function seedContractWorld(): { db: ReturnType<typeof createDbFake>; keyring: Keyring } {
  const keyring = makeKeyring();
  const db = createDbFake();
  db.tables.set(hostsTable, [hostRow()]);
  db.tables.set(versionsTable, [
    { name: 'client_version_codex', version: '0.42.0' },
    { name: 'wrapper_version_codex', version: '1.0.0' },
    { name: 'auto_update_enabled', version: '1' },
  ]);
  const validation = createRunnerValidationService({ db: db as never, keyring });
  const auths = { 'api.openai.com': { token: 'verified-token', token_type: 'bearer' } };
  const canonical = validation.canonicalizeAuthPayload(
    { auths },
    validation.normalizeAuthEntries({ auths }, 'codex'),
    CANONICAL_STAMP,
  );
  const encoded = JSON.stringify(canonical);
  db.tables.set(authPayloads, [
    {
      id: 71,
      lastRefresh: CANONICAL_STAMP,
      sha256: createHash('sha256').update(encoded).digest('hex'),
      sourceHostId: null,
      createdAt: CANONICAL_STAMP,
      body: encrypt(encoded, keyring),
      verificationState: 'verified',
      verificationCheckedAt: CANONICAL_STAMP,
      verificationReason: null,
      engine: 'codex',
      generation: 1,
    },
  ]);
  db.tables.set(authCanonicalHeads, [
    { engine: 'codex', payloadId: 71, generation: 1, updatedAt: CANONICAL_STAMP },
  ]);
  return { db, keyring };
}

describe('published JSON schemas', () => {
  it.each(contractSchemas)('%s compiles as JSON Schema 2020-12', (name) => {
    expect(compileContract(name)).toBeTypeOf('function');
  });
});

describe('contract suite', () => {
  beforeEach(() => {
    // The store fixture needs a live verdict before canonical auth can move,
    // and retrieve re-checks a stale verification stamp; a healthy runner keeps
    // both paths on their success branch without a network call.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'ok', reachable: true }), { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has a fixture checked in for every published contract', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(contractSchemas.length);
  });

  for (const fixturePath of fixtures) {
    const label = fixtureLabel(fixturePath);
    it(label, async () => {
      const fixture = loadFixture(fixturePath);
      const { db, keyring } = seedContractWorld();
      const app = await buildHostApiTestApp({ db: db as never, env, keyring });
      try {
        await replayFixture(app, fixture);
      } finally {
        await app.close();
      }
    });
  }
});
