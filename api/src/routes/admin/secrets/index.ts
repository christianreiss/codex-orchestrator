import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { ApiError, ValidationError } from '../../../http/errors.js';
import { AdminEventsService } from '../../../services/admin-events.js';
import { SecretsService, type SecretMetadata } from '../../../services/secrets.js';
import { adminSpaHtmlPreHandler } from '../pages/static.js';

/**
 * Admin CRUD for the fleet secrets store.
 *
 * Two properties this module is built around:
 *
 *  1. The normal DTO cannot carry a value. `toAdminSecret` takes a `SecretMetadata`,
 *     which has no ciphertext field at all, and returns an enumerated literal
 *     rather than a spread — so no future edit to the service's row shape can
 *     leak an envelope into a list response by accident.
 *  2. Reading a plaintext is a separate, explicitly gated `POST`. Separate so
 *     property 1 survives; `POST` because a `GET` can be prefetched by a
 *     browser, cached by an intermediary, and replayed out of history, none of
 *     which should ever happen to a credential.
 *
 * Mutations are role-gated on top of `requireAdmin`: enabling, disabling,
 * rotating or revealing a fleet credential is not something a viewer session
 * should be able to do. That includes the module switch — unlike the projects
 * module toggle, which carries `requireAdmin` alone.
 */

const createSchema = z.object({
  slug: z.string().trim().min(1, 'slug is required').max(96),
  name: z.string().trim().min(1, 'name is required'),
  value: z.string().min(1, 'value is required'),
  description: z.string().trim().optional().nullable(),
  engine: z.enum(['codex', 'claude']).optional().nullable(),
  tags: z.array(z.string().trim().min(1)).max(32).optional(),
});

// `slug` is omitted deliberately: it is the lookup key agents hold, and a rename
// would silently break every agent that learned it. Delete and recreate instead.
//
// `.strict()` is what makes that a refusal rather than a shrug. A bare
// `.omit({slug:true})` still *parses* `{slug:"renamed"}` — zod strips unknown
// keys — so the request would return 200 having changed nothing, and the
// operator would believe the rename took.
const updateSchema = createSchema.partial().omit({ slug: true }).strict();

const stateSchema = z.object({
  enabled: z.union([z.boolean(), z.literal(0), z.literal(1), z.enum(['0', '1', 'true', 'false'])]),
});

function badRequest(issue: { message?: string; path?: (string | number)[] } | undefined): ApiError {
  const param = issue?.path?.length ? issue.path.join('.') : undefined;
  const message = issue?.message ?? 'Invalid request body';
  return new ApiError(param ? `${param}: ${message}` : message, {
    status: 400,
    code: 'invalid_request',
    type: 'invalid_request_error',
    param,
    // The standard envelope renders `code`/`message` and merges `extra`, but
    // drops `param` — that field only reaches the `/v1/*` OpenAI shape. Passing
    // it through `extra` too is what lets an admin client point at the offending
    // field instead of re-deriving it from the message.
    ...(param ? { extra: { param } } : {}),
  });
}

function idFrom(value: unknown): number {
  const id = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new ValidationError('id must be a positive integer', { param: 'id' });
  }
  return id;
}

function notFound(): ApiError {
  return new ApiError('No such secret', {
    status: 404,
    code: 'secret_not_found',
    type: 'not_found_error',
  });
}

export async function registerAdminSecretsRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const secrets = new SecretsService({ db: ctx.db, keyring: ctx.keyring });
  const events = new AdminEventsService(ctx.db);
  // `/admin/secrets` is both the JSON listing and the SPA's own client route, so
  // a browser navigating there would otherwise get 401 JSON instead of the app
  // shell. Same split the users and projects pages already use: text/html gets
  // the shell, application/json keeps the API contract.
  const adminSpa = adminSpaHtmlPreHandler(ctx);

  // Mutation and reveal are `secrets.manage` and `secrets.reveal` in
  // `security/route-capabilities.ts`; the plugin applies them. Reveal is split
  // from manage because reading a value and changing one are different risks.

  const actor = (req: FastifyRequest): number | null => req.admin?.user.id ?? null;

  // ── module switch ─────────────────────────────────────────────────────────

  app.get('/admin/secrets/state', { preHandler: app.requireAdmin }, async () => {
    return await secrets.adminState();
  });

  app.post(
    '/admin/secrets/state',
    { preHandler: app.requireAdmin },
    async (req) => {
      const parsed = stateSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw badRequest(parsed.error.issues[0]);
      const raw = parsed.data.enabled;
      const enabled = raw === true || raw === 1 || raw === '1' || raw === 'true';
      const state = await secrets.setEnabled(enabled);
      await events.record({
        type: 'secret.module_toggled',
        payload: { enabled, admin_user_id: actor(req) },
      });
      return state;
    },
  );

  // ── CRUD ──────────────────────────────────────────────────────────────────

  app.get('/admin/secrets', { preHandler: [adminSpa, app.requireAdmin] }, async (req) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const includeDeleted = query['include_deleted'] === '1' || query['include_deleted'] === 'true';
    const rows = await secrets.list({ includeDeleted });
    return { secrets: rows.map(toAdminSecret) };
  });

  app.get('/admin/secrets/:id', { preHandler: app.requireAdmin }, async (req) => {
    const id = idFrom((req.params as { id?: unknown }).id);
    const secret = await secrets.findById(id, { includeDeleted: true });
    if (!secret) throw notFound();
    return { secret: toAdminSecret(secret) };
  });

  app.post(
    '/admin/secrets',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const parsed = createSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw badRequest(parsed.error.issues[0]);
      const created = await secrets.create({
        slug: parsed.data.slug,
        name: parsed.data.name,
        value: parsed.data.value,
        description: parsed.data.description ?? null,
        engine: parsed.data.engine ?? null,
        tags: parsed.data.tags ?? [],
      });
      // Ids and slugs only — never a value, and never anything derived from one.
      await events.record({
        type: 'secret.created',
        payload: { secret_id: created.id, slug: created.slug, admin_user_id: actor(req) },
      });
      reply.code(201);
      return { secret: toAdminSecret(created) };
    },
  );

  app.patch(
    '/admin/secrets/:id',
    { preHandler: app.requireAdmin },
    async (req) => {
      const id = idFrom((req.params as { id?: unknown }).id);
      const parsed = updateSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw badRequest(parsed.error.issues[0]);
      const result = await secrets.update(id, parsed.data);
      if (!result) throw notFound();
      await events.record({
        type: 'secret.updated',
        payload: {
          secret_id: result.secret.id,
          slug: result.secret.slug,
          rotated: result.rotated,
          admin_user_id: actor(req),
        },
      });
      return { secret: toAdminSecret(result.secret), rotated: result.rotated };
    },
  );

  app.delete(
    '/admin/secrets/:id',
    { preHandler: app.requireAdmin },
    async (req) => {
      const id = idFrom((req.params as { id?: unknown }).id);
      const deleted = await secrets.softDelete(id);
      if (!deleted) throw notFound();
      await events.record({
        type: 'secret.deleted',
        payload: { secret_id: deleted.id, slug: deleted.slug, admin_user_id: actor(req) },
      });
      return { secret: toAdminSecret(deleted) };
    },
  );

  app.post(
    '/admin/secrets/:id/reveal',
    { preHandler: app.requireAdmin },
    async (req) => {
      const id = idFrom((req.params as { id?: unknown }).id);
      const revealed = await secrets.revealById(id);
      // `broadcast: false`: this is an audit fact, not a UI invalidation, and
      // nothing should be nudged into re-fetching because a human looked at a
      // credential.
      await events.record(
        {
          type: 'secret.revealed',
          payload: {
            secret_id: revealed.secret.id,
            slug: revealed.secret.slug,
            admin_user_id: actor(req),
          },
        },
        { broadcast: false },
      );
      return { secret: toAdminSecret(revealed.secret), value: revealed.value };
    },
  );
}

/**
 * The admin DTO. Its parameter is `SecretMetadata`, which has no ciphertext
 * field, and the body enumerates its keys — there is no spread and no `...row`.
 * Both halves are load-bearing: together they make it structurally impossible
 * for this function to emit a secret value, whatever it is handed.
 */
export function toAdminSecret(row: SecretMetadata) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    engine: row.engine,
    // Null means an operator created it, which is also what makes it read-only
    // to every host over MCP. The admin UI shows this so an operator can tell at
    // a glance which entries an agent can rotate on its own.
    source_host_id: row.sourceHostId,
    source_engine: row.sourceEngine,
    tags: row.tags,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    last_rotated_at: row.lastRotatedAt,
    deleted_at: row.deletedAt,
  };
}
