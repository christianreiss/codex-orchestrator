import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RouteContext } from '../../index.js';
import { selectFormatter } from '../../../http/envelope/select.js';
import { ApiError } from '../../../http/errors.js';

const indexHtmlCache = new Map<string, string | null>();

function adminIndexHtml(root: string): string | null {
  if (indexHtmlCache.has(root)) return indexHtmlCache.get(root) ?? null;
  const indexHtmlPath = resolve(root, 'index.html');
  const indexHtml = existsSync(indexHtmlPath) ? readFileSync(indexHtmlPath, 'utf8') : null;
  indexHtmlCache.set(root, indexHtml);
  return indexHtml;
}

function acceptsHtmlNavigation(req: FastifyRequest): boolean {
  const raw = req.headers.accept;
  const accept = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof accept !== 'string') return false;
  const textHtml = accept.indexOf('text/html');
  if (textHtml === -1) return false;
  const json = accept.indexOf('application/json');
  return json === -1 || textHtml < json;
}

/**
 * Several admin URLs are both Svelte client routes and JSON API endpoints.
 * Browser navigations advertise text/html and should receive the SPA shell;
 * the Svelte API client sends application/json and keeps the JSON contract.
 */
export function adminSpaHtmlPreHandler(ctx: RouteContext) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const root = ctx.env.STATIC_ROOT;
    const indexHtml = root ? adminIndexHtml(root) : null;
    if (!indexHtml || !['GET', 'HEAD'].includes(req.method) || !acceptsHtmlNavigation(req)) return;
    reply.envelopeRaw = true;
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'no-cache');
    return reply.send(indexHtml);
  };
}

/**
 * Serves the built SvelteKit SPA at /admin and the manual articles at
 * /admin/manual/articles/. The SPA's HTML is returned as the fallback for
 * unmatched /admin/* paths so client-side routing works on reload.
 */
export async function registerStaticAdminRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<boolean> {
  const root = ctx.env.STATIC_ROOT;
  if (!root || !existsSync(root)) {
    app.log.warn({ root }, 'static admin root missing; skipping /admin static mount');
    return false;
  }

  const indexHtml = adminIndexHtml(root);

  await app.register(fastifyStatic, {
    root,
    prefix: '/admin/',
    decorateReply: false,
    wildcard: true,
    index: ['index.html'],
    serve: true,
    setHeaders: (res, path) => {
      if (path.includes('/_app/immutable/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (path.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  });

  // SPA HTML fallback: any GET /admin/* that the static plugin doesn't resolve
  // to a real file and that accepts text/html should return index.html so
  // client-side routing works on reload. We use Fastify's notFoundHandler
  // mechanism, scoped via the request URL prefix.
  // Override the envelope plugin's notFoundHandler with one that serves the
  // SPA index for HTML GETs under /admin and falls through to the standard
  // envelope's not-found JSON otherwise.
  app.setNotFoundHandler((req, reply) => {
    const wantsHtml =
      typeof req.headers.accept === 'string' && req.headers.accept.includes('text/html');
    if (
      indexHtml &&
      req.method === 'GET' &&
      req.url.startsWith('/admin') &&
      (req.url === '/admin' || req.url === '/admin/' || wantsHtml)
    ) {
      reply.envelopeRaw = true;
      reply.header('content-type', 'text/html; charset=utf-8');
      reply.header('cache-control', 'no-cache');
      return reply.send(indexHtml);
    }
    const formatter = selectFormatter(req.url);
    const err = new ApiError('Route not found', {
      status: 404,
      code: 'not_found',
      type: 'not_found_error',
    });
    reply.envelopeRaw = true;
    reply.status(404).header('content-type', 'application/json; charset=utf-8');
    return reply.send(JSON.stringify(formatter.failure(err)));
  });
  return true;
}
