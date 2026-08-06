import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { join, resolve } from 'node:path';
import { hosts as hostsTable, logs as logsTable } from '../../db/schema.js';
import type { RouteContext } from '../index.js';
import { ApiError, ValidationError } from '../../http/errors.js';
import { nowIso } from '../../util/timestamp.js';
import { parseEngine } from '../../util/engine.js';
import { resolveWrapperPlatform } from '../../util/wrapper-platform.js';
import { wsPublisher } from '../../ws/publisher.js';

import { ClientVersionsService } from '../../services/client-versions.js';
import { createHostAuthService } from '../../services/host-auth.js';
import { createInsecureWindowService } from '../../services/insecure-window.js';
import { createHostSyncService } from '../../services/host-sync.js';
import { SettingsService } from '../../services/settings.js';
import {
  applyHostClientVersionPin,
  createVersionSnapshotService,
} from '../../services/version-snapshot.js';
import { isLegacyShellWrapperVersion } from '../../services/wrapper-transition.js';
import { createWrapperBinRegistry } from '../../services/wrapper-bin-registry.js';
import { projectWrapperVersionSnapshot } from '../../services/wrapper-version-projection.js';
import { assertHostEngineEnabled } from '../../services/host-engine-policy.js';

/**
 * Registers /host/users, /host/lane (GET+POST), /versions, /cron/check,
 * /cron/report, /agents/retrieve, /config/retrieve.
 *
 * /versions is public — every other route requires a host API key. /cron/*
 * uses a slimmed-down auth that skips the insecure-window enforcement (cron
 * hits happen out-of-session and shouldn't roll the window).
 */
export async function registerHostRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const insecure = createInsecureWindowService({ db: ctx.db, env: ctx.env });
  const hostAuth = createHostAuthService({ db: ctx.db, env: ctx.env, insecure });
  const clientVersions = new ClientVersionsService(new SettingsService(ctx.db), app.log);
  const versions = createVersionSnapshotService({
    db: ctx.db,
    installationId: ctx.env.INSTALLATION_ID ?? null,
    refreshLatestClientVersion: async (engine) => {
      await clientVersions.availableClientVersion(false, engine);
    },
  });
  const sync = createHostSyncService({ db: ctx.db, versions });

  const binRoot = ctx.env.DATA_ROOT
    ? join(ctx.env.DATA_ROOT, 'wrapper', 'v2', 'bin')
    : resolve(import.meta.dirname, '..', '..', '..', '..', 'storage', 'wrapper', 'v2', 'bin');
  const binaries = createWrapperBinRegistry({ binRoot });

  app.get('/versions', async () => {
    if (await versions.flag('api_disabled', false)) {
      throw new ApiError('API disabled by administrator', { status: 503, code: 'api_disabled' });
    }
    return versions.summary();
  });

  // POST /host/users — record username/hostname combos for uninstall cleanup.
  app.post('/host/users', async (req) => {
    const host = await hostAuth.authenticate(req);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const username = typeof body.username === 'string' ? body.username : null;
    const hostname = typeof body.hostname === 'string' ? body.hostname : null;
    const users = await sync.recordHostUser(host.id, username, hostname);
    return { users };
  });

  // GET /host/lane — current lane preference + effective lane.
  app.get('/host/lane', async (req) => {
    const host0 = await hostAuth.authenticate(req);
    const host = host0.secure === 1 ? host0 : await insecure.enforce(host0, 'host_lane_get');
    const lanePreference = normalizeLane(host.lanePreference);
    return {
      lane_preference: lanePreference,
      effective_lane: lanePreference ?? 'normal',
      host_id: host.id,
      fqdn: host.fqdn,
    };
  });

  // POST /host/lane — set lane preference.
  app.post('/host/lane', async (req) => {
    const host0 = await hostAuth.authenticate(req);
    const host = host0.secure === 1 ? host0 : await insecure.enforce(host0, 'host_lane_set');
    const body = (req.body && typeof req.body === 'object' ? req.body : null) as Record<string, unknown> | null;
    if (!body || !('lane' in body)) throw new ValidationError('lane is required (set null to clear)', { param: 'lane' });
    const lane = body.lane;
    if (lane !== null && typeof lane !== 'string') throw new ValidationError('lane must be one of: normal, spark, or null', { param: 'lane' });
    const normalized = normalizeLane(lane);
    if (lane !== null && typeof lane === 'string' && lane.trim() !== '' && normalized === null) {
      throw new ValidationError('lane must be one of: normal, spark, or null', { param: 'lane' });
    }
    await ctx.db
      .update(hostsTable)
      .set({ lanePreference: normalized, updatedAt: nowIso() })
      .where(eq(hostsTable.id, host.id));
    const updated = await ctx.db.select().from(hostsTable).where(eq(hostsTable.id, host.id)).limit(1);
    const eff = normalizeLane(updated[0]?.lanePreference ?? null) ?? 'normal';
    await ctx.db.insert(logsTable).values({
      hostId: host.id,
      action: 'host.lane.set',
      details: JSON.stringify({ fqdn: host.fqdn, lane_preference: normalized, effective_lane: eff }),
      createdAt: nowIso(),
    });
    wsPublisher.publish('host.updated', { id: host.id, fqdn: host.fqdn });
    return {
      lane_preference: normalized,
      effective_lane: eff,
      host_id: host.id,
      fqdn: host.fqdn,
    };
  });

  // POST /cron/check — slimmed auto-update probe.
  app.post('/cron/check', async (req) => {
    const host = await hostAuth.authenticate(req);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const engine = parseEngine(body.engine);
    assertHostEngineEnabled(host, engine);
    const submittedClient = typeof body.client_version === 'string' ? body.client_version : null;
    const submittedWrapper = typeof body.wrapper_version === 'string' ? body.wrapper_version : null;
    // A wrapper re-resolving its engine target on the way out of an interactive
    // session (see maybeEnsureClaude) asks the same question cron does, but it
    // is not cron: letting it stamp last_cron_check would keep the field fresh
    // on a host whose cron has been dead for weeks.
    const probe = body.probe === true;
    const requestedPlatform = resolveWrapperPlatform(req.headers);
    const baseUrl = resolvePublicBaseUrl(req, ctx.env.PUBLIC_BASE_URL);
    const summary = applyHostClientVersionPin(
      await projectWrapperVersionSnapshot({
        snapshot: await versions.summary(engine),
        engine,
        submittedWrapperVersion: submittedWrapper,
        platform: requestedPlatform,
        publicBaseUrl: baseUrl,
        binaries,
      }),
      host,
      engine,
    );
    const usingLegacyTransition = isLegacyShellWrapperVersion(submittedWrapper);
    const targetWrapper = summary.wrapper_version;

    if (!probe) {
      await ctx.db
        .update(hostsTable)
        .set({ lastCronCheck: nowIso(), updatedAt: nowIso() })
        .where(eq(hostsTable.id, host.id));
    }

    if (!summary.auto_update_enabled) {
      return {
        action: 'disable',
        wrapper: { action: 'no_update', target_version: null, sha256: null, url: null },
      };
    }

    const targetClient = summary.client_version_override ?? summary.client_version;
    const wrapperUpdate = {
      action: 'no_update' as 'no_update' | 'update',
      target_version: targetWrapper,
      sha256: summary.wrapper_sha256,
      url: summary.wrapper_url,
    };

    let needClient = false;
    if (targetClient && submittedClient) {
      const submittedComparable = normalizeVersionForCompare(submittedClient);
      const targetComparable = normalizeVersionForCompare(targetClient);
      // If submittedClient can't be parsed as semver (e.g. "unknown"), treat
      // as not-installed so the server always pushes the update.
      const submittedIsSemver = /^\d/.test(submittedComparable);
      needClient = !submittedIsSemver || (summary.client_version_enforce_exact
        ? submittedComparable !== targetComparable
        : compareSemver(submittedComparable, targetComparable) < 0);
    } else if (targetClient && !submittedClient) {
      needClient = true;
    }

    let needWrapper = false;
    if (
      targetWrapper &&
      (usingLegacyTransition || (summary.wrapper_sha256 !== null && summary.wrapper_url !== null))
    ) {
      if (!submittedWrapper) {
        needWrapper = true;
      } else {
        const submittedWrapperComparable = normalizeVersionForCompare(submittedWrapper);
        const targetWrapperComparable = normalizeVersionForCompare(targetWrapper);
        const submittedWrapperIsSemver = /^\d/.test(submittedWrapperComparable);
        needWrapper = usingLegacyTransition || !submittedWrapperIsSemver || compareSemver(submittedWrapperComparable, targetWrapperComparable) < 0;
      }
      if (needWrapper) wrapperUpdate.action = 'update';
    }

    if (!needClient && !needWrapper) {
      return { action: 'no_update', wrapper: wrapperUpdate };
    }
    return {
      action: needClient ? 'update' : 'no_update',
      target_version: needClient ? targetClient : null,
      tag: targetClient,
      enforce_exact: summary.client_version_enforce_exact,
      wrapper: wrapperUpdate,
    };
  });

  // POST /cron/report — host reports its current versions.
  app.post('/cron/report', async (req) => {
    const host = await hostAuth.authenticate(req);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const clientVersion = typeof body.client_version === 'string' ? body.client_version : null;
    const wrapperVersion = typeof body.wrapper_version === 'string' ? body.wrapper_version : null;
    if (!clientVersion && !wrapperVersion) {
      throw new ValidationError('client_version or wrapper_version is required');
    }
    const engine = parseEngine(body.engine);
    assertHostEngineEnabled(host, engine);
    const patch =
      engine === 'claude'
        ? {
            claudeClientVersion: clientVersion ?? undefined,
            claudeWrapperVersion: wrapperVersion ?? undefined,
            updatedAt: nowIso(),
          }
        : {
            clientVersion: clientVersion ?? undefined,
            wrapperVersion: wrapperVersion ?? undefined,
            updatedAt: nowIso(),
          };
    await ctx.db.update(hostsTable).set(patch).where(eq(hostsTable.id, host.id));
    await ctx.db.insert(logsTable).values({
      hostId: host.id,
      action: 'cron.update_reported',
      details: JSON.stringify({ client: { reported: clientVersion }, wrapper: { reported: wrapperVersion } }),
      createdAt: nowIso(),
    });
    return { recorded: true };
  });

  // /agents/retrieve and /config/retrieve are owned by the projects-client
  // worktree (Phase 2.6) via its host-agents service. Registration moved
  // there to avoid Fastify duplicate-route errors at boot.
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

function resolvePublicBaseUrl(req: FastifyRequest, envBase: string | undefined): string {
  if (envBase) return envBase.replace(/\/+$/, '');
  const proto = headerString(req.headers['x-forwarded-proto']) ?? req.protocol ?? 'http';
  const host =
    headerString(req.headers['x-forwarded-host']) ?? headerString(req.headers.host) ?? 'localhost';
  return `${proto}://${host}`;
}

function normalizeLane(value: unknown): 'normal' | 'spark' | null {
  if (typeof value !== 'string') return null;
  const v = value.toLowerCase().trim();
  if (v === 'normal' || v === 'spark') return v;
  return null;
}

function normalizeVersionForCompare(value: string): string {
  return value.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? value;
}

function compareSemver(a: string, b: string): number {
  const partsA = a.split(/[.+-]/).map((p) => Number(p));
  const partsB = b.split(/[.+-]/).map((p) => Number(p));
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const pa = partsA[i] ?? 0;
    const pb = partsB[i] ?? 0;
    if (Number.isFinite(pa) && Number.isFinite(pb)) {
      if (pa !== pb) return pa - pb;
    } else {
      const sa = a.split(/[.+-]/)[i] ?? '';
      const sb = b.split(/[.+-]/)[i] ?? '';
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
  }
  return 0;
}
