import { eq } from 'drizzle-orm';
import { versions as versionsTable } from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Engine } from '../util/engine.js';
import { ENGINE_CLAUDE, ENGINE_CODEX } from '../util/engine.js';
import { isSemanticVersion, normalizeVersion } from './client-versions.js';

/**
 * Port of AuthService::versionSummary + availableClientVersion. The PHP
 * version polled GitHub releases inline; we read the cached result out of the
 * `versions` key/value table and refresh it lazily, from inside the request
 * that needs it (`refreshLatestClientVersion` below). There is no background
 * worker — the served target is therefore only as fresh as `CACHE_TTL_SECONDS`
 * in `client-versions.ts` allows, which `client_version_fetched_at` reports.
 *
 * Engine-aware: keys are looked up with a `_codex` or `_claude` suffix first,
 * falling back to unsuffixed keys for legacy rows.
 *
 * `VersionSnapshot` is what `GET /versions` serves, so its keys are mirrored in
 * the `GET /versions` bullet of `docs/interface-api.md`; changing them here
 * without changing the doc fails `test/unit/contract/versions-doc-keys.test.ts`.
 */

export interface VersionSnapshot {
  client_version: string | null;
  client_version_override: string | null;
  client_version_enforce_exact: boolean;
  /**
   * When the upstream release metadata behind `client_version` was last
   * fetched, or null when the target is an explicit pin that never consults
   * the cache. An old value means the fleet is being handed a stale target.
   */
  client_version_fetched_at: string | null;
  wrapper_version: string | null;
  wrapper_sha256: string | null;
  wrapper_url: string | null;
  runner_state: string | null;
  api_disabled: boolean;
  auto_update_enabled: boolean;
  cdx_silent: boolean;
  clx_silent: boolean;
  agent_messaging_enabled: boolean;
  installation_id: string | null;
  engine: Engine;
}

export interface VersionSnapshotService {
  summary(engine?: Engine): Promise<VersionSnapshot>;
  flag(key: string, defaultValue?: boolean): Promise<boolean>;
  setting(key: string): Promise<string | null>;
}

export interface VersionSnapshotDeps {
  db: Database;
  installationId: string | null;
  refreshLatestClientVersion?: (engine: Engine) => Promise<void>;
}

function semanticOrNull(v: string | undefined | null): string | null {
  const normalized = normalizeVersion(v);
  return normalized && isSemanticVersion(normalized) ? normalized : null;
}

/** The `versions` row holding cached upstream release metadata for `engine`. */
function releaseCacheKey(engine: Engine): string {
  return engine === ENGINE_CLAUDE ? 'github_release_claude-cli' : 'github_release_codex-cli';
}

/** `fetched_at` of the cached release blob, or null when it is absent or unparseable. */
function releaseFetchedAt(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { fetched_at?: unknown };
    if (typeof parsed.fetched_at !== 'string') return null;
    const trimmed = parsed.fetched_at.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * The per-host columns an operator pins from the admin host page. Structurally
 * typed so callers can pass a `hosts` row without importing its full shape.
 */
export interface HostClientVersionPin {
  clientVersionOverride?: string | null;
  claudeClientVersionOverride?: string | null;
}

/**
 * Layers a per-host engine pin over the fleet-wide snapshot.
 *
 * `summary()` only ever reads the global `versions` table, so without this the
 * `hosts.client_version_override` / `hosts.claude_client_version_override`
 * columns were write-only: the admin UI accepted a pin, echoed it back, and no
 * wrapper ever saw it. A per-host pin means *that* version, so it also forces
 * `enforce_exact` — the same thing the fleet-wide lock does in `summary()`.
 *
 * Must be applied wherever a host-authenticated route emits the versions block:
 * `POST /auth`, the `/sync/*` family via `host-sync.ts`, and `POST /cron/check`.
 */
export function applyHostClientVersionPin<T extends VersionSnapshot>(
  snapshot: T,
  host: HostClientVersionPin | null | undefined,
  engine: Engine,
): T {
  const raw =
    engine === ENGINE_CLAUDE ? host?.claudeClientVersionOverride : host?.clientVersionOverride;
  const pin = semanticOrNull(raw);
  if (!pin) return snapshot;
  return { ...snapshot, client_version_override: pin, client_version_enforce_exact: true };
}

export function createVersionSnapshotService(deps: VersionSnapshotDeps): VersionSnapshotService {
  const { db, installationId } = deps;

  async function readMap(): Promise<Map<string, string>> {
    const rows = await db.select().from(versionsTable);
    const out = new Map<string, string>();
    for (const r of rows) out.set(r.name, r.version);
    return out;
  }

  function isLatestAlias(v: string | undefined | null): boolean {
    if (!v) return false;
    const normalized = v.trim().toLowerCase();
    return normalized === 'latest' || normalized === 'auto';
  }

  function releaseVersion(raw: string | undefined): string | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; tag_name?: unknown; name?: unknown };
      for (const candidate of [parsed.version, parsed.tag_name, parsed.name]) {
        if (typeof candidate !== 'string') continue;
        const version = semanticOrNull(candidate);
        if (version) return version;
      }
      return null;
    } catch {
      return semanticOrNull(raw);
    }
  }

  function latestClientVersion(map: Map<string, string>, engine: Engine): string | null {
    // Claude has no legacy fallback: the engine postdates the PHP server, so
    // `github_release_claude-cli` is the only row anything ever writes.
    if (engine === ENGINE_CLAUDE) return releaseVersion(map.get(releaseCacheKey(engine)));
    return (
      releaseVersion(map.get('github_release_codex-cli')) ??
      semanticOrNull(map.get('client_available_codex')) ??
      semanticOrNull(map.get('client_available'))
    );
  }

  function resolveClientVersion(raw: string | null, map: Map<string, string>, engine: Engine): string | null {
    if (isLatestAlias(raw)) return latestClientVersion(map, engine);
    return semanticOrNull(raw) ?? raw;
  }

  function flagValue(v: string | undefined, def: boolean): boolean {
    if (v === undefined) return def;
    const s = v.toLowerCase().trim();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
  }

  return {
    async summary(engine = ENGINE_CODEX) {
      let map = await readMap();
      const suffix = engine === ENGINE_CLAUDE ? '_claude' : '_codex';
      const get = (k: string) => map.get(k);
      let rawClient = get(`client_version${suffix}`) ?? get('client_version') ?? null;
      const usesReleaseCache = isLatestAlias(rawClient);
      if (usesReleaseCache && deps.refreshLatestClientVersion) {
        await deps.refreshLatestClientVersion(engine);
        map = await readMap();
        rawClient = get(`client_version${suffix}`) ?? get('client_version') ?? null;
      }
      const exactLock =
        engine === ENGINE_CODEX
          ? semanticOrNull(get('client_version_lock'))
          : engine === ENGINE_CLAUDE
            ? semanticOrNull(get('client_version_lock_claude'))
            : null;
      const explicitOverride = semanticOrNull(get(`client_version_override${suffix}`));
      const clientOverride = exactLock ?? explicitOverride;
      return {
        client_version: resolveClientVersion(rawClient, map, engine),
        client_version_override: clientOverride,
        client_version_enforce_exact:
          exactLock !== null || flagValue(get(`client_version_enforce_exact${suffix}`), false),
        client_version_fetched_at: usesReleaseCache
          ? releaseFetchedAt(get(releaseCacheKey(engine)))
          : null,
        wrapper_version: get(`wrapper_version${suffix}`) ?? get('wrapper_version') ?? null,
        wrapper_sha256: get(`wrapper_sha256${suffix}`) ?? get('wrapper_sha256') ?? null,
        wrapper_url: get(`wrapper_url${suffix}`) ?? get('wrapper_url') ?? null,
        runner_state: get('runner_state') ?? null,
        api_disabled: flagValue(get('api_disabled'), false),
        auto_update_enabled: flagValue(get('auto_update_enabled'), false),
        cdx_silent: flagValue(get('cdx_silent'), false),
        clx_silent: flagValue(get('clx_silent'), false),
        agent_messaging_enabled: flagValue(get('agent_messaging_enabled'), false),
        installation_id: installationId,
        engine,
      };
    },

    async flag(key, defaultValue = false) {
      const rows = await db.select().from(versionsTable).where(eq(versionsTable.name, key)).limit(1);
      return flagValue(rows[0]?.version, defaultValue);
    },

    async setting(key) {
      const rows = await db.select().from(versionsTable).where(eq(versionsTable.name, key)).limit(1);
      return rows[0]?.version ?? null;
    },
  };
}
