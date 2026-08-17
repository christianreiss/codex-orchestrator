import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { discoverFixtures, FIXTURE_ROOT, fixtureLabel, loadFixture, replayFixture } from './helpers/replay.js';
import { buildHostApiTestApp } from '../helpers/build-host-api-app.js';
import { createDbFake } from '../helpers/db-fake.js';
import { assertContract, compileContract } from '../helpers/contract-schema.js';
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

const CONTRACT_ROOT = resolve(import.meta.dirname, '..', '..', '..', 'docs', 'contracts');
/** The `Current schemas:` bullets of `docs/contracts/README.md`. */
const CONTRACT_DOC = resolve(CONTRACT_ROOT, 'README.md');
/** The `Current coverage` table of this suite's own README. */
const SUITE_DOC = resolve(import.meta.dirname, 'README.md');

/**
 * Every published schema, read off `docs/contracts/`. The inventory is the
 * directory, not a list beside it: a schema that lands there is compiled and
 * demands a fixture from the moment it is checked in.
 */
const contractSchemas = readdirSync(CONTRACT_ROOT)
  .filter((entry) => entry.endsWith('.schema.json'))
  .sort();

/**
 * Fixture label (path under `fixtures/`, no extension) → published schema. The
 * schema is validated against the *replayed* body, not the recorded one, so a
 * schema that describes a body the route no longer serves fails here even with
 * TEST_USE_DB unset. The pairing is one-to-one with `contractSchemas` and is
 * mirrored by both README tables; the scans below hold all three together.
 */
const fixtureContracts: Record<string, string> = {
  'auth/retrieve': 'auth-retrieve.schema.json',
  'auth/store': 'auth-store.schema.json',
  'sync/bootstrap': 'sync-bootstrap.schema.json',
  'sync/status': 'sync-status.schema.json',
  'versions/snapshot': 'versions.schema.json',
};

/** A `Current schemas:` bullet: the schema file, then its prose. */
const DOC_SCHEMA_BULLET = /^- `([^`]+\.schema\.json)`/;
/** A `Current coverage` row: fixture file, endpoint, published schema. */
const COVERAGE_ROW = /^\| `([^`]+\.json)` \| .* \| `([^`]+\.schema\.json)` \|$/;

/** The schema files `docs/contracts/README.md` advertises, sorted. */
function collectDocSchemas(): string[] {
  const out: string[] = [];
  let inList = false;
  for (const line of readFileSync(CONTRACT_DOC, 'utf8').split('\n')) {
    if (line.startsWith('Current schemas:')) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const bullet = DOC_SCHEMA_BULLET.exec(line);
    if (!bullet) break; // the list ends at the first non-bullet line
    out.push(bullet[1]!);
  }
  return out.sort();
}

/** Fixture label → published schema, as this suite's README pairs them. */
function collectCoveragePairs(): Record<string, string> {
  const out: Record<string, string> = {};
  let inTable = false;
  for (const line of readFileSync(SUITE_DOC, 'utf8').split('\n')) {
    if (line.startsWith('## ')) inTable = line.startsWith('## Current coverage');
    if (!inTable) continue;
    const row = COVERAGE_ROW.exec(line);
    if (row) out[row[1]!.replace(/\.json$/, '')] = row[2]!;
  }
  return out;
}

const docSchemas = collectDocSchemas();
const coveragePairs = collectCoveragePairs();

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
'codex',
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

  it('reads the inventory it is meant to check', () => {
    // A scan that silently matched nothing would pass the assertions below.
    expect(contractSchemas).toContain('versions.schema.json');
    expect(docSchemas.length, `${CONTRACT_DOC} has no Current schemas: bullets`).toBeGreaterThan(0);
    expect(
      Object.keys(coveragePairs).length,
      `${SUITE_DOC} has no Current coverage rows`,
    ).toBeGreaterThan(0);
  });

  it('is listed in docs/contracts/README.md exactly as it sits on disk', () => {
    expect(docSchemas, 'the Current schemas: bullets and docs/contracts/ disagree').toEqual(
      contractSchemas,
    );
  });

  it('is named by the Current coverage table exactly as it sits on disk', () => {
    const published = [...new Set(Object.values(coveragePairs))].sort();
    expect(published, 'the Published schema column and docs/contracts/ disagree').toEqual(
      contractSchemas,
    );
  });

  it('is paired with fixtures identically in the Current coverage table', () => {
    expect(coveragePairs, 'the Current coverage table and fixtureContracts disagree').toEqual(
      fixtureContracts,
    );
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

  it('has exactly one checked-in fixture for every published contract', () => {
    const labels = fixtures.map(fixtureLabel);
    for (const schema of contractSchemas) {
      const mapped = Object.keys(fixtureContracts).filter((label) => fixtureContracts[label] === schema);
      expect(mapped, `${schema} must map to exactly one fixture`).toHaveLength(1);
      expect(labels, `${schema} maps to a fixture that is not checked in`).toContain(mapped[0]);
    }
  });

  for (const fixturePath of fixtures) {
    const label = fixtureLabel(fixturePath);
    it(label, async () => {
      const fixture = loadFixture(fixturePath);
      const { db, keyring } = seedContractWorld();
      const app = await buildHostApiTestApp({ db: db as never, env, keyring });
      try {
        const body = await replayFixture(app, fixture);
        const schema = fixtureContracts[label];
        expect(schema, `${label} is checked in but maps to no published schema`).toBeTypeOf('string');
        assertContract(schema!, body);
      } finally {
        await app.close();
      }
    });
  }
});
