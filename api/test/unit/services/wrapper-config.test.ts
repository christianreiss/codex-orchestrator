import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  createHash,
  generateKeyPairSync,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

import { Keyring } from '../../../src/security/keyring.js';
import { encrypt } from '../../../src/security/secret-box.js';
import type { Env } from '../../../src/env.js';
import type { Host } from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/client.js';
import {
  createWrapperConfigService,
  canonicalStringify,
  WRAPPER_CONFIG_SCHEMA_VERSION,
  WRAPPER_CONFIG_TTL_SECONDS,
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

/** Stand-in for a real key fingerprint where the test never inspects it. */
const FAKE_FINGERPRINT = 'f'.repeat(64);

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
    browserosMcpEnabled: 0,
    agentMessagingEnabled: 0,
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
        url_path: 'https://example.com/wrapper/v2/bin/cxx/linux-amd64/v1.0.1/cxx',
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
    async resolveCurrentBuild() {
      return { ...build, artifact: 'cxx', path: '/fixtures/cxx' };
    },
    async resolveVersion() {
      return { ...build, artifact: 'cxx', path: '/fixtures/cxx' };
    },
    async latestVersion() {
      return '1.0.1';
    },
    async engineManifest() {
      return manifest;
    },
    async binaryDescriptor(artifact) {
      return artifact === 'cxx'
        ? { path: '/fixtures/cxx', sha256: build.sha256, size: build.size_bytes }
        : null;
    },
    async openBinary() {
      throw new Error('not implemented');
    },
    invalidate() {},
  };
}

function makeSigningService(...signers: Array<WrapperSigner | null>): WrapperSigningKeyService {
  const active = signers.filter((signer): signer is WrapperSigner => signer !== null);
  return {
    async active() {
      return active[0] ?? null;
    },
    async allActive() {
      return [...active];
    },
    async available() {
      return active.length > 0;
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
      for: (..._a: unknown[]) => typeof chain;
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
      for(..._args: unknown[]) {
        return chain;
      },
      async limit(n: number) {
        return filtered.slice(0, n);
      },
    };
    return chain;
  }

  const db = {
    select: () => chainFor([]),
    update: (_table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (_pred: unknown) => {
          state.updates.push({ table: 'hosts', patch });
        },
      }),
    }),
    // Fake is single-threaded/in-memory, so a "transaction" is just running
    // the callback against the same fake -- there's no real concurrency to
    // isolate here, only the API shape (tx.select/.update) needs to match.
    transaction: async (cb: (tx: Database) => Promise<unknown>) => cb(db as unknown as Database),
  };
  return db as unknown as Database;
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
      fingerprint: FAKE_FINGERPRINT,
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
    expect(result.payload.wrapper.binary_url).toContain('/wrapper/v2/bin/cxx/linux-amd64/v1.0.1/cxx');

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

  it('bakes the decrypted API key instead of the modern stored hash', async () => {
    const keyring = makeKeyring();
    const plaintext = 'sk-codex-decrypted-wrapper-key';
    const signer: WrapperSigner = {
      kid: '1',
      fingerprint: FAKE_FINGERPRINT,
      publicKey: 'pk',
      sign() {
        return Buffer.alloc(64);
      },
    };
    const svc = createWrapperConfigService({
      db: makeFakeDb({
        hosts: [],
        agents: [],
        agentsState: [],
        clientConfigs: [],
        skills: [],
        updates: [],
      }),
      keyring,
      binaries: fakeBinaries(),
      signing: makeSigningService(signer),
      installationId: 'inst-keyring',
    });

    const result = await svc.bakeForHost(
      fakeHost({
        apiKey: 'a'.repeat(64),
        apiKeyHash: 'a'.repeat(64),
        apiKeyEnc: encrypt(plaintext, keyring),
      }),
      'codex',
      'https://api.example.com',
    );

    expect(result.payload.orchestrator.api_key).toBe(plaintext);
  });

  it('honors the requested platform when baking the wrapper block', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer: WrapperSigner = {
      kid: '1',
      fingerprint: FAKE_FINGERPRINT,
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
      installationId: 'inst-mac',
    });
    const result = await svc.bakeForHost(
      fakeHost(),
      'codex',
      'https://api.example.com',
      { os: 'darwin', arch: 'arm64' },
    );
    expect(result.payload.wrapper.binary_url).toContain('/wrapper/v2/bin/cxx/darwin-arm64/v1.0.1/cxx');
  });

  it('selects claude-shaped engine_options when engine=claude', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer: WrapperSigner = {
      kid: '1',
      fingerprint: FAKE_FINGERPRINT,
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
    expect(result.payload.wrapper.binary_url).toContain('/wrapper/v2/bin/cxx/linux-amd64/v1.0.1/cxx');
  });

  it('exposes a bumped flag and increments config_version', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer: WrapperSigner = {
      kid: '1',
      fingerprint: FAKE_FINGERPRINT,
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

  describe('config lifetime', () => {
    /**
     * Bakes with a wrapper-binary lookup that pushes the clock forward. It runs
     * inside the bake, after the stamps are taken, so any second clock read
     * would land on the far side of the drift and betray itself.
     */
    function bakeWithMidBakeClockDrift(driftMs: number) {
      const host = fakeHost({ configVersion: 4 });
      const binaries = fakeBinaries();
      const svc = createWrapperConfigService({
        db: makeFakeDb({
          hosts: [host],
          agents: [],
          agentsState: [],
          clientConfigs: [],
          skills: [],
          updates: [],
        }),
        keyring: makeKeyring(),
        binaries: {
          ...binaries,
          async resolveCurrentBuild(engine, os, arch) {
            vi.setSystemTime(new Date(Date.now() + driftMs));
            return binaries.resolveCurrentBuild(engine, os, arch);
          },
        },
        signing: makeSigningService({
          kid: '1',
          fingerprint: FAKE_FINGERPRINT,
          publicKey: 'pk',
          sign() {
            return Buffer.alloc(64);
          },
        }),
        installationId: 'inst-ttl',
      });
      return svc.bakeForHost(host, 'codex', 'https://api.example.com');
    }

    it('stamps expires_at exactly one TTL after issued_at, from a single clock read', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      // Late in a second, then drifting past it mid-bake: two separate clock
      // reads would straddle the boundary and the signed lifetime would come
      // out a second short of the advertised TTL.
      vi.setSystemTime(new Date('2026-08-03T09:00:00.900Z'));
      try {
        const result = await bakeWithMidBakeClockDrift(200);

        expect(result.payload.issued_at).toBe('2026-08-03T09:00:00Z');
        expect(result.payload.expires_at).toBe('2026-09-02T09:00:00Z');
        expect(WRAPPER_CONFIG_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
        expect(
          Date.parse(result.payload.expires_at!) - Date.parse(result.payload.issued_at),
        ).toBe(WRAPPER_CONFIG_TTL_SECONDS * 1000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('emits expires_at in the second-precision RFC3339 shape the wrapper parses', async () => {
      const signer: WrapperSigner = {
        kid: '1',
        fingerprint: FAKE_FINGERPRINT,
        publicKey: 'pk',
        sign() {
          return Buffer.alloc(64);
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
        installationId: 'inst-ttl-shape',
      });

      const result = await svc.bakeForHost(fakeHost(), 'claude', 'https://api.example.com');

      // Go parses this with time.RFC3339; a millisecond suffix would still
      // parse, but keeping both stamps in one shape is the contract.
      expect(result.payload.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(result.payload.issued_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(Date.parse(result.payload.expires_at!)).toBeGreaterThan(Date.now());
    });
  });

  describe('multi-active signing keys', () => {
    /** A signer backed by a real Ed25519 key, fingerprinted like the service. */
    function realSigner(kid: string, privateKey: KeyObject): WrapperSigner {
      const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as { x?: string };
      const raw = Buffer.from(jwk.x!.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      return {
        kid,
        fingerprint: createHash('sha256').update(raw).digest('hex'),
        publicKey: raw.toString('base64'),
        sign(payload) {
          const buf =
            typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
          return cryptoSign(null, buf, privateKey);
        },
      };
    }

    function bake(...signers: WrapperSigner[]) {
      const host = fakeHost({ configVersion: 4 });
      const svc = createWrapperConfigService({
        db: makeFakeDb({
          hosts: [host],
          agents: [],
          agentsState: [],
          clientConfigs: [],
          skills: [],
          updates: [],
        }),
        keyring: makeKeyring(),
        binaries: fakeBinaries(),
        signing: makeSigningService(...signers),
        installationId: 'inst-rotation',
      });
      return svc.bakeForHost(host, 'codex', 'https://api.example.com');
    }

    it('leaves the signed bytes and the primary signature byte-identical', async () => {
      const older = generateKeyPairSync('ed25519');
      const newer = generateKeyPairSync('ed25519');
      const primary = realSigner('3', older.privateKey);
      const secondary = realSigner('9', newer.privateKey);

      // `issued_at`/`expires_at` come from the wall clock, so the two
      // bakes are only comparable with the clock pinned. Ed25519 is
      // deterministic, so identical bytes under one key give an identical
      // signature — that is the compatibility guarantee being asserted.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-08-03T09:00:00Z'));
      try {
        const single = await bake(primary);
        const multi = await bake(primary, secondary);

        expect(multi.canonicalJson).toBe(single.canonicalJson);
        expect(multi.signature).toEqual(single.signature);
        expect(multi.signature.value).toBe(single.signature.value);
        // The served `{payload, signature}` body must keep exactly the three
        // keys deployed wrappers parse — the fingerprint rides beside it.
        expect(Object.keys(multi.signature).sort()).toEqual(['algo', 'kid', 'value']);

        expect(single.signatures).toHaveLength(1);
        expect(multi.signatures).toHaveLength(2);
        expect(multi.signatures.map((sig) => sig.kid)).toEqual(['3', '9']);
        expect(multi.signatures[0]!.value).toBe(single.signature.value);
      } finally {
        vi.useRealTimers();
      }
    });

    it('signs the same canonical bytes with every active key', async () => {
      const older = generateKeyPairSync('ed25519');
      const newer = generateKeyPairSync('ed25519');
      const result = await bake(
        realSigner('3', older.privateKey),
        realSigner('9', newer.privateKey),
      );

      const bytes = Buffer.from(result.canonicalJson, 'utf8');
      for (const [signature, pair] of [
        [result.signatures[0]!, older],
        [result.signatures[1]!, newer],
      ] as const) {
        expect(signature.algo).toBe('ed25519');
        expect(
          cryptoVerify(null, bytes, pair.publicKey, Buffer.from(signature.value, 'base64')),
          `signature ${signature.kid}`,
        ).toBe(true);
        const jwk = pair.publicKey.export({ format: 'jwk' }) as { x?: string };
        const raw = Buffer.from(jwk.x!.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        expect(signature.fingerprint).toBe(createHash('sha256').update(raw).digest('hex'));
      }
      // Cross-check: the fingerprints differ, so they identify the keys apart.
      expect(result.signatures[0]!.fingerprint).not.toBe(result.signatures[1]!.fingerprint);
      // A second key must never leak into the signed payload.
      expect('signatures' in result.payload).toBe(false);
    });
  });
});
