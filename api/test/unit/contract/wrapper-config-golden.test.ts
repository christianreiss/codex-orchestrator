import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto';
import { getTableName, type Table } from 'drizzle-orm';

import type { Host } from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/client.js';
import type { Keyring } from '../../../src/security/keyring.js';
import type { Engine } from '../../../src/util/engine.js';
import {
  createWrapperConfigService,
  WRAPPER_CONFIG_TTL_SECONDS,
  type BakeResult,
  type BakePlatform,
} from '../../../src/services/wrapper-config.js';
import type {
  WrapperSigner,
  WrapperSigningKeyService,
} from '../../../src/services/wrapper-signing-key.js';
import type {
  WrapperBinRegistry,
  BinaryBuild,
  PlatformManifest,
} from '../../../src/services/wrapper-bin-registry.js';

/**
 * Golden round-trip fixtures for the baked per-host config.
 *
 * This side owns the bytes: it bakes three deliberately-shaped configs with
 * every input frozen and asserts `BakeResult.canonicalJson` is byte-identical
 * to `wrappers/testdata/host-*.json`, and that the primary signature is
 * byte-identical to the `.sig` sidecar. `wrappers/cxx/internal/config`
 * consumes the same files and verifies the signature for real.
 *
 * Nothing is stripped before comparing, because nothing is left unfrozen:
 * stripping `issued_at` would not be enough anyway — `etag` is a SHA-256 over
 * canonical JSON that contains `issued_at` and `config_version`.
 *
 * Regenerate with `UPDATE_GOLDEN=1 npx vitest run test/unit/contract/wrapper-config-golden.test.ts`.
 * Never hand-edit a fixture. See `wrappers/testdata/README.md` for the full
 * determinism contract.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const TESTDATA = resolve(ROOT, 'wrappers/testdata');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/**
 * Frozen bake instant. Deliberately in the past: with the 30-day TTL every
 * fixture is expired by construction, so the Go loader always takes the same
 * branch instead of changing behaviour on a calendar date.
 */
const ISSUED_AT = '2026-01-15T00:00:00Z';
const EXPIRES_AT = '2026-02-14T00:00:00Z';

const INSTALLATION_ID = 'golden-installation-0001';
const PUBLIC_BASE_URL = 'https://orchestrator.example.com';
const PLATFORM: BakePlatform = { os: 'linux', arch: 'amd64' };
const WRAPPER_VERSION = '2.4.0';
const WRAPPER_SHA256 = 'b1'.repeat(32);
const AGENTS_SHA256 = 'c2'.repeat(32);
const CLIENT_CONFIG_SHA256 = 'd3'.repeat(32);

/**
 * TEST-ONLY Ed25519 seed, checked in beside the fixtures. Ed25519 signing is
 * deterministic (RFC 8032), so the same bytes under the same seed always give
 * the same signature — that is what makes the `.sig` sidecars golden too.
 * Production keys live encrypted in `wrapper_signing_keys` and never here.
 */
function goldenSigner(kid: string): WrapperSigner {
  const seed = Buffer.from(
    readFileSync(resolve(TESTDATA, 'signing-seed.TEST-ONLY.txt'), 'utf8').trim(),
    'base64',
  );
  // PKCS#8 wrapper for a raw Ed25519 seed: node:crypto has no seed importer.
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as { x?: string };
  const raw = Buffer.from(jwk.x!.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return {
    kid,
    fingerprint: createHash('sha256').update(raw).digest('hex'),
    publicKey: raw.toString('base64'),
    sign(payload) {
      const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
      return cryptoSign(null, buf, privateKey);
    },
  };
}

function signingService(...signers: WrapperSigner[]): WrapperSigningKeyService {
  return {
    async active() {
      return signers[0] ?? null;
    },
    async allActive() {
      return [...signers];
    },
    async available() {
      return signers.length > 0;
    },
    invalidate() {},
  };
}

/** Frozen registry: one build, one platform, so `wrapper.*` never moves. */
function fakeBinaries(): WrapperBinRegistry {
  const build: BinaryBuild = {
    version: WRAPPER_VERSION,
    sha256: WRAPPER_SHA256,
    size_bytes: 8_388_608,
  };
  return {
    async manifestForPlatform(): Promise<PlatformManifest | null> {
      return null;
    },
    async currentBuild() {
      return build;
    },
    async resolveCurrentBuild() {
      return { ...build, artifact: 'cxx', path: '/fixtures/cxx' };
    },
    async resolveVersion() {
      return { ...build, artifact: 'cxx', path: '/fixtures/cxx' };
    },
    async latestVersion() {
      return WRAPPER_VERSION;
    },
    async engineManifest() {
      return { engine: 'codex', platforms: {} };
    },
    async binaryDescriptor() {
      return null;
    },
    async openBinary() {
      throw new Error('not implemented');
    },
    invalidate() {},
  };
}

interface FakeRows {
  /** `hosts.config_version` BEFORE the bake; the payload carries this + 1. */
  configVersion: number;
  agentsDocumentId: number | null;
  clientConfigId: number | null;
  skills: Array<{ slug: string; sha256: string; deletedAt: string | null; engine: string | null }>;
  /** Raw `versions.agent_messaging_enabled` value, or null for "row absent". */
  agentMessagingFlag: string | null;
}

/**
 * Fake DB dispatching on the queried table. Row order is fixed here because the
 * payload preserves `skills` array order — see the note in
 * `wrappers/testdata/README.md`.
 */
function fakeDb(rows: FakeRows): Database {
  const rowsFor: Record<string, unknown[]> = {
    hosts: [{ configVersion: rows.configVersion }],
    agents_document_state: [
      { id: 1, mode: 'active', activeDocumentId: rows.agentsDocumentId, engine: 'codex' },
    ],
    agents_documents:
      rows.agentsDocumentId === null
        ? []
        : [
            {
              id: rows.agentsDocumentId,
              sha256: AGENTS_SHA256,
              updatedAt: '2026-01-02T00:00:00Z',
            },
          ],
    client_config_documents:
      rows.clientConfigId === null
        ? []
        : [
            {
              id: rows.clientConfigId,
              sha256: CLIENT_CONFIG_SHA256,
              updatedAt: '2026-01-03T00:00:00Z',
            },
          ],
    skills: rows.skills,
    versions:
      rows.agentMessagingFlag === null ? [] : [{ version: rows.agentMessagingFlag }],
  };

  const chain = () => {
    let selected: unknown[] = [];
    const self = {
      from(table: unknown) {
        selected = rowsFor[getTableName(table as Table)] ?? [];
        return self;
      },
      where() {
        return self;
      },
      orderBy() {
        return self;
      },
      for() {
        return self;
      },
      async limit(n: number) {
        return selected.slice(0, n);
      },
    };
    return self;
  };

  const db = {
    select: () => chain(),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    transaction: async (cb: (tx: Database) => Promise<unknown>) => cb(db as unknown as Database),
  };
  return db as unknown as Database;
}

function host(overrides: Partial<Host>): Host {
  return {
    id: 42,
    fqdn: 'host-a.fleet.example.com',
    apiKey: 'sk-golden-test-not-a-real-key',
    apiKeyHash: null,
    apiKeyEnc: null,
    status: 'active',
    secure: 1,
    allowRoamingIps: 0,
    reverseDnsMode: null,
    lastRefresh: null,
    authDigest: null,
    ip4: null,
    ip6: null,
    clientVersion: null,
    clientVersionOverride: null,
    wrapperVersion: null,
    agentsDocumentIdOverride: null,
    apiCalls: 0,
    insecureEnabledUntil: null,
    insecureGraceUntil: null,
    insecureWindowMinutes: null,
    curlInsecure: 0,
    browserosMcpEnabled: 0,
    agentMessagingEnabled: 0,
    expiresAt: null,
    vip: 0,
    lanePreference: null,
    modelOverride: null,
    reasoningEffortOverride: null,
    autoUpdateOverride: null,
    lastCronCheck: null,
    scalingExempt: 0,
    engines: 'codex',
    claudeClientVersion: null,
    claudeClientVersionOverride: null,
    claudeWrapperVersion: null,
    claudeAuthDigest: null,
    claudeModelOverride: null,
    claudeReasoningEffortOverride: null,
    claudeLastRefresh: null,
    configVersion: 0,
    wrapperTrack: 'v2',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

interface Fixture {
  name: string;
  engine: Engine;
  host: Host;
  rows: FakeRows;
  settings: {
    silent: boolean;
    adminTheme: string | null;
    autoUpdate: boolean;
    track: string;
  };
}

const SHARED_SKILL = {
  slug: 'fleet-bootstrap',
  sha256: 'e4'.repeat(32),
  deletedAt: null,
  engine: null,
};
const CODEX_SKILL = {
  slug: 'codex-review',
  sha256: 'f5'.repeat(32),
  deletedAt: null,
  engine: 'codex',
};
const CLAUDE_SKILL = {
  slug: 'claude-artifacts',
  sha256: 'a6'.repeat(32),
  deletedAt: null,
  engine: 'claude',
};
const RETIRED_SKILL = {
  slug: 'retired-skill',
  sha256: 'b7'.repeat(32),
  deletedAt: '2026-01-04T00:00:00Z',
  engine: null,
};

const FIXTURES: Fixture[] = [
  {
    // Secure host with everything switched on: both documents non-null, two
    // skills, and the codex-shaped engine_options fully populated.
    name: 'host-codex',
    engine: 'codex',
    host: host({
      id: 42,
      fqdn: 'host-a.fleet.example.com',
      apiKey: 'sk-golden-codex-not-a-real-key',
      secure: 1,
      curlInsecure: 0,
      browserosMcpEnabled: 1,
      engines: 'codex,claude',
      modelOverride: 'gpt-5.4-codex',
      reasoningEffortOverride: 'high',
      configVersion: 11,
    }),
    rows: {
      configVersion: 11,
      agentsDocumentId: 10,
      clientConfigId: 3,
      // A claude-only and a soft-deleted skill are present so the fixture also
      // pins that neither reaches a codex host.
      skills: [SHARED_SKILL, CODEX_SKILL, CLAUDE_SKILL, RETIRED_SKILL],
      agentMessagingFlag: '1',
    },
    settings: { silent: false, adminTheme: 'dark', autoUpdate: true, track: 'stable' },
  },
  {
    // secure=0 AND curl_insecure=1. The baker emits agent messaging for such a
    // host, which is the point: the fleet switch is the only switch, and an
    // insecure host is authorized per operation against its allowed window.
    // This pins the combination older wrappers rejected, so the Go side keeps
    // proving that `ValidateForEngine` accepts it.
    name: 'host-codex-insecure',
    engine: 'codex',
    host: host({
      id: 43,
      fqdn: 'host-b.fleet.example.com',
      apiKey: 'sk-golden-insecure-not-a-real-key',
      secure: 0,
      curlInsecure: 1,
      browserosMcpEnabled: 0,
      // On 0.7.8+, so the pre-0.7.8 compatibility hold-back does not apply and
      // this stays the fixture for "insecure host still gets the bus". The
      // host's reported version is not part of the signed payload, so this
      // does not move the golden bytes.
      wrapperVersion: '0.7.8',
      engines: 'codex',
      modelOverride: null,
      reasoningEffortOverride: null,
      configVersion: 4,
    }),
    rows: {
      configVersion: 4,
      agentsDocumentId: 10,
      // Null client_config and an empty skills list pin the empty shapes.
      clientConfigId: null,
      skills: [],
      agentMessagingFlag: '1',
    },
    settings: { silent: true, adminTheme: null, autoUpdate: false, track: 'beta' },
  },
  {
    // engine=claude: engine_options carries claude_model_override instead of
    // model_override/reasoning_effort_override.
    name: 'host-claude',
    engine: 'claude',
    host: host({
      id: 44,
      fqdn: 'host-c.fleet.example.com',
      apiKey: 'sk-golden-claude-not-a-real-key',
      secure: 1,
      curlInsecure: 0,
      browserosMcpEnabled: 0,
      engines: 'claude',
      claudeModelOverride: 'claude-opus-4.7',
      configVersion: 7,
    }),
    rows: {
      configVersion: 7,
      agentsDocumentId: 10,
      clientConfigId: 3,
      skills: [SHARED_SKILL, CODEX_SKILL, CLAUDE_SKILL, RETIRED_SKILL],
      // Fleet switch off: the only way agent_messaging is dormant now.
      agentMessagingFlag: '0',
    },
    settings: { silent: false, adminTheme: 'auto', autoUpdate: true, track: 'stable' },
  },
];

function bake(fixture: Fixture, ...signers: WrapperSigner[]): Promise<BakeResult> {
  const svc = createWrapperConfigService({
    db: fakeDb(fixture.rows),
    // Every fixture host carries a plaintext api_key, so nothing decrypts.
    keyring: {} as Keyring,
    binaries: fakeBinaries(),
    signing: signingService(...(signers.length ? signers : [goldenSigner('1')])),
    installationId: INSTALLATION_ID,
    settings: {
      silentFlag: async () => fixture.settings.silent,
      adminThemeHint: async () => fixture.settings.adminTheme,
      autoUpdateDefault: async () => fixture.settings.autoUpdate,
      wrapperTrack: async () => fixture.settings.track,
    },
  });
  return svc.bakeForHost(fixture.host, fixture.engine, PUBLIC_BASE_URL, PLATFORM);
}

/** Reads a golden file, first writing it when UPDATE_GOLDEN=1. */
function golden(name: string, produced: string): string {
  const path = resolve(TESTDATA, name);
  if (UPDATE) writeFileSync(path, produced, 'utf8');
  return readFileSync(path, 'utf8');
}

describe('wrapper config golden fixtures', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(ISSUED_AT));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pins the TTL that gives the fixtures their expires_at', () => {
    expect(WRAPPER_CONFIG_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
    expect(Date.parse(EXPIRES_AT) - Date.parse(ISSUED_AT)).toBe(WRAPPER_CONFIG_TTL_SECONDS * 1000);
  });

  for (const fixture of FIXTURES) {
    it(`bakes ${fixture.name}.json byte-for-byte`, async () => {
      const result = await bake(fixture);

      expect(result.payload.issued_at).toBe(ISSUED_AT);
      expect(result.payload.expires_at).toBe(EXPIRES_AT);
      expect(result.canonicalJson).toBe(golden(`${fixture.name}.json`, result.canonicalJson));
    });

    it(`pins the ${fixture.name}.json.sig detached signature`, async () => {
      const result = await bake(fixture);

      expect(result.signature.algo).toBe('ed25519');
      expect(result.signature.value).toBe(
        golden(`${fixture.name}.json.sig`, result.signature.value),
      );
    });
  }

  it('keeps the golden bytes and the primary signature intact under a second signer', async () => {
    // Multi-sign is a sibling of the signed payload, so a rotation adds no
    // signed byte: the fixtures cover exactly one key and stay correct anyway.
    const fixture = FIXTURES[0]!;
    const multi = await bake(fixture, goldenSigner('1'), goldenSigner('9'));

    expect(multi.signatures).toHaveLength(2);
    expect(multi.canonicalJson).toBe(
      readFileSync(resolve(TESTDATA, `${fixture.name}.json`), 'utf8'),
    );
    expect(multi.signature.value).toBe(
      readFileSync(resolve(TESTDATA, `${fixture.name}.json.sig`), 'utf8'),
    );
  });

  it('shapes the three fixtures differently enough to be worth having', async () => {
    const [secure, insecure, claude] = await Promise.all(FIXTURES.map((f) => bake(f)));

    expect(secure!.payload.host.secure).toBe(true);
    expect(secure!.payload.orchestrator.allow_insecure).toBe(false);
    expect(secure!.payload.agent_messaging.enabled).toBe(true);
    expect(secure!.payload.documents.agents).not.toBeNull();
    expect(secure!.payload.documents.client_config).not.toBeNull();
    expect(secure!.payload.skills.map((s) => s.slug)).toEqual(['fleet-bootstrap', 'codex-review']);
    expect(secure!.payload.engine_options.model_override).toBe('gpt-5.4-codex');
    expect(secure!.payload.engine_options.reasoning_effort_override).toBe('high');

    expect(insecure!.payload.host.secure).toBe(false);
    expect(insecure!.payload.orchestrator.allow_insecure).toBe(true);
    expect(insecure!.payload.agent_messaging.enabled).toBe(true);
    expect(insecure!.payload.documents.client_config).toBeNull();
    expect(insecure!.payload.skills).toEqual([]);

    expect(claude!.payload.agent_messaging.enabled).toBe(false);
    expect(claude!.payload.engine).toBe('claude');
    expect(claude!.payload.engine_options.claude_model_override).toBe('claude-opus-4.7');
    expect('model_override' in claude!.payload.engine_options).toBe(false);
    expect('reasoning_effort_override' in claude!.payload.engine_options).toBe(false);
    expect(claude!.payload.skills.map((s) => s.slug)).toEqual([
      'fleet-bootstrap',
      'claude-artifacts',
    ]);
  });

  describe('pre-0.7.8 compatibility hold-back', () => {
    const INSECURE = FIXTURES[1]!;

    function atVersion(wrapperVersion: string | null, extra: Partial<Host> = {}): Fixture {
      return { ...INSECURE, host: { ...INSECURE.host, wrapperVersion, ...extra } };
    }

    // cxx <= 0.7.7 refuses the WHOLE signed config when agent_messaging is on
    // without host.secure, so baking it would freeze the host's config refresh
    // instead of merely withholding the bus.
    it.each([
      ['0.7.7', false],
      ['0.7.6', false],
      ['0.6.55', false],
      ['0.7.8', true],
      ['0.7.9', true],
      ['0.8.0', true],
      ['1.0.0', true],
    ])('insecure host reporting %s bakes agent_messaging=%s', async (version, expected) => {
      const result = await bake(atVersion(version));
      expect(result.payload.agent_messaging.enabled).toBe(expected);
      // The shim must not contradict the real field, in either direction.
      expect(result.payload.host.agent_messaging_enabled).toBe(expected);
    });

    it('treats an unknown wrapper version as incapable rather than guessing', async () => {
      for (const version of [null, '', '   ', 'nightly']) {
        const result = await bake(atVersion(version));
        expect(result.payload.agent_messaging.enabled).toBe(false);
      }
    });

    it('never consults the wrapper version for a secure host', async () => {
      // A secure host satisfies the old validator regardless of version, so the
      // hold-back must not touch it — that would be policy, not compatibility.
      const result = await bake(atVersion('0.7.7', { secure: 1 }));
      expect(result.payload.host.secure).toBe(true);
      expect(result.payload.agent_messaging.enabled).toBe(true);
    });

    it('falls back to the peer engine version, since cxx is one binary', async () => {
      const result = await bake(
        atVersion(null, { claudeWrapperVersion: '0.7.8', engines: 'codex,claude' }),
      );
      expect(result.payload.agent_messaging.enabled).toBe(true);
    });

    it('still honours the fleet switch above the hold-back', async () => {
      const off: Fixture = {
        ...atVersion('0.7.8'),
        rows: { ...INSECURE.rows, agentMessagingFlag: '0' },
      };
      expect((await bake(off)).payload.agent_messaging.enabled).toBe(false);
    });
  });
});
