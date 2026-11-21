import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import Negotiator from 'negotiator';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RouteContext } from '../../index.js';
import { notFoundHandler } from '../../../http/not-found.js';

const indexHtmlCache = new Map<string, string | null>();

function adminIndexHtml(root: string): string | null {
  if (indexHtmlCache.has(root)) return indexHtmlCache.get(root) ?? null;
  const indexHtmlPath = resolve(root, 'index.html');
  const indexHtml = existsSync(indexHtmlPath) ? readFileSync(indexHtmlPath, 'utf8') : null;
  indexHtmlCache.set(root, indexHtml);
  return indexHtml;
}

function varyOnAccept(reply: FastifyReply) {
  const current = String(reply.getHeader('vary') ?? '');
  const names = current.toLowerCase().split(',').map((name) => name.trim());
  if (!names.includes('*') && !names.includes('accept')) reply.header('vary', current ? current + ', Accept' : 'Accept');
}

function acceptsHtmlNavigation(req: FastifyRequest): boolean {
  const preferences = new Negotiator(req);
  // Generic HTTP clients send */*. Only an explicit HTML preference is a navigation.
  return preferences.mediaTypes().some((type) => type.toLowerCase() === 'text/html') &&
    preferences.mediaType(['application/json', 'text/html']) === 'text/html';
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
    if (!indexHtml || !['GET', 'HEAD'].includes(req.method)) return;
    varyOnAccept(reply);
    if (!acceptsHtmlNavigation(req)) return;
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
    setHeaders: (reply, path) => {
      if (path.includes('/_app/immutable/')) {
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (path.endsWith('.html')) {
        reply.header('Cache-Control', 'no-cache');
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
    const [path = ''] = req.url.split('?', 1);
    if (indexHtml && (req.method === 'GET' || req.method === 'HEAD') && (path === '/admin' || path.startsWith('/admin/'))) {
      varyOnAccept(reply);
      if (path !== '/admin' && path !== '/admin/' && !acceptsHtmlNavigation(req)) return notFoundHandler(req, reply);
      reply.envelopeRaw = true;
      reply.header('content-type', 'text/html; charset=utf-8');
      reply.header('cache-control', 'no-cache');
      return reply.send(indexHtml);
    }
    return notFoundHandler(req, reply);
  });
  return true;
}
