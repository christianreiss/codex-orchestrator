import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-node';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

import {
  initTracing,
  shutdownTracing,
  tracingEnabled,
  withSpan,
  type TracingEnv,
} from '../../../src/observability/tracing.js';
import { Keyring } from '../../../src/security/keyring.js';
import type { Env } from '../../../src/env.js';
import type { Host } from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/client.js';
import {
  createWrapperConfigService,
  WrapperBinaryUnavailableError,
  WrapperSigningUnavailableError,
} from '../../../src/services/wrapper-config.js';
import type {
  WrapperSigner,
  WrapperSigningKeyService,
} from '../../../src/services/wrapper-signing-key.js';
import type {
  BinaryBuild,
  EngineManifest,
  PlatformManifest,
  WrapperBinRegistry,
} from '../../../src/services/wrapper-bin-registry.js';

/**
 * The plaintext credential the bakery resolves and puts in the signed payload.
 * Nothing about it may ever reach a span attribute.
 */
const HOST_API_KEY = 'sk-codex-fakekey1234';

function tracingEnv(enabled: boolean): TracingEnv {
  return { OTEL_TRACES_ENABLED: enabled, OTEL_SERVICE_NAME: 'codex-orchestrator-api-test' };
}

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
    id: 42,
    fqdn: 'trace01.example.com',
    apiKey: HOST_API_KEY,
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
    configVersion: 4,
    wrapperTrack: 'v2',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-15T00:00:00Z',
    ...overrides,
  };
}

/**
 * Every SELECT returns nothing, which is a perfectly valid host: no agents
 * document, no client config, no skills. `bumpConfigVersion` then reads 0 and
 * writes 1, which is what the config_version assertions expect.
 */
function fakeDb(): Database {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    for: () => chain,
    limit: async (): Promise<unknown[]> => [],
  };
  const db = {
    select: () => chain,
    update: () => ({ set: () => ({ where: async () => {} }) }),
    transaction: async (cb: (tx: Database) => Promise<unknown>) => cb(db as unknown as Database),
  };
  return db as unknown as Database;
}

function fakeBinaries(available = true): WrapperBinRegistry {
  const build: BinaryBuild = { version: '1.0.1', sha256: 'a'.repeat(64), size_bytes: 100 };
  const manifest: EngineManifest = { engine: 'codex', platforms: {} };
  return {
    async manifestForPlatform(): Promise<PlatformManifest | null> {
      return null;
    },
    async currentBuild() {
      return available ? build : null;
    },
    async resolveCurrentBuild() {
      return available ? { ...build, artifact: 'cxx' as const, path: '/fixtures/cxx' } : null;
    },
    async resolveVersion() {
      return available ? { ...build, artifact: 'cxx' as const, path: '/fixtures/cxx' } : null;
    },
    async latestVersion() {
      return available ? build.version : null;
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

/**
 * Deterministic 64-byte "signature". The bakery never inspects it, and the
 * value is only here so the secret-leak assertion has something to look for.
 */
function fakeSigner(kid = '1'): WrapperSigner {
  return {
    kid,
    fingerprint: 'b'.repeat(64),
    publicKey: 'cGs=',
    sign(payload) {
      const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
      return createHash('sha512').update(buf).digest();
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

function makeService(opts: { signers?: WrapperSigner[]; binariesAvailable?: boolean } = {}) {
  return createWrapperConfigService({
    db: fakeDb(),
    keyring: makeKeyring(),
    binaries: fakeBinaries(opts.binariesAvailable ?? true),
    signing: signingService(...(opts.signers ?? [fakeSigner()])),
    installationId: 'test-install',
  });
}

function byName(spans: ReadableSpan[], name: string): ReadableSpan {
  const found = spans.find((s) => s.name === name);
  if (!found) throw new Error(`no span named ${name} in [${spans.map((s) => s.name).join(', ')}]`);
  return found;
}

beforeAll(async () => {
  await sodium.ready;
});

afterEach(async () => {
  await shutdownTracing();
});

describe('tracing — disabled by default', () => {
  it('records nothing for a full bake, even with an exporter injected', async () => {
    const exporter = new InMemorySpanExporter();
    // The exporter override must not be able to switch tracing on by itself,
    // otherwise "off by default" is untestable.
    await initTracing(tracingEnv(false), { exporter });

    expect(tracingEnabled()).toBe(false);

    const result = await makeService().bakeForHost(fakeHost(), 'codex', 'https://example.com');

    expect(result.payload.config_version).toBe(1);
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('withSpan calls straight through and returns the callback value', async () => {
    const exporter = new InMemorySpanExporter();
    await initTracing(tracingEnv(false), { exporter });

    const seen: string[] = [];
    const value = await withSpan('probe', { 'probe.attr': 1 }, async (span) => {
      span.setAttribute('inner', 'ok');
      seen.push('ran');
      return 'result';
    });

    expect(value).toBe('result');
    expect(seen).toEqual(['ran']);
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('withSpan rethrows unchanged while disabled', async () => {
    await initTracing(tracingEnv(false), { exporter: new InMemorySpanExporter() });
    const boom = new Error('boom');
    await expect(
      withSpan('probe', {}, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});

describe('tracing — enabled', () => {
  it('emits the bake span tree with non-secret attributes', async () => {
    const exporter = new InMemorySpanExporter();
    await initTracing(tracingEnv(true), { exporter });
    expect(tracingEnabled()).toBe(true);

    await makeService({ signers: [fakeSigner('1'), fakeSigner('2')] }).bakeForHost(
      fakeHost(),
      'codex',
      'https://example.com',
    );

    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual([
      'wrapper.config.bake',
      'wrapper.config.bump_version',
      'wrapper.config.collect',
      'wrapper.config.sign',
    ]);

    const root = byName(spans, 'wrapper.config.bake');
    expect(root.parentSpanContext).toBeUndefined();
    expect(root.attributes['wrapper.host_id']).toBe(42);
    expect(root.attributes['wrapper.engine']).toBe('codex');
    expect(root.attributes['wrapper.schema_version']).toBe(1);
    expect(root.attributes['wrapper.config_version']).toBe(1);
    expect(root.status.code).not.toBe(SpanStatusCode.ERROR);

    // Every child hangs off the bake span, in the same trace.
    for (const name of [
      'wrapper.config.collect',
      'wrapper.config.bump_version',
      'wrapper.config.sign',
    ]) {
      const child = byName(spans, name);
      expect(child.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
      expect(child.spanContext().traceId).toBe(root.spanContext().traceId);
    }

    expect(byName(spans, 'wrapper.config.sign').attributes['wrapper.signer_count']).toBe(2);
  });

  it('never puts the api key, a signature or the canonical bytes on a span', async () => {
    const exporter = new InMemorySpanExporter();
    await initTracing(tracingEnv(true), { exporter });

    const result = await makeService().bakeForHost(fakeHost(), 'codex', 'https://example.com');

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);

    const forbidden = [
      HOST_API_KEY,
      result.signature.value,
      result.signatures[0]!.fingerprint,
      result.canonicalJson,
      result.payload.etag,
    ];
    // Sweep every attribute of every span, not just the ones this test knows
    // the names of: a future attribute added to any span is covered too.
    for (const span of spans) {
      const serialized = JSON.stringify(span.attributes);
      for (const secret of forbidden) {
        expect(serialized).not.toContain(secret);
      }
    }
  });

  it('marks the bake span ERROR when no signing key is active', async () => {
    const exporter = new InMemorySpanExporter();
    await initTracing(tracingEnv(true), { exporter });

    await expect(
      makeService({ signers: [] }).bakeForHost(fakeHost(), 'codex', 'https://example.com'),
    ).rejects.toBeInstanceOf(WrapperSigningUnavailableError);

    const root = byName(exporter.getFinishedSpans(), 'wrapper.config.bake');
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(root.status.message).toBe('WrapperSigningUnavailableError');
    expect(root.attributes['error.type']).toBe('WrapperSigningUnavailableError');
  });

  it('marks the collect and bake spans ERROR when no wrapper binary is published', async () => {
    const exporter = new InMemorySpanExporter();
    await initTracing(tracingEnv(true), { exporter });

    await expect(
      makeService({ binariesAvailable: false }).bakeForHost(
        fakeHost(),
        'codex',
        'https://example.com',
      ),
    ).rejects.toBeInstanceOf(WrapperBinaryUnavailableError);

    const spans = exporter.getFinishedSpans();
    for (const name of ['wrapper.config.collect', 'wrapper.config.bake']) {
      const span = byName(spans, name);
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes['error.type']).toBe('WrapperBinaryUnavailableError');
    }
    // The bump never ran: the fan-out threw first.
    expect(spans.some((s) => s.name === 'wrapper.config.bump_version')).toBe(false);
  });

  it('stops recording again after shutdownTracing', async () => {
    const exporter = new InMemorySpanExporter();
    await initTracing(tracingEnv(true), { exporter });
    await withSpan('probe', {}, async () => undefined);
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(['probe']);

    await shutdownTracing();
    expect(tracingEnabled()).toBe(false);

    const after = new InMemorySpanExporter();
    // Re-init with the flag off: the process is warm, and the switch still wins.
    await initTracing(tracingEnv(false), { exporter: after });
    await withSpan('probe2', {}, async () => undefined);
    expect(after.getFinishedSpans()).toEqual([]);
  });
});
