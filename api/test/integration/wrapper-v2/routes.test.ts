import { describe, it, expect, beforeAll } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  createHash,
  generateKeyPairSync,
  createPublicKey,
  verify as cryptoVerify,
} from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { Keyring } from '../../../src/security/keyring.js';
import type { Env } from '../../../src/env.js';
import type { Host } from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/client.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import {
  BinaryNotFoundError,
  CXX_ARTIFACT,
  createWrapperBinRegistry,
  type WrapperArtifact,
} from '../../../src/services/wrapper-bin-registry.js';
import type {
  WrapperSigner,
  WrapperSigningKeyService,
} from '../../../src/services/wrapper-signing-key.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { registerWrapperV2Routes } from '../../../src/routes/wrapper-v2/index.js';
import { hostEnginesList } from '../../../src/services/host-engine-policy.js';

const BIN_ROOT = resolve(import.meta.dirname, '..', '..', 'fixtures', 'wrapper-v2', 'bin');

function fakeHost(): Host {
  return {
    id: 9,
    fqdn: 'h.example.com',
    apiKey: 'sk-codex-aaaa',
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
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-15T00:00:00Z',
  };
}

function makeKeyring(): Keyring {
  const raw = sodium.randombytes_buf(32);
  const env = {
    ENCRYPTION_KEYS: `main:${sodium.to_base64(raw, sodium.base64_variants.ORIGINAL)}`,
    ENCRYPTION_ACTIVE_KID: 'main',
  } as unknown as Env;
  return Keyring.fromEnv(env);
}

function fakeEnv(): Env {
  return {
    PUBLIC_BASE_URL: 'https://api.test.example.com',
    INSTALLATION_ID: 'install-test',
  } as unknown as Env;
}

function fakeDb(host: Host): Database {
  // Drizzle-shaped query builder stub. The wrapper-config service only does:
  //   select().from(t).where(eq).limit(n) on agents_document_state, agents_documents,
  //     client_config_documents, skills, and hosts.
  //   update(hosts).set(...).where(...)
  // We return empty rows for everything except hosts where the service reads
  // configVersion to bump it.
  let hostSelectCount = 0;
  const db = {
    select: () => ({
      from: (t: unknown) => {
        const table = t as { _?: unknown } & Record<string, unknown>;
        // Heuristic: the only table the service reads with intent is `hosts`
        // (for the configVersion). Other tables resolve to empty lists.
        const isHosts =
          (table as { _?: { name?: string } })._?.name === 'hosts' ||
          'apiKey' in table;
        return {
          where: () => ({
            limit: async (_n: number) => {
              if (isHosts) {
                hostSelectCount++;
                return [host];
              }
              return [];
            },
            orderBy: () => ({
              limit: async (_n: number) => [],
            }),
            for: () => ({
              limit: async (_n: number) => {
                if (isHosts) {
                  hostSelectCount++;
                  return [host];
                }
                return [];
              },
            }),
          }),
          limit: async (_n: number) => [],
        };
      },
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          host.configVersion = (host.configVersion ?? 0) + 1;
          void hostSelectCount;
        },
      }),
    }),
    // bumpConfigVersion (wrapper-config.ts) wraps its SELECT ... FOR UPDATE +
    // UPDATE in a transaction; this fake is single-threaded, so running the
    // callback against the same fake is sufficient to match the API shape.
    transaction: async (cb: (tx: Database) => Promise<unknown>) => cb(db as unknown as Database),
  };
  return db as unknown as Database;
}

/** The raw 32-byte Ed25519 public key behind a public or private key object. */
function rawPublicKey(key: import('node:crypto').KeyObject): Buffer {
  const pub = key.type === 'public' ? key : createPublicKey(key);
  const jwk = pub.export({ format: 'jwk' }) as { x?: string };
  return Buffer.from(jwk.x!.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function makeSigner(privateKey: import('node:crypto').KeyObject): WrapperSigner {
  const raw = rawPublicKey(privateKey);
  return {
    kid: '1',
    fingerprint: createHash('sha256').update(raw).digest('hex'),
    publicKey: raw.toString('base64'),
    sign(payload) {
      const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
      const { sign } = require('node:crypto') as typeof import('node:crypto');
      return sign(null, buf, privateKey);
    },
  };
}

function signingService(signer: WrapperSigner | null): WrapperSigningKeyService {
  return {
    async active() {
      return signer;
    },
    async allActive() {
      return signer ? [signer] : [];
    },
    async available() {
      return signer !== null;
    },
    invalidate() {},
  };
}

async function buildApp(
  ctx: RouteContext,
  signer: WrapperSigner | null,
  authHost: Host | null,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(envelopePlugin);

  // Stub the requireHost decorator the routes depend on.
  app.decorateRequest('authHost', undefined);
  app.decorate('requireHost', async (req: FastifyRequest) => {
    if (!authHost) {
      const err = new Error('unauthorized');
      (err as Error & { statusCode?: number }).statusCode = 401;
      throw err;
    }
    req.authHost = authHost;
  });

  // Mock the WrapperSigningKeyService via the route-level binRegistry seam.
  const binaries = createWrapperBinRegistry({ binRoot: BIN_ROOT });

  // Patch the internals: we need to inject `signing` — the route module
  // constructs its own. Workaround: monkey-patch the
  // createWrapperSigningKeyService by registering routes with a custom
  // binRegistry + replacing the service after registration is not feasible.
  // Easier: temporarily override the factory module via overriding the
  // global service. The route reads from ctx.db directly, so we plug a
  // fake DB that returns rows when the signer is "active".
  const signingFakeDb = signer
    ? ({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async (_n: number) => [
                {
                  id: 1,
                  algo: 'ed25519',
                  publicKey: 'pk',
                  // raw seed: we use a sentinel that toKeyObject can't decode
                  // BUT we override the SigningKey service via a route option
                  // (see below).
                  privateKeyEnc: 'placeholder',
                  active: 1,
                  createdAt: '2026-05-15T00:00:00Z',
                  rotatedAt: null,
                },
              ],
            }),
          }),
        }),
      } as unknown as Database)
    : ({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [],
            }),
          }),
        }),
      } as unknown as Database);

  // We can't easily replace the signing service inside registerWrapperV2Routes,
  // so we use the binRegistry override + a hand-rolled SigningKeyService
  // dependency injection by registering the routes against a special module.
  await registerRoutesWithSigningOverride(app, ctx, {
    binRegistry: binaries,
    signing: signingService(signer),
  });

  void signingFakeDb;
  return app;
}

async function buildProductionApp(
  ctx: RouteContext,
  signer: WrapperSigner,
  authHost: Host,
  binRoot: string,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(envelopePlugin);
  app.decorateRequest('authHost', undefined);
  app.decorate('requireHost', async (req: FastifyRequest) => {
    req.authHost = authHost;
  });
  await registerWrapperV2Routes(app, ctx, {
    binRoot,
    signingService: signingService(signer),
  });
  return app;
}

// Mini fork of registerWrapperV2Routes that accepts an explicit
// `signing` override. This is the only way to inject a deterministic Ed25519
// signer without making the production module accept it (which would muddy
// its public surface).
import {
  createWrapperConfigService,
  WrapperSigningUnavailableError,
  WRAPPER_CONFIG_SCHEMA_VERSION,
  canonicalStringify,
} from '../../../src/services/wrapper-config.js';
import { createWrapperMetaService } from '../../../src/services/wrapper-meta.js';
import { createWrapperDownloadService } from '../../../src/services/wrapper-download.js';
import { publishHostEvent } from '../../../src/services/ws-bridge.js';
import {
  ServiceUnavailableError,
  NotFoundError,
  ValidationError,
} from '../../../src/http/errors.js';
import { isEngine, parseEngine } from '../../../src/util/engine.js';
import {
  buildLegacyWrapperTransitionScript,
  isCxxBinaryUrl,
} from '../../../src/services/wrapper-transition.js';

async function registerRoutesWithSigningOverride(
  app: FastifyInstance,
  ctx: RouteContext,
  opts: { binRegistry: ReturnType<typeof createWrapperBinRegistry>; signing: WrapperSigningKeyService },
) {
  const binaries = opts.binRegistry;
  const signing = opts.signing;
  const installationId = ctx.env.INSTALLATION_ID ?? '';
  const configService = createWrapperConfigService({
    db: ctx.db,
    keyring: ctx.keyring,
    binaries,
    signing,
    installationId,
  });
  const meta = createWrapperMetaService({ binaries, schemaVersion: WRAPPER_CONFIG_SCHEMA_VERSION });
  const download = createWrapperDownloadService({ binaries });

  async function guard() {
    if (!(await signing.available())) {
      throw new ServiceUnavailableError(
        'wrapper v2 signing key not configured',
        'wrapper_v2_unavailable',
      );
    }
  }

  function baseUrl(req: FastifyRequest): string {
    return ctx.env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.headers.host}`;
  }

  app.get('/wrapper', { preHandler: [app.requireHost] }, async (req, reply) => {
    await guard();
    const eng = parseEngine((req.query as { engine?: string }).engine, 'codex');
    reply.header('cache-control', 'no-store');
    return await meta.forEngine(eng, baseUrl(req));
  });

  app.get('/wrapper/v2/meta', { preHandler: [app.requireHost] }, async (req, reply) => {
    await guard();
    const eng = parseEngine((req.query as { engine?: string }).engine, 'codex');
    reply.header('cache-control', 'no-store');
    return await meta.forEngine(eng, baseUrl(req));
  });

  app.get('/wrapper/v2/config', { preHandler: [app.requireHost] }, async (req, reply) => {
    await guard();
    const host = req.authHost!;
    const eng = parseEngine((req.query as { engine?: string }).engine, 'codex');
    let r;
    try {
      r = await configService.bakeForHost(host, eng, baseUrl(req));
    } catch (err) {
      if (err instanceof WrapperSigningUnavailableError) {
        throw new ServiceUnavailableError(
          'wrapper v2 signing key not configured',
          'wrapper_v2_unavailable',
        );
      }
      throw err;
    }
    if (r.bumped) {
      publishHostEvent('host.updated', host.id, { config_version: r.configVersion });
    }
    reply.envelopeRaw = true;
    reply.header('content-type', 'application/json');
    reply.header('cache-control', 'no-store');
    reply.header('etag', `"${r.payload.etag}"`);
    reply.header('x-sha256', r.payload.etag);
    reply.header('x-config-version', String(r.configVersion));
    reply.header('x-signature-algo', r.signature.algo);
    reply.header('x-signature-kid', r.signature.kid);
    reply.header('x-signature', r.signature.value);
    const body = canonicalStringify({ payload: r.payload, signature: r.signature });
    reply.header('content-length', Buffer.byteLength(body));
    return body;
  });

  app.get('/wrapper/v2/download', { preHandler: [app.requireHost] }, async (req, reply) => {
    await guard();
    const eng = parseEngine((req.query as { engine?: string }).engine, 'codex');
    const cur = await binaries.currentBuild(eng, 'linux', 'amd64');
    if (!cur) throw new NotFoundError('no binary', 'binary_not_found');
    return stream(req, reply, eng, 'linux', 'amd64', cur.version);
  });

  app.get('/wrapper/download', { preHandler: [app.requireHost] }, async (req, reply) => {
    await guard();
    const host = req.authHost!;
    const eng = parseEngine((req.query as { engine?: string }).engine, 'codex');
    let r;
    try {
      r = await configService.bakeForHost(host, eng, baseUrl(req));
    } catch (err) {
      if (err instanceof WrapperSigningUnavailableError) {
        throw new ServiceUnavailableError(
          'wrapper v2 signing key not configured',
          'wrapper_v2_unavailable',
        );
      }
      throw err;
    }
    if (r.bumped) {
      publishHostEvent('host.updated', host.id, { config_version: r.configVersion });
    }
    if (!isCxxBinaryUrl(r.payload.wrapper.binary_url)) {
      throw new ServiceUnavailableError(
        'common cxx artifact is not published for this platform',
        'wrapper_binary_unavailable',
      );
    }
    const body = buildLegacyWrapperTransitionScript({
      fqdn: host.fqdn,
      apiKey: r.payload.orchestrator.api_key,
      baseUrl: r.payload.orchestrator.base_url,
      engine: eng,
      allowInsecure: host.curlInsecure === 1,
      peerEngines: hostEnginesList(host.engines),
    });
    reply.envelopeRaw = true;
    reply.header('content-type', 'text/x-shellscript; charset=utf-8');
    reply.header('cache-control', 'no-store');
    return body;
  });

  app.get<{ Params: { engine: string } }>(
    '/wrapper/v2/manifest/:engine',
    { preHandler: [app.requireHost] },
    async (req, reply) => {
      await guard();
      if (!isEngine(req.params.engine)) throw new NotFoundError('unknown engine');
      reply.header('cache-control', 'no-store');
      return binaries.engineManifest(req.params.engine, baseUrl(req));
    },
  );

  app.get<{
    Params: { artifact: string; platform: string; version: string; binary: string };
  }>(
    '/wrapper/v2/bin/:artifact/:platform/v:version/:binary',
    { preHandler: [app.requireHost] },
    async (req, reply) => {
      await guard();
      const { artifact, platform, version, binary } = req.params;
      const m = /^([a-z0-9]+)-([a-z0-9]+)$/.exec(platform);
      if (!m || !m[1] || !m[2]) throw new ValidationError('bad platform', { param: 'platform' });

      if (artifact === CXX_ARTIFACT) {
        if (binary !== CXX_ARTIFACT) throw new NotFoundError('binary mismatch');
        return stream(req, reply, CXX_ARTIFACT, m[1], m[2], version);
      }

      if (!isEngine(artifact)) throw new NotFoundError('unknown engine');
      const expected = artifact === 'claude' ? 'clx' : 'cdx';
      if (binary !== expected) throw new NotFoundError('binary mismatch');
      return stream(req, reply, artifact, m[1], m[2], version);
    },
  );

  async function stream(
    req: FastifyRequest,
    reply: import('fastify').FastifyReply,
    artifact: WrapperArtifact,
    os: string,
    arch: string,
    version: string,
  ) {
    let opened;
    try {
      opened = await download.open(artifact, os, arch, version);
    } catch (err) {
      if (err instanceof BinaryNotFoundError) throw new NotFoundError(err.message);
      throw err;
    }
    const ifNoneMatch = req.headers['if-none-match'];
    if (opened.sha256 && typeof ifNoneMatch === 'string' && ifNoneMatch.replace(/"/g, '') === opened.sha256) {
      opened.stream.destroy();
      reply.envelopeRaw = true;
      reply.code(304);
      reply.header('etag', `"${opened.sha256}"`);
      return reply.send();
    }
    reply.envelopeRaw = true;
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${opened.fileName}"`);
    if (opened.sha256) {
      reply.header('etag', `"${opened.sha256}"`);
      reply.header('x-sha256', opened.sha256);
    }
    reply.header('content-length', String(opened.size));
    reply.header('cache-control', 'public, max-age=86400, immutable');
    return opened.stream;
  }
}

beforeAll(async () => {
  await sodium.ready;
});

describe('wrapper-v2 routes', () => {
  let kp: ReturnType<typeof generateKeyPairSync>;
  beforeAll(() => {
    kp = generateKeyPairSync('ed25519');
  });

  it('returns 503 with the standard envelope when the signing key is absent', async () => {
    const host = fakeHost();
    const app = await buildApp(
      { db: fakeDb(host), env: fakeEnv(), keyring: makeKeyring() },
      null,
      host,
    );
    for (const url of [
      '/wrapper/v2/meta',
      '/wrapper/v2/config',
      '/wrapper/v2/manifest/codex',
      '/wrapper/v2/download',
      '/wrapper/v2/bin/codex/linux-amd64/v1.0.1/cdx',
      '/wrapper/v2/bin/cxx/linux-amd64/v1.0.1/cxx',
      '/wrapper',
      '/wrapper/download',
    ]) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, `${url} should be 503`).toBe(503);
      const body = JSON.parse(r.payload) as { status: string; code: string; message: string };
      expect(body.status).toBe('error');
      expect(body.code).toBe('wrapper_v2_unavailable');
      expect(body.message).toMatch(/wrapper v2 signing key not configured/);
    }
    await app.close();
  });

  it('GET /wrapper/v2/meta returns an engine manifest with no-store', async () => {
    const host = fakeHost();
    const app = await buildApp(
      { db: fakeDb(host), env: fakeEnv(), keyring: makeKeyring() },
      makeSigner(kp.privateKey),
      host,
    );
    const r = await app.inject({ method: 'GET', url: '/wrapper/v2/meta' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(r.payload) as {
      status: string;
      engine: string;
      platforms: Record<string, { url_path: string }>;
    };
    expect(body.status).toBe('ok');
    expect(body.engine).toBe('codex');
    expect(body.platforms['linux-amd64']?.url_path).toBe(
      'https://api.test.example.com/wrapper/v2/bin/cxx/linux-amd64/v1.0.1/cxx',
    );
    await app.close();
  });

  it('GET /wrapper aliases /wrapper/v2/meta', async () => {
    const host = fakeHost();
    const app = await buildApp(
      { db: fakeDb(host), env: fakeEnv(), keyring: makeKeyring() },
      makeSigner(kp.privateKey),
      host,
    );
    const r = await app.inject({ method: 'GET', url: '/wrapper' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as { engine: string };
    expect(body.engine).toBe('codex');
    await app.close();
  });

  it('GET /wrapper/v2/config returns signed JSON + headers + emits host.updated', async () => {
    const host = fakeHost();
    const app = await buildApp(
      { db: fakeDb(host), env: fakeEnv(), keyring: makeKeyring() },
      makeSigner(kp.privateKey),
      host,
    );

    const events: unknown[] = [];
    const unsub = wsPublisher.subscribe((e) => events.push(e));

    const r = await app.inject({ method: 'GET', url: '/wrapper/v2/config' });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(/^application\/json/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers.etag).toBeTruthy();
    expect(r.headers['x-config-version']).toBeTruthy();
    expect(r.headers['x-signature-algo']).toBe('ed25519');
    expect(r.headers['x-signature']).toBeTruthy();

    const body = JSON.parse(r.payload) as {
      payload: {
        schema_version: number;
        etag: string;
        engine: string;
        wrapper: { binary_url: string };
      };
      signature: { algo: string; value: string; kid: string };
    };
    expect(body.payload.schema_version).toBe(1);
    expect(body.payload.engine).toBe('codex');
    expect(body.payload.wrapper.binary_url).toBe(
      'https://api.test.example.com/wrapper/v2/bin/cxx/linux-amd64/v1.0.1/cxx',
    );
    expect(body.payload.etag).toMatch(/^[a-f0-9]{64}$/);
    expect(body.signature.algo).toBe('ed25519');

    // Signature verifies via public key
    const canonical = (function canonical(v: unknown): string {
      if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
      if (v && typeof v === 'object') {
        const keys = Object.keys(v as object).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
      }
      return JSON.stringify(v);
    })(body.payload);
    const ok = cryptoVerify(
      null,
      Buffer.from(canonical, 'utf8'),
      kp.publicKey,
      Buffer.from(body.signature.value, 'base64'),
    );
    expect(ok).toBe(true);
    void createPublicKey;

    // host.updated published
    expect(events.some((e) => (e as { type: string }).type === 'host.updated')).toBe(true);
    unsub();
    await app.close();
  });

  it('GET /wrapper/download returns a legacy transition launcher instead of the raw binary', async () => {
    const host = fakeHost();
    host.engines = 'codex,claude';
    host.curlInsecure = 1;
    const app = await buildApp(
      { db: fakeDb(host), env: fakeEnv(), keyring: makeKeyring() },
      makeSigner(kp.privateKey),
      host,
    );
    const r = await app.inject({ method: 'GET', url: '/wrapper/download?engine=codex' });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(/^text\/x-shellscript/);
    expect(r.payload).toContain('legacy transition launcher');
    expect(r.payload).toContain('/wrapper/v2/config?engine=codex');
    expect(r.payload).toContain('/wrapper/v2/config?engine=claude');
    expect(r.payload).toContain(
      'CODEX_INSTALL_CURL_INSECURE=${CODEX_INSTALL_CURL_INSECURE:-1}',
    );
    expect(r.payload).toContain('TRANSITION_DIR=$(dirname "$TRANSITION_SELF")');
    expect(r.payload).toContain('exec "$TARGET_BIN" "$ENGINE" "$@"');
    expect(r.payload).not.toContain('cdx-binary-v1.0.1-payload');
    await app.close();
  });

  it('fails config and transition closed when cxx is only partially published', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrapper-v2-partial-cxx-'));
    const payload = 'partial darwin cxx';
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const binary = join(root, 'cxx', 'darwin-arm64', 'v2.0.0', 'cxx');
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, payload);
    await writeFile(
      join(root, 'cxx', 'darwin-arm64', 'manifest.json'),
      JSON.stringify({
        engine: 'cxx',
        os: 'darwin',
        arch: 'arm64',
        current: '2.0.0',
        builds: [
          { version: '2.0.0', sha256, size_bytes: Buffer.byteLength(payload) },
        ],
      }),
    );
    const host = fakeHost();
    const app = await buildProductionApp(
      { db: fakeDb(host), env: fakeEnv(), keyring: makeKeyring() },
      makeSigner(kp.privateKey),
      host,
      root,
    );
    try {
      for (const url of ['/wrapper/v2/config?engine=codex', '/wrapper/download?engine=codex']) {
        const response = await app.inject({
          method: 'GET',
          url,
          headers: { 'x-wrapper-platform': 'darwin-arm64' },
        });
        expect(response.statusCode, url).toBe(503);
        expect(JSON.parse(response.payload)).toMatchObject({
          status: 'error',
          code: 'wrapper_binary_unavailable',
        });
      }
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps split config compatibility but refuses a cxx transition when cxx is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrapper-v2-split-only-'));
    const payload = 'historical split cdx';
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const binary = join(root, 'codex', 'linux-amd64', 'v1.0.1', 'cdx');
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, payload);
    await writeFile(
      join(root, 'codex', 'linux-amd64', 'manifest.json'),
      JSON.stringify({
        engine: 'codex',
        os: 'linux',
        arch: 'amd64',
        current: '1.0.1',
        builds: [
          { version: '1.0.1', sha256, size_bytes: Buffer.byteLength(payload) },
        ],
      }),
    );
    const host = fakeHost();
    const app = await buildProductionApp(
      { db: fakeDb(host), env: fakeEnv(), keyring: makeKeyring() },
      makeSigner(kp.privateKey),
      host,
      root,
    );
    try {
      const configResponse = await app.inject({
        method: 'GET',
        url: '/wrapper/v2/config?engine=codex',
        headers: { 'x-wrapper-platform': 'linux-amd64' },
      });
      expect(configResponse.statusCode).toBe(200);
      expect(JSON.parse(configResponse.payload).payload.wrapper.binary_url).toContain(
        '/wrapper/v2/bin/codex/linux-amd64/v1.0.1/cdx',
      );

      const transitionResponse = await app.inject({
        method: 'GET',
        url: '/wrapper/download?engine=codex',
        headers: { 'x-wrapper-platform': 'linux-amd64' },
      });
      expect(transitionResponse.statusCode).toBe(503);
      expect(JSON.parse(transitionResponse.payload)).toMatchObject({
        status: 'error',
        code: 'wrapper_binary_unavailable',
      });
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['an empty object', {}],
    [
      'null builds',
      {
        engine: 'cxx',
        os: 'linux',
        arch: 'amd64',
        current: '2.0.0',
        builds: null,
      },
    ],
  ])('returns stable 503 for a cxx manifest with %s', async (_label, manifest) => {
    const root = await mkdtemp(join(tmpdir(), 'wrapper-v2-malformed-cxx-'));
    const manifestPath = join(root, 'cxx', 'linux-amd64', 'manifest.json');
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest));
    const host = fakeHost();
    const app = await buildProductionApp(
      { db: fakeDb(host), env: fakeEnv(), keyring: makeKeyring() },
      makeSigner(kp.privateKey),
      host,
      root,
    );
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/wrapper/v2/config?engine=codex',
        headers: { 'x-wrapper-platform': 'linux-amd64' },
      });
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.payload)).toMatchObject({
        status: 'error',
        code: 'wrapper_binary_unavailable',
      });
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('advertises the primary signing fingerprint without altering the signed shapes', async () => {
    const host = fakeHost();
    const signer = makeSigner(kp.privateKey);
    const app = await buildProductionApp(
      { db: fakeDb(host), env: fakeEnv(), keyring: makeKeyring() },
      signer,
      host,
      BIN_ROOT,
    );
    try {
      const fingerprint = createHash('sha256').update(rawPublicKey(kp.publicKey)).digest('hex');
      expect(signer.fingerprint).toBe(fingerprint);

      const metaResponse = await app.inject({ method: 'GET', url: '/wrapper/v2/meta' });
      expect(metaResponse.statusCode).toBe(200);
      const meta = JSON.parse(metaResponse.payload) as {
        signing_kid: string | null;
        signing_fingerprint: string | null;
      };
      expect(meta.signing_kid).toBe('1');
      expect(meta.signing_fingerprint).toBe(fingerprint);

      const configResponse = await app.inject({
        method: 'GET',
        url: '/wrapper/v2/config?engine=codex',
        headers: { 'x-wrapper-platform': 'linux-amd64' },
      });
      expect(configResponse.statusCode).toBe(200);
      expect(configResponse.headers['x-signature-fingerprint']).toBe(fingerprint);
      // The served body keeps exactly the three signature keys deployed
      // wrappers parse; the fingerprint rides in a header instead.
      const body = JSON.parse(configResponse.payload) as { signature: Record<string, string> };
      expect(Object.keys(body.signature).sort()).toEqual(['algo', 'kid', 'value']);
      expect(body.signature.value).toBe(configResponse.headers['x-signature']);

      const sigResponse = await app.inject({
        method: 'GET',
        url: '/wrapper/v2/config?engine=codex&sig=1',
        headers: { 'x-wrapper-platform': 'linux-amd64' },
      });
      expect(sigResponse.statusCode).toBe(200);
      expect(sigResponse.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(sigResponse.payload).toBe(sigResponse.headers['x-signature']);
      expect(sigResponse.headers['x-signature-fingerprint']).toBe(fingerprint);
    } finally {
      await app.close();
    }
  });

  it('GET /wrapper/v2/manifest/:engine returns 404 for unknown engines', async () => {
    const host = fakeHost();
    const app = await buildApp(
      { db: fakeDb(host), env: fakeEnv(), keyring: makeKeyring() },
      makeSigner(kp.privateKey),
      host,
    );
    const r = await app.inject({ method: 'GET', url: '/wrapper/v2/manifest/whatever' });
    expect(r.statusCode).toBe(404);
    await app.close();
  });

  it('GET /wrapper/v2/manifest/codex returns the engine manifest', async () => {
    const host = fakeHost();
    const app = await buildApp(
      { db: fakeDb(host), env: fakeEnv(), keyring: makeKeyring() },
      makeSigner(kp.privateKey),
      host,
    );
    const r = await app.inject({ method: 'GET', url: '/wrapper/v2/manifest/codex' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as {
      engine: string;
      platforms: Record<string, { url_path: string }>;
    };
    expect(body.engine).toBe('codex');
    expect(body.platforms['linux-amd64']?.url_path).toBe(
      'https://api.test.example.com/wrapper/v2/bin/cxx/linux-amd64/v1.0.1/cxx',
    );
    await app.close();
  });

  it('GET /wrapper/v2/bin/codex/linux-amd64/v1.0.0/cdx streams the binary', async () => {
    const host = fakeHost();
    const app = await buildApp(
      { db: fakeDb(host), env: fakeEnv(), keyring: makeKeyring() },
      makeSigner(kp.privateKey),
      host,
    );
    const r = await app.inject({
      method: 'GET',
      url: '/wrapper/v2/bin/codex/linux-amd64/v1.0.0/cdx',
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-disposition']).toBe('attachment; filename="cdx"');
    expect(r.rawPayload.toString('utf8').trim()).toBe('cdx-binary-v1.0.0-payload');
    await app.close();
  });

  it('GET /wrapper/v2/bin/cxx streams the canonical common artifact', async () => {
    const host = fakeHost();
    const app = await buildApp(
      { db: fakeDb(host), env: fakeEnv(), keyring: makeKeyring() },
      makeSigner(kp.privateKey),
      host,
    );
    const r = await app.inject({
      method: 'GET',
      url: '/wrapper/v2/bin/cxx/linux-amd64/v1.0.1/cxx',
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="cxx"');
    expect(r.headers['x-sha256']).toBe(
      '9fffd05c3633248e9442c56817d5bd9b6861e1ebcb63d856d42774277d5f0a66',
    );
    expect(r.rawPayload.toString('utf8').trim()).toBe('cxx-binary-v1.0.1-common-payload');
    await app.close();
  });

  it('streams common cxx bytes through a per-engine compatibility URL when no split file exists', async () => {
    const host = { ...fakeHost(), engines: 'codex,claude' };
    const app = await buildApp(
      { db: fakeDb(host), env: fakeEnv(), keyring: makeKeyring() },
      makeSigner(kp.privateKey),
      host,
    );
    const r = await app.inject({
      method: 'GET',
      url: '/wrapper/v2/bin/claude/linux-amd64/v1.0.1/clx',
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="clx"');
    expect(r.headers['x-sha256']).toBe(
      '9fffd05c3633248e9442c56817d5bd9b6861e1ebcb63d856d42774277d5f0a66',
    );
    expect(r.rawPayload.toString('utf8').trim()).toBe('cxx-binary-v1.0.1-common-payload');
    await app.close();
  });

  it('keeps a same-version historical cdx URL bound to its original bytes', async () => {
    const host = fakeHost();
    const app = await buildApp(
      { db: fakeDb(host), env: fakeEnv(), keyring: makeKeyring() },
      makeSigner(kp.privateKey),
      host,
    );
    const r = await app.inject({
      method: 'GET',
      url: '/wrapper/v2/bin/codex/linux-amd64/v1.0.1/cdx',
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="cdx"');
    expect(r.rawPayload.toString('utf8').trim()).toBe('cdx-binary-v1.0.1-payload');
    await app.close();
  });

  it('returns 404 for an unknown binary version', async () => {
    const host = fakeHost();
    const app = await buildApp(
      { db: fakeDb(host), env: fakeEnv(), keyring: makeKeyring() },
      makeSigner(kp.privateKey),
      host,
    );
    const r = await app.inject({
      method: 'GET',
      url: '/wrapper/v2/bin/codex/linux-amd64/v9.9.9/cdx',
    });
    expect(r.statusCode).toBe(404);
    await app.close();
  });

  it('returns 304 with ETag when If-None-Match matches the SHA', async () => {
    const host = fakeHost();
    const app = await buildApp(
      { db: fakeDb(host), env: fakeEnv(), keyring: makeKeyring() },
      makeSigner(kp.privateKey),
      host,
    );
    const sha = '058f6a3c5105ac486dd4ce670ceeace587f81762a2f6636f873292ac980c3da3';
    const r = await app.inject({
      method: 'GET',
      url: '/wrapper/v2/bin/codex/linux-amd64/v1.0.0/cdx',
      headers: { 'if-none-match': `"${sha}"` },
    });
    expect(r.statusCode).toBe(304);
    await app.close();
  });

  it('rejects /wrapper/v2/bin with a mismatched binary name', async () => {
    const host = fakeHost();
    const app = await buildApp(
      { db: fakeDb(host), env: fakeEnv(), keyring: makeKeyring() },
      makeSigner(kp.privateKey),
      host,
    );
    const r = await app.inject({
      method: 'GET',
      url: '/wrapper/v2/bin/codex/linux-amd64/v1.0.0/notthebinary',
    });
    expect(r.statusCode).toBe(404);
    await app.close();
  });
});
