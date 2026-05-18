import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { join, resolve } from 'node:path';
import type { RouteContext } from '../index.js';
import { ENGINES, isEngine, parseEngine, type Engine } from '../../util/engine.js';
import { ServiceUnavailableError, NotFoundError, ValidationError } from '../../http/errors.js';
import {
  createWrapperBinRegistry,
  BinaryNotFoundError,
  type WrapperBinRegistry,
} from '../../services/wrapper-bin-registry.js';
import { createWrapperSigningKeyService } from '../../services/wrapper-signing-key.js';
import {
  createWrapperConfigService,
  canonicalStringify,
  WrapperSigningUnavailableError,
  WRAPPER_CONFIG_SCHEMA_VERSION,
} from '../../services/wrapper-config.js';
import { createWrapperMetaService } from '../../services/wrapper-meta.js';
import { createWrapperDownloadService } from '../../services/wrapper-download.js';
import { buildLegacyWrapperShimScript } from '../../services/wrapper-transition.js';
import { publishHostEvent } from '../../services/ws-bridge.js';

/**
 * Wrapper bakery v2 endpoints.
 *
 *   GET  /wrapper                        → alias for /wrapper/v2/meta
 *   GET  /wrapper/download               → legacy shell transition shim
 *   GET  /wrapper/v2/meta                → per-engine version + sha256 + signing kid
 *   GET  /wrapper/v2/config              → signed per-host config JSON
 *   GET  /wrapper/v2/download            → binary stream for the calling host's platform
 *   GET  /wrapper/v2/manifest/:engine    → per-platform manifest
 *   GET  /wrapper/v2/bin/:engine/:plat/v:version/:binary → static binary
 *
 * Every endpoint is host-authenticated via `app.requireHost`.
 *
 * When the active wrapper signing key is absent every endpoint returns a
 * 503 with the standard envelope: `{ status: 'error', code:
 * 'wrapper_v2_unavailable', message: 'wrapper v2 signing key not
 * configured' }`. The route honours that even for endpoints that don't
 * actually sign anything — the absence indicates the bakery is intentionally
 * disabled, so binary serving should fail closed too.
 */

export interface WrapperV2RouteOptions {
  /** Override the directory containing `bin/<engine>/<os>-<arch>/...`. */
  binRoot?: string;
  /** Override the public base URL (default: `request.protocol://request.host`). */
  publicBaseUrl?: string;
  /** Pre-built registry — primarily for tests. */
  binRegistry?: WrapperBinRegistry;
  /** Optional installation id (otherwise falls back to env.INSTALLATION_ID). */
  installationId?: string;
}

export async function registerWrapperV2Routes(
  app: FastifyInstance,
  ctx: RouteContext,
  opts: WrapperV2RouteOptions = {},
): Promise<void> {
  const binRoot = opts.binRoot ?? resolveBinRoot(ctx);
  const binaries = opts.binRegistry ?? createWrapperBinRegistry({ binRoot });
  const signing = createWrapperSigningKeyService({ db: ctx.db, keyring: ctx.keyring });
  const installationId = opts.installationId ?? ctx.env.INSTALLATION_ID ?? '';
  const configService = createWrapperConfigService({
    db: ctx.db,
    keyring: ctx.keyring,
    binaries,
    signing,
    installationId,
  });
  const meta = createWrapperMetaService({ binaries, schemaVersion: WRAPPER_CONFIG_SCHEMA_VERSION });
  const download = createWrapperDownloadService({ binaries });

  async function unavailableGuard(): Promise<void> {
    if (await signing.available()) return;
    throw new ServiceUnavailableError(
      'wrapper v2 signing key not configured',
      'wrapper_v2_unavailable',
    );
  }

  function resolvePublicBaseUrl(req: FastifyRequest): string {
    if (opts.publicBaseUrl) return opts.publicBaseUrl;
    if (ctx.env.PUBLIC_BASE_URL) return ctx.env.PUBLIC_BASE_URL;
    const proto = headerString(req.headers['x-forwarded-proto']) ?? req.protocol ?? 'http';
    const host =
      headerString(req.headers['x-forwarded-host']) ?? headerString(req.headers.host) ?? 'localhost';
    return `${proto}://${host}`;
  }

  function engineFromQuery(req: FastifyRequest): Engine {
    const q = (req.query ?? {}) as { engine?: string };
    return parseEngine(q.engine, 'codex');
  }

  function platformFromHeaders(req: FastifyRequest): { os: string; arch: string } {
    const ua = headerString(req.headers['user-agent']) ?? '';
    const xPlat = headerString(req.headers['x-wrapper-platform']) ?? '';
    const fromHeader = /^([a-z0-9]+)-([a-z0-9]+)$/.exec(xPlat);
    if (fromHeader && fromHeader[1] && fromHeader[2]) {
      return { os: fromHeader[1], arch: fromHeader[2] };
    }
    let os = 'linux';
    let arch = 'amd64';
    if (/darwin|mac/i.test(ua)) os = 'darwin';
    if (/arm64|aarch64/i.test(ua)) arch = 'arm64';
    return { os, arch };
  }

  // GET /wrapper/v2/meta — engine-level manifest.
  app.get('/wrapper/v2/meta', { preHandler: [app.requireHost] }, (req, reply) =>
    metaHandler(req, reply),
  );

  // Alias: GET /wrapper
  app.get('/wrapper', { preHandler: [app.requireHost] }, (req, reply) => metaHandler(req, reply));

  async function metaHandler(req: FastifyRequest, reply: FastifyReply) {
    await unavailableGuard();
    const engine = engineFromQuery(req);
    const baseUrl = resolvePublicBaseUrl(req);
    const data = await meta.forEngine(engine, baseUrl);
    reply.header('cache-control', 'no-store');
    return data;
  }

  // GET /wrapper/v2/config — signed per-host config JSON.
  app.get('/wrapper/v2/config', { preHandler: [app.requireHost] }, async (req, reply) => {
    await unavailableGuard();
    const host = req.authHost;
    if (!host)
      throw new ServiceUnavailableError('host context missing', 'host_context_missing');
    const engine = engineFromQuery(req);
    const baseUrl = resolvePublicBaseUrl(req);

    let result;
    try {
      result = await configService.bakeForHost(host, engine, baseUrl);
    } catch (err) {
      if (err instanceof WrapperSigningUnavailableError) {
        throw new ServiceUnavailableError(
          'wrapper v2 signing key not configured',
          'wrapper_v2_unavailable',
        );
      }
      throw err;
    }

    if (result.bumped) {
      publishHostEvent('host.updated', host.id, { config_version: result.configVersion });
    }

    reply.envelopeRaw = true;
    reply.header('content-type', 'application/json');
    reply.header('cache-control', 'no-store');
    reply.header('etag', `"${result.payload.etag}"`);
    reply.header('x-sha256', result.payload.etag);
    reply.header('x-config-version', String(result.configVersion));
    reply.header('x-signature-algo', result.signature.algo);
    reply.header('x-signature-kid', result.signature.kid);
    reply.header('x-signature', result.signature.value);
    const body = canonicalStringify({
      payload: result.payload,
      signature: result.signature,
    });
    reply.header('content-length', Buffer.byteLength(body));
    return body;
  });

  // GET /wrapper/v2/download — binary for the calling host's platform.
  app.get('/wrapper/v2/download', { preHandler: [app.requireHost] }, (req, reply) =>
    downloadHandler(req, reply),
  );
  // GET /wrapper/download — date-versioned shell wrappers update through this
  // URL, so serve a tiny transition script that writes the signed v2 config
  // before it execs the Go binary.
  app.get('/wrapper/download', { preHandler: [app.requireHost] }, (req, reply) =>
    legacyShimHandler(req, reply),
  );

  async function downloadHandler(req: FastifyRequest, reply: FastifyReply) {
    await unavailableGuard();
    const engine = engineFromQuery(req);
    const { os, arch } = platformFromHeaders(req);
    const build = await binaries.currentBuild(engine, os, arch);
    if (!build)
      throw new NotFoundError(
        `no published binary for ${engine}/${os}-${arch}`,
        'binary_not_found',
      );
    return streamBinary(req, reply, engine, os, arch, build.version);
  }

  async function legacyShimHandler(req: FastifyRequest, reply: FastifyReply) {
    await unavailableGuard();
    const host = req.authHost;
    if (!host)
      throw new ServiceUnavailableError('host context missing', 'host_context_missing');
    const engine = engineFromQuery(req);
    const baseUrl = resolvePublicBaseUrl(req);

    let result;
    try {
      result = await configService.bakeForHost(host, engine, baseUrl);
    } catch (err) {
      if (err instanceof WrapperSigningUnavailableError) {
        throw new ServiceUnavailableError(
          'wrapper v2 signing key not configured',
          'wrapper_v2_unavailable',
        );
      }
      throw err;
    }

    if (result.bumped) {
      publishHostEvent('host.updated', host.id, { config_version: result.configVersion });
    }

    const body = buildLegacyWrapperShimScript({
      fqdn: host.fqdn,
      apiKey: result.payload.orchestrator.api_key,
      baseUrl: result.payload.orchestrator.base_url,
      engine,
    });
    reply.envelopeRaw = true;
    reply.header('content-type', 'text/x-shellscript; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${engine === 'claude' ? 'clx' : 'cdx'}"`);
    reply.header('cache-control', 'no-store');
    reply.header('x-config-version', String(result.configVersion));
    reply.header('content-length', Buffer.byteLength(body));
    return body;
  }

  // GET /wrapper/v2/manifest/:engine
  app.get<{ Params: { engine: string } }>(
    '/wrapper/v2/manifest/:engine',
    { preHandler: [app.requireHost] },
    async (req, reply) => {
      await unavailableGuard();
      const engine = req.params.engine;
      if (!isEngine(engine)) throw new NotFoundError('unknown engine', 'unknown_engine');
      const baseUrl = resolvePublicBaseUrl(req);
      const data = await binaries.engineManifest(engine, baseUrl);
      reply.header('cache-control', 'no-store');
      return data;
    },
  );

  // GET /wrapper/v2/bin/:engine/:platform/v:version/:binary
  app.get<{
    Params: { engine: string; platform: string; version: string; binary: string };
  }>(
    '/wrapper/v2/bin/:engine/:platform/v:version/:binary',
    { preHandler: [app.requireHost] },
    async (req, reply) => {
      await unavailableGuard();
      const { engine, platform, version, binary } = req.params;
      if (!isEngine(engine)) throw new NotFoundError('unknown engine', 'unknown_engine');
      const m = /^([a-z0-9]+)-([a-z0-9]+)$/.exec(platform);
      if (!m || !m[1] || !m[2])
        throw new ValidationError('bad platform', { param: 'platform' });
      const expectedName = engine === 'claude' ? 'clx' : 'cdx';
      if (binary !== expectedName) throw new NotFoundError('binary mismatch', 'binary_mismatch');
      return streamBinary(req, reply, engine, m[1], m[2], version);
    },
  );

  async function streamBinary(
    req: FastifyRequest,
    reply: FastifyReply,
    engine: Engine,
    os: string,
    arch: string,
    version: string,
  ) {
    let opened;
    try {
      opened = await download.open(engine, os, arch, version);
    } catch (err) {
      if (err instanceof BinaryNotFoundError) {
        throw new NotFoundError(err.message, 'binary_not_found');
      }
      throw err;
    }

    const ifNoneMatch = req.headers['if-none-match'];
    if (
      opened.sha256 &&
      typeof ifNoneMatch === 'string' &&
      ifNoneMatch.replace(/"/g, '') === opened.sha256
    ) {
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

  // Engines list is exposed for introspection by other plugins if they need
  // it — currently unused but harmless.
  void ENGINES;
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function resolveBinRoot(ctx: RouteContext): string {
  // Default: walk up from src/ to project root + storage/wrapper/v2/bin.
  return ctx.env.DATA_ROOT
    ? join(ctx.env.DATA_ROOT, 'wrapper', 'v2', 'bin')
    : resolve(import.meta.dirname, '..', '..', '..', '..', 'storage', 'wrapper', 'v2', 'bin');
}
