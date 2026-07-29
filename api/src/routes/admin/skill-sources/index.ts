import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RouteContext } from '../../index.js';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../../../http/errors.js';
import { ROLE_ADMIN, ROLE_OWNER } from '../../../services/admin-auth.js';
import {
  MattPocockSkillsService,
  type SkillSourceState,
} from '../../../services/mattpocock-skills.js';

export interface MattPocockSkillSourceRouteService {
  getState(): Promise<SkillSourceState>;
  configure(input: { enabled?: boolean; auto_update?: boolean }): Promise<SkillSourceState>;
  refresh(options?: { force?: boolean }): Promise<SkillSourceState>;
}

export interface AdminSkillSourceRouteOptions {
  mattPocock?: MattPocockSkillSourceRouteService;
}

function canMutate(req: FastifyRequest): boolean {
  const role = req.admin?.user.accessLevel;
  return role === ROLE_OWNER || role === ROLE_ADMIN;
}

function updateBody(value: unknown): { enabled?: boolean; auto_update?: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('body must be an object', { param: 'body' });
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some((key) => key !== 'enabled' && key !== 'auto_update')) {
    throw new ValidationError('body accepts enabled and auto_update only', { param: 'body' });
  }
  for (const key of keys) {
    if (typeof body[key] !== 'boolean') {
      throw new ValidationError(`${key} must be a boolean`, { param: key });
    }
  }
  return {
    ...(Object.prototype.hasOwnProperty.call(body, 'enabled') ? { enabled: body['enabled'] as boolean } : {}),
    ...(Object.prototype.hasOwnProperty.call(body, 'auto_update')
      ? { auto_update: body['auto_update'] as boolean }
      : {}),
  };
}

function emptyBody(value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0) return;
  throw new ValidationError('refresh does not accept a request body', { param: 'body' });
}

export async function registerAdminSkillSourceRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  options: AdminSkillSourceRouteOptions = {},
): Promise<void> {
  const source = options.mattPocock ?? new MattPocockSkillsService(ctx.db);
  const requireSourceMutationRole = async (req: FastifyRequest): Promise<void> => {
    if (!req.admin) throw new UnauthorizedError('Admin session required', 'admin_required');
    if (!canMutate(req)) throw new ForbiddenError('Insufficient access level', 'admin_role_required');
  };

  app.get('/admin/skill-sources/mattpocock', { preHandler: app.requireAdmin }, async () => {
    return source.getState();
  });

  app.post(
    '/admin/skill-sources/mattpocock',
    { preHandler: [app.requireAdmin, requireSourceMutationRole] },
    async (req) => source.configure(updateBody(req.body)),
  );

  app.post(
    '/admin/skill-sources/mattpocock/refresh',
    { preHandler: [app.requireAdmin, requireSourceMutationRole] },
    async (req) => {
      emptyBody(req.body);
      return source.refresh({ force: true });
    },
  );
}
