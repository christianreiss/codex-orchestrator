import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../../index.js';
import { ValidationError, ServiceUnavailableError } from '../../../http/errors.js';
import { JoplinClient } from '../../../services/joplin-client.js';
import {
  readJoplinConfig,
  writeJoplinConfig,
  toDto,
  fingerprint,
  type JoplinConfig,
} from '../../../services/joplin-config.js';
import { syncAllJoplinNotes } from '../../../services/joplin-cache.js';
import { nowIso } from '../../../util/timestamp.js';
import { wsPublisher } from '../../../ws/publisher.js';

interface ConfigUpdateBody {
  url?: unknown;
  email?: unknown;
  password?: unknown;
  enabled?: unknown;
  sync_interval_minutes?: unknown;
}

/** Optional injection seam — tests substitute the client constructor. */
export interface JoplinRoutesDeps {
  buildClient?: (config: JoplinConfig) => JoplinClient;
}

export async function registerAdminJoplinRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  deps: JoplinRoutesDeps = {},
): Promise<void> {
  const buildClient =
    deps.buildClient ??
    ((config: JoplinConfig) =>
      new JoplinClient({ url: config.url, email: config.email, password: config.password }));

  // GET /admin/joplin/config — sanitised config state (no token leakage)
  app.get(
    '/admin/joplin/config',
    { preHandler: [app.requireAdmin] },
    async () => {
      const config = await readJoplinConfig(ctx.db, ctx.keyring);
      return toDto(config);
    },
  );

  // POST /admin/joplin/config — partial update, encrypted persist
  app.post(
    '/admin/joplin/config',
    { preHandler: [app.requireAdmin] },
    async (req) => {
      const body = (req.body ?? {}) as ConfigUpdateBody;
      const current = await readJoplinConfig(ctx.db, ctx.keyring);
      const next: JoplinConfig = { ...current };
      let connectionChanged = false;

      if (body.url !== undefined) {
        const url = String(body.url).trim().replace(/\/+$/, '');
        if (url !== '' && !/^https?:\/\//i.test(url)) {
          throw new ValidationError('url must be a valid http/https URL', { param: 'url' });
        }
        if (url !== current.url) connectionChanged = true;
        next.url = url;
      }
      if (body.email !== undefined) {
        const email = String(body.email).trim();
        if (email !== current.email) connectionChanged = true;
        next.email = email;
      }
      if (body.password !== undefined) {
        const password = String(body.password);
        if (password !== '' && password !== current.password) {
          next.password = password;
          connectionChanged = true;
        }
      }
      if (body.sync_interval_minutes !== undefined) {
        const interval = Number(body.sync_interval_minutes);
        if (!Number.isFinite(interval) || interval < 1 || interval > 1440) {
          throw new ValidationError('sync_interval_minutes must be between 1 and 1440', {
            param: 'sync_interval_minutes',
          });
        }
        next.syncIntervalMinutes = Math.floor(interval);
      }
      if (body.enabled !== undefined) {
        const enabled = parseBool(body.enabled);
        if (enabled === null) {
          throw new ValidationError('enabled must be boolean', { param: 'enabled' });
        }
        // If enabling, we require a verified connection
        if (enabled && !next.url) {
          throw new ValidationError(
            'Save a Joplin Server URL before enabling the module',
            { param: 'enabled' },
          );
        }
        next.enabled = enabled;
      }

      // Any connection-config change invalidates the prior verification.
      if (connectionChanged) {
        next.verifiedAt = null;
        next.verifiedFingerprint = null;
        // If we were enabled and the connection changed, auto-disable.
        if (current.enabled) next.enabled = false;
      }

      await writeJoplinConfig(ctx.db, ctx.keyring, next);
      return toDto(next);
    },
  );

  // POST /admin/joplin/test — probes the configured Joplin URL
  app.post(
    '/admin/joplin/test',
    { preHandler: [app.requireAdmin] },
    async () => {
      const config = await readJoplinConfig(ctx.db, ctx.keyring);
      if (!config.url || !config.email || !config.password) {
        throw new ValidationError('url, email, and password are required');
      }
      const client = buildClient(config);
      const probe = await client.ping();
      let updated: JoplinConfig;
      if (probe.reachable) {
        updated = {
          ...config,
          verifiedAt: nowIso(),
          verifiedFingerprint: fingerprint(config),
        };
      } else {
        updated = { ...config, verifiedAt: null, verifiedFingerprint: null };
      }
      await writeJoplinConfig(ctx.db, ctx.keyring, updated);
      return {
        ...toDto(updated),
        reachable: probe.reachable,
        reason: probe.reason,
        version: probe.version,
      };
    },
  );

  // POST /admin/joplin/sync — full sync of notes → joplin_notes_cache
  app.post(
    '/admin/joplin/sync',
    { preHandler: [app.requireAdmin] },
    async () => {
      const config = await readJoplinConfig(ctx.db, ctx.keyring);
      const dto = toDto(config);
      if (!config.url || !config.email || !config.password) {
        throw new ValidationError('Configure Joplin before running a sync');
      }
      if (!dto.verified_connection) {
        throw new ValidationError('Run a successful connection test before syncing Joplin');
      }
      const client = buildClient(config);
      let result;
      try {
        result = await syncAllJoplinNotes(ctx.db, client);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ServiceUnavailableError(`Joplin sync failed: ${message}`, 'joplin_sync_failed');
      }
      wsPublisher.publish('joplin.synced', result);
      return { ...dto, sync: result };
    },
  );

}

function parseBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const s = value.toLowerCase().trim();
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === '') return false;
  }
  return null;
}
