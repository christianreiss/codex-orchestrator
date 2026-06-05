import { eq } from 'drizzle-orm';
import { versions as versionsTable } from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Engine } from '../util/engine.js';
import { ENGINE_CLAUDE, ENGINE_CODEX } from '../util/engine.js';

/**
 * Port of AuthService::versionSummary + availableClientVersion. The PHP
 * version polled GitHub releases inline; we delegate that to a background
 * cron worker and just read the `versions` key/value table here.
 *
 * Engine-aware: keys are looked up with a `_codex` or `_claude` suffix first,
 * falling back to unsuffixed keys for legacy rows.
 */

export interface VersionSnapshot {
  client_version: string | null;
  client_version_override: string | null;
  client_version_enforce_exact: boolean;
  wrapper_version: string | null;
  wrapper_sha256: string | null;
  wrapper_url: string | null;
  runner_state: string | null;
  api_disabled: boolean;
  auto_update_enabled: boolean;
  cdx_silent: boolean;
  clx_silent: boolean;
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
}

export function createVersionSnapshotService(deps: VersionSnapshotDeps): VersionSnapshotService {
  const { db, installationId } = deps;

  async function readMap(): Promise<Map<string, string>> {
    const rows = await db.select().from(versionsTable);
    const out = new Map<string, string>();
    for (const r of rows) out.set(r.name, r.version);
    return out;
  }

  function semanticOrNull(v: string | undefined | null): string | null {
    if (!v) return null;
    const normalized = v.trim().replace(/^v/i, '');
    return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : null;
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
      const candidate = parsed.version ?? parsed.tag_name ?? parsed.name;
      return typeof candidate === 'string' ? semanticOrNull(candidate) : null;
    } catch {
      return semanticOrNull(raw);
    }
  }

  function latestClientVersion(map: Map<string, string>, engine: Engine): string | null {
    if (engine === ENGINE_CLAUDE) {
      return (
        releaseVersion(map.get('github_release_claude-cli')) ??
        semanticOrNull(map.get('client_available_claude')) ??
        semanticOrNull(map.get('claude_fleet_version'))
      );
    }
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
      const map = await readMap();
      const suffix = engine === ENGINE_CLAUDE ? '_claude' : '_codex';
      const get = (k: string) => map.get(k);
      const rawClient = get(`client_version${suffix}`) ?? get('client_version') ?? null;
      const codexExactLock = engine === ENGINE_CODEX ? semanticOrNull(get('client_version_lock')) : null;
      const explicitOverride = semanticOrNull(get(`client_version_override${suffix}`));
      const clientOverride = codexExactLock ?? explicitOverride;
      return {
        client_version: resolveClientVersion(rawClient, map, engine),
        client_version_override: clientOverride,
        client_version_enforce_exact:
          codexExactLock !== null || flagValue(get(`client_version_enforce_exact${suffix}`), false),
        wrapper_version: get(`wrapper_version${suffix}`) ?? get('wrapper_version') ?? null,
        wrapper_sha256: get(`wrapper_sha256${suffix}`) ?? get('wrapper_sha256') ?? null,
        wrapper_url: get(`wrapper_url${suffix}`) ?? get('wrapper_url') ?? null,
        runner_state: get('runner_state') ?? null,
        api_disabled: flagValue(get('api_disabled'), false),
        auto_update_enabled: flagValue(get('auto_update_enabled'), false),
        cdx_silent: flagValue(get('cdx_silent'), false),
        clx_silent: flagValue(get('clx_silent'), false),
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
