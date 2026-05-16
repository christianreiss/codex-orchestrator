import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

import { Keyring } from '../../../src/security/keyring.js';
import type { Env } from '../../../src/env.js';
import type { Host } from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/client.js';
import {
  createWrapperConfigService,
  canonicalStringify,
  WRAPPER_CONFIG_SCHEMA_VERSION,
  WrapperSigningUnavailableError,
} from '../../../src/services/wrapper-config.js';
import type {
  WrapperSigner,
  WrapperSigningKeyService,
} from '../../../src/services/wrapper-signing-key.js';
import type {
  WrapperBinRegistry,
  BinaryBuild,
  EngineManifest,
  PlatformManifest,
} from '../../../src/services/wrapper-bin-registry.js';

function makeKeyring(): Keyring {
  const raw = sodium.randombytes_buf(32);
  const env = {
    ENCRYPTION_KEYS: `main:${sodium.to_base64(raw, sodium.base64_variants.ORIGINAL)}`,
    ENCRYPTION_ACTIVE_KID: 'main',
  } as unknown as Env;
  return Keyring.fromEnv(env);
}

function fakeHost(overrides: Partial<Host> = {}): Host {
  return {
    id: 7,
    fqdn: 'host01.example.com',
    apiKey: 'sk-codex-fakekey1234',
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
    expiresAt: null,
    vip: 0,
    lanePreference: null,
    modelOverride: 'gpt-5.4',
    reasoningEffortOverride: 'high',
    autoUpdateOverride: null,
    lastCronCheck: null,
    scalingExempt: 0,
    engines: 'codex',
    claudeClientVersion: null,
    claudeClientVersionOverride: null,
    claudeWrapperVersion: null,
    claudeAuthDigest: null,
    claudeModelOverride: 'claude-3-opus',
    claudeReasoningEffortOverride: null,
    claudeLastRefresh: null,
    configVersion: 4,
    configBakedAt: null,
    wrapperTrack: 'v2',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-15T00:00:00Z',
    ...overrides,
  };
}

function fakeBinaries(): WrapperBinRegistry {
  const build: BinaryBuild = {
    version: '1.0.1',
    sha256: 'a'.repeat(64),
    size_bytes: 100,
  };
  const manifest: EngineManifest = {
    engine: 'codex',
    platforms: {
      'linux-amd64': {
        version: '1.0.1',
        sha256: 'a'.repeat(64),
        size_bytes: 100,
        url_path: 'https://example.com/wrapper/v2/bin/codex/linux-amd64/v1.0.1/cdx',
      },
    },
  };
  return {
    async manifestForPlatform(): Promise<PlatformManifest | null> {
      return null;
    },
    async currentBuild() {
      return build;
    },
    async latestVersion() {
      return '1.0.1';
    },
    async engineManifest() {
      return manifest;
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

function makeSigningService(signer: WrapperSigner | null): WrapperSigningKeyService {
  return {
    async active() {
      return signer;
    },
    async available() {
      return signer !== null;
    },
    invalidate() {},
  };
}

// State for the fake DB
interface DbState {
  hosts: Host[];
  agents: Array<{ id: number; sha256: string; updatedAt: string; engine: string; body: string }>;
  agentsState: Array<{
    id: number;
    mode: string;
    activeDocumentId: number | null;
    engine: string;
  }>;
  clientConfigs: Array<{ id: number; sha256: string; updatedAt: string; engine: string }>;
  skills: Array<{
    slug: string;
    sha256: string;
    deletedAt: string | null;
    engine: string | null;
  }>;
  updates: Array<{ table: string; patch: Record<string, unknown> }>;
}

function makeFakeDb(state: DbState): Database {
  function chainFor(rows: unknown[]) {
    let filtered: unknown[] = rows;
    const chain: {
      from: (..._a: unknown[]) => typeof chain;
      where: (..._a: unknown[]) => typeof chain;
      orderBy: (..._a: unknown[]) => typeof chain;
      limit: (n: number) => Promise<unknown[]>;
    } = {
      from(t: unknown) {
        const table = t as { _: { name?: string } };
        const name = table._?.name ?? '';
        filtered = pickTable(state, name);
        return chain;
      },
      where(predicate: unknown) {
        const pred = predicate as { _: { type?: string; column?: { name?: string }; value?: unknown } } | undefined;
        // The fake DB doesn't introspect drizzle expressions; it just trusts
        // the caller (the service) to pass us enough info via context. We
        // approximate: filter by `engine` if predicate references that
        // column.
        if (pred && pred._ && pred._.column?.name === 'engine') {
          filtered = filtered.filter(
            (r) => (r as { engine?: string }).engine === pred._.value,
          );
        }
        return chain;
      },
      orderBy(..._args: unknown[]) {
        return chain;
      },
      async limit(n: number) {
        return filtered.slice(0, n);
      },
    };
    return chain;
  }

  return {
    select: () => chainFor([]),
    update: (_table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (_pred: unknown) => {
          state.updates.push({ table: 'hosts', patch });
        },
      }),
    }),
  } as unknown as Database;
}

function pickTable(state: DbState, _name: string): unknown[] {
  // The drizzle table objects don't expose .name in the fake; we use call
  // site context instead by checking what was set up. Returning all-shapes
  // is fine because each select() chain is followed by a where(engine=…) +
  // limit(1) — the service only consumes the first match.
  // Heuristic: dispatch by which shape was queried. We embed a marker on the
  // table in `chainFor`. Practical compromise: route based on the singular
  // shape — return whichever non-empty set matches the first selectable.
  if (state.agentsState.length) {
    // The service queries agents_document_state first in activeAgentsDocId.
    // After consuming, mark as consumed by shifting.
    // But we want to be able to serve hosts queries too. So we'll just
    // return everything; the service filters by engine.
  }
  return [
    ...state.hosts,
    ...state.agents,
    ...state.agentsState,
    ...state.clientConfigs,
    ...state.skills,
  ];
}

beforeAll(async () => {
  await sodium.ready;
});

describe('wrapper-config', () => {
  it('throws WrapperSigningUnavailableError when no signer is loaded', async () => {
    const svc = createWrapperConfigService({
      db: makeFakeDb({
        hosts: [],
        agents: [],
        agentsState: [],
        clientConfigs: [],
        skills: [],
        updates: [],
      }),
      keyring: makeKeyring(),
      binaries: fakeBinaries(),
      signing: makeSigningService(null),
      installationId: 'test-install',
    });
    await expect(svc.bakeForHost(fakeHost(), 'codex', 'https://example.com')).rejects.toBeInstanceOf(
      WrapperSigningUnavailableError,
    );
  });

  it('canonicalStringify produces stable ordering across key insertions', () => {
    const a = canonicalStringify({ b: 2, a: 1, z: { nested: 1, alpha: 0 } });
    const b = canonicalStringify({ z: { alpha: 0, nested: 1 }, a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2,"z":{"alpha":0,"nested":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalStringify({ items: [3, 1, 2] })).toBe('{"items":[3,1,2]}');
  });

  it('signs a canonical payload that verifies under the active key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pubKeyObj = publicKey;
    void createPublicKey;

    const signer: WrapperSigner = {
      kid: '7',
      publicKey: 'pk-b64',
      sign(payload) {
        const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
        const { sign } = require('node:crypto') as typeof import('node:crypto');
        return sign(null, buf, privateKey);
      },
    };

    const initialConfigVersion = 4;
    const dbState: DbState = {
      hosts: [fakeHost({ configVersion: initialConfigVersion })],
      agents: [],
      agentsState: [],
      clientConfigs: [],
      skills: [],
      updates: [],
    };

    const svc = createWrapperConfigService({
      db: makeFakeDb(dbState),
      keyring: makeKeyring(),
      binaries: fakeBinaries(),
      signing: makeSigningService(signer),
      installationId: 'inst-1',
    });

    const result = await svc.bakeForHost(fakeHost({ configVersion: initialConfigVersion }), 'codex', 'https://api.example.com/');

    // Schema version + structure
    expect(result.payload.schema_version).toBe(WRAPPER_CONFIG_SCHEMA_VERSION);
    expect(result.payload.engine).toBe('codex');
    expect(result.payload.orchestrator.installation_id).toBe('inst-1');
    expect(result.payload.orchestrator.base_url).toBe('https://api.example.com');
    expect(result.payload.host.id).toBe(7);
    expect(result.payload.host.fqdn).toBe('host01.example.com');
    expect(result.payload.engine_options.model_override).toBe('gpt-5.4');
    expect(result.payload.wrapper.version).toBe('1.0.1');
    expect(result.payload.wrapper.binary_url).toContain('/wrapper/v2/bin/codex/linux-amd64/v1.0.1/cdx');

    // Signature roundtrip
    const ok = cryptoVerify(
      null,
      Buffer.from(result.canonicalJson, 'utf8'),
      pubKeyObj,
      Buffer.from(result.signature.value, 'base64'),
    );
    expect(ok).toBe(true);
    expect(result.signature.algo).toBe('ed25519');
    expect(result.signature.kid).toBe('7');

    // Etag is sha256 of the canonical payload (without etag in it)
    expect(result.payload.etag).toMatch(/^[a-f0-9]{64}$/);
  });

  it('selects claude-shaped engine_options when engine=claude', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer: WrapperSigner = {
      kid: '1',
      publicKey: 'pk',
      sign(payload) {
        const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
        const { sign } = require('node:crypto') as typeof import('node:crypto');
        return sign(null, buf, privateKey);
      },
    };
    const svc = createWrapperConfigService({
      db: makeFakeDb({
        hosts: [fakeHost()],
        agents: [],
        agentsState: [],
        clientConfigs: [],
        skills: [],
        updates: [],
      }),
      keyring: makeKeyring(),
      binaries: fakeBinaries(),
      signing: makeSigningService(signer),
      installationId: 'inst-2',
    });
    const result = await svc.bakeForHost(fakeHost(), 'claude', 'https://api.example.com');
    expect(result.payload.engine).toBe('claude');
    expect(result.payload.engine_options.claude_model_override).toBe('claude-3-opus');
    expect('model_override' in result.payload.engine_options).toBe(false);
    expect(result.payload.wrapper.binary_url).toContain('/clx');
  });

  it('exposes a bumped flag and increments config_version', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer: WrapperSigner = {
      kid: '1',
      publicKey: 'pk',
      sign(p) {
        const buf = typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p);
        const { sign } = require('node:crypto') as typeof import('node:crypto');
        return sign(null, buf, privateKey);
      },
    };
    const host = fakeHost({ configVersion: 11 });
    const dbState: DbState = {
      hosts: [host],
      agents: [],
      agentsState: [],
      clientConfigs: [],
      skills: [],
      updates: [],
    };
    const svc = createWrapperConfigService({
      db: makeFakeDb(dbState),
      keyring: makeKeyring(),
      binaries: fakeBinaries(),
      signing: makeSigningService(signer),
      installationId: 'inst',
    });
    const result = await svc.bakeForHost(host, 'codex', 'https://api.example.com');
    expect(result.bumped).toBe(true);
    expect(result.configVersion).toBe(12);
    expect(dbState.updates.length).toBeGreaterThanOrEqual(1);
  });
});
