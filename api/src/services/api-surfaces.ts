/**
 * Exposed API surfaces and which backend engine serves each one.
 *
 * A *surface* is what a client talks to: a URL prefix, a wire format, an API
 * key namespace and a kill switch. A *backend* is the engine whose canonical
 * credential, runner `engine`, capabilities and model catalog execute the
 * request. They used to be welded together (`/v1` = Codex, `/anthropic/v1` =
 * Claude, `/grok/v1` = Grok); now any surface may be served by any backend.
 *
 * Keys and kill switches stay with the surface on purpose: switching a
 * backend must never invalidate a client's key or flip its availability.
 * `openai_api_keys.engine` therefore names the surface's key namespace
 * (`codex` = `/v1`, `claude` = `/anthropic/v1`, `grok` = `/grok/v1`), not the
 * backend that answers.
 *
 * The mapping lives in `versions` rows `api_surface_backend_<surface>`. A
 * missing or unparseable row means the identity backend — that is exactly the
 * behaviour every install had before the mapping existed.
 */
import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { openaiApiKeys, versions } from '../db/schema.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, ENGINE_GROK, isEngine, type Engine } from '../util/engine.js';
import { isTruthyFlagValue } from './settings.js';

export type ApiSurfaceId = 'openai' | 'anthropic' | 'grok';
export type ApiWire = 'openai' | 'anthropic';

export interface ApiSurface {
  id: ApiSurfaceId;
  label: string;
  basePath: string;
  wire: ApiWire;
  /** `openai_api_keys.engine` namespace this surface authenticates against. */
  keyEngine: Engine;
  /** The backend this surface had before the mapping existed; the default. */
  identityBackend: Engine;
  /** `versions` flag of the surface's kill switch. */
  disabledFlag: string;
  /** `versions` row holding the selected backend engine. */
  backendFlag: string;
}

export const API_SURFACE_IDS: readonly ApiSurfaceId[] = ['openai', 'anthropic', 'grok'];

export const API_SURFACES: Record<ApiSurfaceId, ApiSurface> = {
  openai: {
    id: 'openai',
    label: 'OpenAI-compatible',
    basePath: '/v1',
    wire: 'openai',
    keyEngine: ENGINE_CODEX,
    identityBackend: ENGINE_CODEX,
    disabledFlag: 'openai_api_disabled',
    backendFlag: 'api_surface_backend_openai',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic-compatible',
    basePath: '/anthropic/v1',
    wire: 'anthropic',
    keyEngine: ENGINE_CLAUDE,
    identityBackend: ENGINE_CLAUDE,
    disabledFlag: 'claude_api_disabled',
    backendFlag: 'api_surface_backend_anthropic',
  },
  grok: {
    id: 'grok',
    label: 'Grok (OpenAI-compatible)',
    basePath: '/grok/v1',
    wire: 'openai',
    keyEngine: ENGINE_GROK,
    identityBackend: ENGINE_GROK,
    disabledFlag: 'grok_api_disabled',
    backendFlag: 'api_surface_backend_grok',
  },
};

export function isApiSurfaceId(value: unknown): value is ApiSurfaceId {
  return typeof value === 'string' && (API_SURFACE_IDS as readonly string[]).includes(value);
}

/** Read a stored backend value; anything that is not an engine is the identity backend. */
export function storedBackend(raw: string | null | undefined, surface: ApiSurfaceId): Engine {
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return isEngine(normalized) ? normalized : API_SURFACES[surface].identityBackend;
}

export interface SurfaceRouting {
  /** The backend engine that serves `surface` right now. */
  backendFor(surface: ApiSurfaceId): Promise<Engine>;
}

/** Every surface on its identity backend — the pre-mapping behaviour. */
export const identityRouting: SurfaceRouting = {
  backendFor: async (surface) => API_SURFACES[surface].identityBackend,
};

/**
 * DB-backed routing, read per request so an admin change applies without a
 * restart. A 1 s TTL keeps the hot path off the DB; a failed read serves the
 * last value seen, or the identity backend if there is none — refusing traffic
 * because the metadata table glitched is worse than serving it.
 */
export function createSurfaceRouting(db: Database, ttlMs = 1_000): SurfaceRouting {
  const cache = new Map<ApiSurfaceId, { value: Engine; ts: number }>();
  return {
    async backendFor(surface) {
      const hit = cache.get(surface);
      if (hit && Date.now() - hit.ts < ttlMs) return hit.value;
      try {
        const rows = await db
          .select({ version: versions.version })
          .from(versions)
          .where(eq(versions.name, API_SURFACES[surface].backendFlag))
          .limit(1);
        const value = storedBackend(rows[0]?.version, surface);
        cache.set(surface, { value, ts: Date.now() });
        return value;
      } catch {
        return hit?.value ?? API_SURFACES[surface].identityBackend;
      }
    },
  };
}

/** One row of the admin "Exposed APIs" table. */
export interface ApiSurfaceRow {
  surface: ApiSurfaceId;
  label: string;
  base_path: string;
  wire: ApiWire;
  backend: Engine;
  identity_backend: Engine;
  disabled: boolean;
  /** Active keys in the surface's key namespace. */
  key_count: number;
}

export async function listApiSurfaces(db: Database): Promise<ApiSurfaceRow[]> {
  const surfaces = API_SURFACE_IDS.map((id) => API_SURFACES[id]);
  const flagNames = surfaces.flatMap((s) => [s.backendFlag, s.disabledFlag]);
  const [flagRows, keyRows] = await Promise.all([
    db.select({ name: versions.name, version: versions.version }).from(versions).where(inArray(versions.name, flagNames)),
    db.select({ engine: openaiApiKeys.engine }).from(openaiApiKeys).where(eq(openaiApiKeys.isActive, 1)),
  ]);
  const flags = new Map(flagRows.map((r) => [r.name, r.version]));
  const keys = new Map<string, number>();
  for (const { engine } of keyRows) keys.set(engine, (keys.get(engine) ?? 0) + 1);
  return surfaces.map((s) => ({
    surface: s.id,
    label: s.label,
    base_path: s.basePath,
    wire: s.wire,
    backend: storedBackend(flags.get(s.backendFlag), s.id),
    identity_backend: s.identityBackend,
    disabled: isTruthyFlagValue(flags.get(s.disabledFlag)),
    key_count: keys.get(s.keyEngine) ?? 0,
  }));
}
