import { ownerRuntimeFor } from '../control-plane/state/runtime.js';
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
 * A key with non-null `backend_engine` overrides the endpoint default; NULL
 * preserves this mapping for existing keys. The default mapping lives in `versions` rows `api_surface_backend_<surface>`. A
 * missing or unparseable row means the identity backend — that is exactly the
 * behaviour every install had before the mapping existed.
 *
 * Orthogonal to the backend is the *source*: `emulated` (a backend engine's
 * subscription answers through the runner, everything above) or `upstream`
 * (the request is forwarded 1:1 to the surface's fixed provider with a real
 * provider API key, see `gateway-upstream/`). The surface default lives in
 * `versions` rows `api_surface_source_<surface>`; anything but `upstream`
 * means `emulated`. A key's non-null `source` overrides it. Under `upstream`
 * the provider is the surface's own and `backend_engine` plays no part; the
 * two sources never fall back to each other.
 */
import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { openaiApiKeys, providerApiKeys, versions } from '../db/schema.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, ENGINE_GROK, ENGINE_KIMI, isEngine, type Engine } from '../util/engine.js';
import { isTruthyFlagValue } from './settings.js';
import { PROVIDERS, type ProviderId } from './gateway-upstream/providers.js';

export type ApiSurfaceId = 'openai' | 'anthropic' | 'grok' | 'kimi';
export type ApiWire = 'openai' | 'anthropic';
export type ApiSource = 'emulated' | 'upstream';
export const API_SOURCES: readonly ApiSource[] = ['emulated', 'upstream'];

export function isApiSource(value: unknown): value is ApiSource {
  return value === 'emulated' || value === 'upstream';
}

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
  /** The real provider an `upstream` source forwards to; fixed per surface. */
  provider: ProviderId;
  /** `versions` row holding the default source (`emulated` | `upstream`). */
  sourceFlag: string;
}

export const API_SURFACE_IDS: readonly ApiSurfaceId[] = ['openai', 'anthropic', 'grok', 'kimi'];

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
    provider: 'openai',
    sourceFlag: 'api_surface_source_openai',
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
    provider: 'anthropic',
    sourceFlag: 'api_surface_source_anthropic',
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
    provider: 'xai',
    sourceFlag: 'api_surface_source_grok',
  },
  kimi: {
    id: 'kimi', label: 'Kimi Code (OpenAI-compatible)', basePath: '/kimi/v1', wire: 'openai',
    keyEngine: ENGINE_KIMI, identityBackend: ENGINE_KIMI,
    disabledFlag: 'kimi_api_disabled', backendFlag: 'api_surface_backend_kimi',
    provider: 'moonshot', sourceFlag: 'api_surface_source_kimi',
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

/** Read a stored source value; only an exact `upstream` selects the upstream source. */
export function storedSource(raw: string | null | undefined): ApiSource {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'upstream' ? 'upstream' : 'emulated';
}

/** True when the surface's kill switch is on in `flag` (Kimi is opt-in: missing means off). */
export function surfaceDisabled(surface: ApiSurface, flag: string | null | undefined): boolean {
  return isTruthyFlagValue(flag ?? (surface.id === 'kimi' ? '1' : undefined));
}

export interface SurfaceRouting {
  /** The backend engine that serves `surface` right now. */
  backendFor(surface: ApiSurfaceId): Promise<Engine>;
  /** The surface's default source right now; absent means `emulated`. */
  sourceFor?(surface: ApiSurfaceId): Promise<ApiSource>;
}

/** Every surface on its identity backend — the pre-mapping behaviour. */
export const identityRouting: SurfaceRouting = {
  backendFor: async (surface) => API_SURFACES[surface].identityBackend,
  sourceFor: async () => 'emulated',
};

/**
 * Owner-backed routing reads current committed metadata without SQL or a TTL.
 * Legacy fixture routing is DB-backed, read per request so an admin change applies without a
 * restart. A 1 s TTL keeps the hot path off the DB; a failed read serves the
 * last value seen, or the identity backend if there is none — refusing traffic
 * because the metadata table glitched is worse than serving it.
 */
export function createSurfaceRouting(db: Database, ttlMs = 1_000): SurfaceRouting {
  const cache = new Map<ApiSurfaceId, { value: Engine; ts: number }>();
  const sources = new Map<ApiSurfaceId, { value: ApiSource; ts: number }>();
  return {
    async sourceFor(surface) {
      const owner = ownerRuntimeFor(db);
      if (owner) {
        owner.assertOwner();
        return storedSource(owner.state.snapshot().table('versions').get(API_SURFACES[surface].sourceFlag)?.version);
      }
      const hit = sources.get(surface);
      if (hit && Date.now() - hit.ts < ttlMs) return hit.value;
      try {
        const rows = await db
          .select({ version: versions.version })
          .from(versions)
          .where(eq(versions.name, API_SURFACES[surface].sourceFlag))
          .limit(1);
        const value = storedSource(rows[0]?.version);
        sources.set(surface, { value, ts: Date.now() });
        return value;
      } catch {
        // Same reasoning as the backend: serve the last value, else emulation.
        return hit?.value ?? 'emulated';
      }
    },
    async backendFor(surface) {
      const owner = ownerRuntimeFor(db);
      if (owner) {
        owner.assertOwner();
        return storedBackend(
          owner.state.snapshot().table('versions').get(API_SURFACES[surface].backendFlag)?.version,
          surface,
        );
      }
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
  /** Default source of the surface's unpinned keys. */
  source: ApiSource;
  /** The fixed provider an `upstream` source forwards to. */
  provider: ProviderId;
  provider_label: string;
  /** Stored provider keys: `active` ones, and those also not `invalid` (failover candidates). */
  provider_keys: { active: number; usable: number };
}

export async function listApiSurfaces(db: Database): Promise<ApiSurfaceRow[]> {
  const surfaces = API_SURFACE_IDS.map((id) => API_SURFACES[id]);
  const flagNames = surfaces.flatMap((s) => [s.backendFlag, s.disabledFlag, s.sourceFlag]);
  const owner = ownerRuntimeFor(db);
  owner?.assertOwner();
  const snapshot = owner?.state.snapshot();
  const [flagRows, keyRows, providerRows] = snapshot
    ? ([
        snapshot.table('versions').all(),
        snapshot
          .table('openaiApiKeys')
          .all()
          .filter((row) => row.isActive === 1),
        snapshot.table('providerApiKeys').all(),
      ] as const)
    : await Promise.all([
        db
          .select({ name: versions.name, version: versions.version })
          .from(versions)
          .where(inArray(versions.name, flagNames)),
        db.select({ engine: openaiApiKeys.engine }).from(openaiApiKeys).where(eq(openaiApiKeys.isActive, 1)),
        db
          .select({ provider: providerApiKeys.provider, state: providerApiKeys.state, verificationState: providerApiKeys.verificationState })
          .from(providerApiKeys),
      ]);
  const flags = new Map(flagRows.map((r) => [r.name, r.version]));
  const keys = new Map<string, number>();
  for (const { engine } of keyRows) keys.set(engine, (keys.get(engine) ?? 0) + 1);
  const providerKeys = new Map<string, { active: number; usable: number }>();
  for (const { provider, state, verificationState } of providerRows) {
    if (state !== 'active') continue;
    const bucket = providerKeys.get(provider) ?? { active: 0, usable: 0 };
    bucket.active += 1;
    if (verificationState !== 'invalid') bucket.usable += 1;
    providerKeys.set(provider, bucket);
  }
  return surfaces.map((s) => ({
    surface: s.id,
    label: s.label,
    base_path: s.basePath,
    wire: s.wire,
    backend: storedBackend(flags.get(s.backendFlag), s.id),
    identity_backend: s.identityBackend,
    disabled: surfaceDisabled(s, flags.get(s.disabledFlag)),
    key_count: keys.get(s.keyEngine) ?? 0,
    source: storedSource(flags.get(s.sourceFlag)),
    provider: s.provider,
    provider_label: PROVIDERS[s.provider].label,
    provider_keys: providerKeys.get(s.provider) ?? { active: 0, usable: 0 },
  }));
}
