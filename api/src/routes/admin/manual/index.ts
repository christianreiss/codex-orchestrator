import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../../index.js';
import { NotFoundError, ValidationError } from '../../../http/errors.js';
import { ManualStore } from '../../../services/manual-articles.js';
import { searchManual } from '../../../services/manual-search.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function registerAdminManualRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const store = new ManualStore(ctx.env.STATIC_ROOT);

  // GET /admin/manual/manifest — every article + metadata
  app.get(
    '/admin/manual/manifest',
    { preHandler: [app.requireAdmin] },
    async () => {
      return store.manifest();
    },
  );

  // GET /admin/manual/search?q=… — naive substring search across bodies
  app.get(
    '/admin/manual/search',
    { preHandler: [app.requireAdmin] },
    async (req) => {
      const q = String((req.query as { q?: unknown })?.q ?? '').trim();
      if (!q) return { query: '', hits: [] };
      const hits = searchManual(store, q);
      return { query: q, hits };
    },
  );

  // GET /admin/manual/article/:slug — rendered markdown body (and meta)
  app.get<{ Params: { slug: string } }>(
    '/admin/manual/article/:slug',
    { preHandler: [app.requireAdmin] },
    async (req) => {
      const slug = req.params.slug;
      if (!SLUG_RE.test(slug)) {
        throw new ValidationError('Invalid article slug', { param: 'slug' });
      }
      const article = store.article(slug);
      if (!article) throw new NotFoundError('Article not found');
      return {
        slug: article.slug,
        meta: article.meta,
        body: article.body,
      };
    },
  );
}
