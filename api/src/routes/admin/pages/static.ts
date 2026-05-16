import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RouteContext } from '../../index.js';

/**
 * Serves the built SvelteKit SPA at /admin and the manual articles at
 * /admin/manual/articles/. The SPA's HTML is returned as the fallback for
 * unmatched /admin/* paths so client-side routing works on reload.
 */
export async function registerStaticAdminRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const root = ctx.env.STATIC_ROOT;
  if (!root || !existsSync(root)) {
    app.log.warn({ root }, 'static admin root missing; skipping /admin static mount');
    return;
  }

  await app.register(fastifyStatic, {
    root,
    prefix: '/admin/',
    decorateReply: false,
    wildcard: false,
    serve: true,
    setHeaders: (res, path) => {
      if (path.includes('/_app/immutable/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (path.endsWith('.html') || path.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  });

  const indexHtmlPath = resolve(root, 'index.html');
  let indexHtml: string | null = null;
  if (existsSync(indexHtmlPath)) indexHtml = readFileSync(indexHtmlPath, 'utf8');

  app.get('/admin', async (_req, reply) => {
    if (!indexHtml) {
      reply.status(404);
      return { status: 'error', message: 'admin SPA not built' };
    }
    reply.envelopeRaw = true;
    reply.header('content-type', 'text/html; charset=utf-8');
    return indexHtml;
  });

  // SPA fallback: any GET under /admin/* that doesn't resolve to a static file
  // and that accepts HTML should return index.html. We register this as a 404
  // handler scoped to /admin/* via a setNotFoundHandler-equivalent fallback.
  app.get('/admin/*', async (req, reply) => {
    const accept = req.headers.accept ?? '';
    if (!accept.includes('text/html')) {
      reply.status(404);
      return { status: 'error', message: 'Not found', code: 'not_found' };
    }
    if (!indexHtml) {
      reply.status(404);
      return { status: 'error', message: 'admin SPA not built' };
    }
    reply.envelopeRaw = true;
    reply.header('content-type', 'text/html; charset=utf-8');
    return indexHtml;
  });
}
