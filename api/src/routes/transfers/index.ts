import type { FastifyInstance, FastifyRequest } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { RouteContext } from '../index.js';
import { clientConfigDocuments, type Host } from '../../db/schema.js';
import { AgentTransfersService } from '../../services/agent-transfers.js';
import { BINARY_CHUNK_BYTES } from '../../services/agent-transfers/binary.js';
import { SettingsService } from '../../services/settings.js';
import { createHostAuthService } from '../../services/host-auth.js';
import { createInsecureWindowService } from '../../services/insecure-window.js';
import { assertHostEngineEnabled } from '../../services/host-engine-policy.js';
import { readFleetEngineState } from '../../services/engine-switch.js';
import { normalizeSettings } from '../../services/config-normalizer.js';
import { ForbiddenError, ValidationError } from '../../http/errors.js';
import { ownerRuntimeFor } from '../../control-plane/state/runtime.js';

const inputSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    size_bytes: z.number().int().nonnegative().safe(),
    content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    ttl_seconds: z.number().int().nonnegative().max(0xffffffff),
    username: z.string().max(255).optional(),
    worktree_path: z.string().max(512).optional(),
    description: z.string().max(2000).optional(),
    mime_type: z.string().max(255).optional(),
  })
  .strict();

type Params = { id: string };

export async function registerTransfersRoutes(app: FastifyInstance, ctx: RouteContext) {
  const insecure = createInsecureWindowService({ db: ctx.db, env: ctx.env });
  const auth = createHostAuthService({ db: ctx.db, env: ctx.env, insecure });
  const transfers = new AgentTransfersService({
    db: ctx.db,
    settings: new SettingsService(ctx.db),
    dataRoot: ctx.env.DATA_ROOT ?? '/app/storage',
  });
  await app.register(async (app) => {
    // A stream parser is scoped to the binary routes; JSON/MCP retain their
    // normal body limits. Authentication runs before any body is consumed.
    app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
    app.decorateRequest('transferHost', null);
    app.addHook('onRequest', async (req) => {
      const raw = await auth.authenticate(req);
      const host = raw.secure === 1 ? raw : await insecure.enforce(raw, 'binary_transfer', req.clientIp);
      const engine = (req.query as { engine?: string }).engine;
      if (engine !== 'codex' && engine !== 'claude' && engine !== 'grok')
        throw new ValidationError('engine must be codex, claude or grok');
      assertHostEngineEnabled(host, engine, await readFleetEngineState(ctx.db));
      const owner = ownerRuntimeFor(ctx.db);
      owner?.assertOwner();
      const rows = owner ? owner.state.snapshot().table('clientConfigDocuments').all()
        .filter(row => row.engine === engine).sort((a, b) => b.id - a.id).slice(0, 1) : await ctx.db
        .select()
        .from(clientConfigDocuments)
        .where(eq(clientConfigDocuments.engine, engine))
        .orderBy(desc(clientConfigDocuments.id))
        .limit(1);
      const row = rows.find((r) => r.engine === engine);
      if (!row && engine !== 'claude') throw new ForbiddenError('Managed configuration missing');
      const settings = normalizeSettings(row?.settings ?? {}, {
        engine,
        applyCodexDefaults: engine === 'codex',
      });
      if (settings.orchestrator_mcp_enabled === false || !(await transfers.getEnabled()))
        throw new ForbiddenError('File transfer is disabled');
      (req as TransferRequest).transferHost = host;
    });

    app.post('/host/transfers', async (req) => {
      const parsed = inputSchema.safeParse(req.body);
      if (!parsed.success)
        throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid upload metadata');
      const transfer = await transfers.createBinary(parsed.data, (req as TransferRequest).transferHost);
      return { transfer, chunk_bytes: BINARY_CHUNK_BYTES };
    });
    app.get<{ Params: Params }>('/host/transfers/:id', async (req) => ({
      transfer: await transfers.info(req.params.id),
      chunk_bytes: BINARY_CHUNK_BYTES,
    }));
    app.put<{ Params: Params; Querystring: { offset?: string } }>(
      '/host/transfers/:id/content',
      async (req) => {
        if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/octet-stream')
          throw new ValidationError('Use application/octet-stream');
        const offset = req.query.offset === undefined ? NaN : Number(req.query.offset);
        const length = Number(req.headers['content-length'] ?? NaN);
        return {
          transfer: await transfers.appendBinary(
            req.params.id,
            offset,
            length,
            req.body as AsyncIterable<Buffer>,
            (req as TransferRequest).transferHost,
          ),
        };
      },
    );
    app.post<{ Params: Params }>('/host/transfers/:id/complete', async (req) => ({
      transfer: await transfers.sealBinary(req.params.id, (req as TransferRequest).transferHost),
    }));
    app.get<{ Params: Params }>('/host/transfers/:id/content', async (req, reply) => {
      let offset = 0;
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d+)-$/.exec(range);
        if (!match)
          return reply.code(416).send({ message: 'Only a single open-ended byte range is supported' });
        offset = Number(match[1]);
      }
      const metadata = await transfers.info(req.params.id);
      if (!Number.isSafeInteger(offset) || offset < 0 || (range && offset >= metadata.size_bytes)) {
        return reply
          .code(416)
          .header('Content-Range', `bytes */${metadata.size_bytes}`)
          .send({ message: 'Range outside transfer' });
      }
      const host = (req as TransferRequest).transferHost;
      const { transfer, stream, completed } = await transfers.openBinaryDownload(req.params.id, offset, {
        kind: 'agent',
        label: null,
        hostId: host.id,
      });
      reply.raw.once('finish', () => {
        if (stream.readableEnded)
          void completed().catch((error) =>
            app.log.error({ err: error }, 'Transfer download counter failed'),
          );
      });
      reply.raw.once('close', () => stream.destroy());
      reply
        .code(range ? 206 : 200)
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Length', String(transfer.size_bytes - offset))
        .header('Accept-Ranges', 'bytes')
        .header('ETag', `"${transfer.content_sha256}"`)
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header(
          'Content-Disposition',
          `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(transfer.name)}`,
        );
      if (range)
        reply.header('Content-Range', `bytes ${offset}-${transfer.size_bytes - 1}/${transfer.size_bytes}`);
      return reply.send(stream);
    });
  });
}

type TransferRequest = FastifyRequest & { transferHost: Host };
