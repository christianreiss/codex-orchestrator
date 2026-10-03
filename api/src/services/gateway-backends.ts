/**
 * Backend engines for the inference gateways (`/v1`, `/anthropic/v1`,
 * `/grok/v1`). A backend is everything engine-specific about answering a
 * request: the canonical credential snapshot handed to the runner, the
 * verification bookkeeping after a successful exec, and the model catalog.
 * Wire shape is the surface's business (see `api-surfaces.ts`); nothing here
 * knows about OpenAI or Anthropic JSON beyond the two model renderers.
 *
 * Bundles are built lazily and exactly once per engine. That matters for
 * Grok: its auth owner is the fleet's single refresher of the Grok grant, so
 * two surfaces on the Grok backend must share one owner, never build their own.
 */
import { ApiError } from '../http/errors.js';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import type { Keyring } from '../security/keyring.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, ENGINE_GROK, ENGINE_LABELS, type Engine } from '../util/engine.js';
import { createAuthTrafficVerifier, type AuthTrafficVerifier } from './auth-traffic-verification.js';
import { createRunnerValidationService } from './runner-validation.js';
import { createRunnerClient } from './runner-client.js';
import { createGrokAuthOwner } from './grok-auth-owner.js';
import { createGrokModelsService, GROK_MODEL_CONTEXT_TOKENS } from './grok-models.js';
import { createClaudeModelsService, modelObject as claudeModelObject, type ClaudeModel } from './claude-models.js';
import { buildModelObject, OPENAI_MODELS, resolveRequestedModel, UnsupportedModelError } from './openai-models.js';
import { assertControlsSupported, capabilitiesFor } from './transport-capabilities.js';
import { API_SURFACES, createSurfaceRouting, identityRouting, type ApiSurfaceId, type SurfaceRouting } from './api-surfaces.js';
import { readFleetEngineState } from './engine-switch.js';

/** One model as every surface can render it. Field names follow the wire. */
export interface GatewayModelInfo {
  id: string;
  display_name: string;
  /** Unix seconds; a fixed catalog date, never `Date.now()`. */
  created: number;
  owned_by: string;
  max_input_tokens?: number;
  max_tokens?: number;
}

export interface GatewayBackendModels {
  /**
   * Strict resolution against this backend's own catalog: empty means the
   * default, legacy aliases upgrade, unknown ids throw 404 `model_not_found`,
   * admin-disabled ones 403 `model_disabled`.
   */
  resolve(value: unknown): Promise<string>;
  /** Enabled models, in catalog order. */
  catalog(): Promise<GatewayModelInfo[]>;
  /** Static metadata for a resolved id. */
  info(id: string): GatewayModelInfo;
}

export interface GatewayBackend {
  readonly engine: Engine;
  readonly models: GatewayBackendModels;
  /** Canonical credential snapshot for the runner, or null when none exists. */
  authSnapshot(): Promise<unknown | null>;
  /** Called with the exact snapshot of each successful exec. */
  onExecSuccess(snapshot: unknown): void;
}

export interface GatewayBackends {
  get(engine: Engine): GatewayBackend;
}

/** What the three gateway registrations share: one backend set, one routing. */
export interface GatewayWiring {
  backends: GatewayBackends;
  routing: SurfaceRouting;
}

type Log = { debug?: (obj: unknown, msg: string) => void };

/** The slice of the route context a backend needs. */
export interface GatewayContext {
  db: Database;
  env: Env;
  keyring: Keyring;
}

/**
 * A surface stops when the engine *serving* it is switched off fleet-wide
 * (engine-switch.ts) — not when the engine its name suggests is. Keys and the
 * surface's own kill switch are untouched, so switching the engine back on or
 * rerouting the surface restores service. Same 503 `api_disabled` shape as the
 * surface kill switch, rendered in the surface's own wire envelope.
 */
export async function assertSurfaceBackendEnabled(
  db: Database,
  routing: SurfaceRouting,
  surface: ApiSurfaceId,
): Promise<void> {
  const backend = await routing.backendFor(surface);
  if ((await readFleetEngineState(db))[backend]) return;
  throw new ApiError(
    `${API_SURFACES[surface].label} API is unavailable: its backend engine ${ENGINE_LABELS[backend]} is disabled fleet-wide by the administrator`,
    { status: 503, code: 'api_disabled', type: 'api_error', extra: { reason: 'backend_engine_disabled', engine: backend } },
  );
}

export function createGatewayWiring(ctx: GatewayContext, log?: Log): GatewayWiring {
  return { backends: createGatewayBackends(ctx, log), routing: createSurfaceRouting(ctx.db) };
}

/**
 * Wiring for a gateway registered on its own (tests, or a caller that does not
 * share one): DB routing when a real database is present, otherwise identity.
 */
export function defaultGatewayWiring(ctx: GatewayContext, log?: Log): GatewayWiring {
  const hasDb = typeof (ctx.db as { select?: unknown } | undefined)?.select === 'function';
  return { backends: createGatewayBackends(ctx, log), routing: hasDb ? createSurfaceRouting(ctx.db) : identityRouting };
}

export function createGatewayBackends(
  ctx: GatewayContext,
  log?: Log,
  overrides: Partial<Record<Engine, Partial<GatewayBackend>>> = {},
): GatewayBackends {
  const built = new Map<Engine, GatewayBackend>();
  let runnerValidation: ReturnType<typeof createRunnerValidationService> | null = null;
  const validation = () => (runnerValidation ??= createRunnerValidationService({ db: ctx.db, keyring: ctx.keyring }));

  function traffic(engine: Engine): AuthTrafficVerifier {
    if (engine !== ENGINE_GROK) {
      return createAuthTrafficVerifier({ db: ctx.db, runnerValidation: validation(), engine, log });
    }
    const owner = createGrokAuthOwner({ db: ctx.db, keyring: ctx.keyring, runner: createRunnerClient({ env: ctx.env }) });
    const minValiditySeconds = Math.min(600, ctx.env.AUTH_RUNNER_EXEC_TIMEOUT ?? 600) + 300;
    return createAuthTrafficVerifier({
      db: ctx.db,
      engine,
      log,
      runnerValidation: validation(),
      snapshotProvider: () => owner.ensureFresh({ minValiditySeconds }),
    });
  }

  function build(engine: Engine): GatewayBackend {
    const override = overrides[engine] ?? {};
    let verifier: AuthTrafficVerifier | null = null;
    const ensureVerifier = () => (verifier ??= traffic(engine));
    return {
      engine,
      models: override.models ?? modelsFor(engine, ctx),
      authSnapshot: override.authSnapshot ?? (() => ensureVerifier().getAuthSnapshot()),
      onExecSuccess: override.onExecSuccess ?? ((snapshot) => ensureVerifier().recordExecSuccess(snapshot)),
    };
  }

  return {
    get(engine) {
      let backend = built.get(engine);
      if (!backend) {
        backend = build(engine);
        built.set(engine, backend);
      }
      return backend;
    },
  };
}

// ---------------------------------------------------------------------------
// Model catalogs — thin wrappers over the existing per-engine services.

const GROK_CATALOG_CREATED = 1790812800;

function modelsFor(engine: Engine, ctx: GatewayContext): GatewayBackendModels {
  if (engine === ENGINE_CLAUDE) return claudeModels(ctx);
  if (engine === ENGINE_GROK) return grokModels(ctx);
  return codexModels();
}

function codexModels(): GatewayBackendModels {
  const info = (id: string): GatewayModelInfo => ({ ...buildModelObject(id), display_name: id });
  return {
    async resolve(value) {
      try {
        return resolveRequestedModel(value);
      } catch (err) {
        if (err instanceof UnsupportedModelError) {
          // OpenAI's own spelling: 404 + model_not_found, type invalid_request_error.
          throw new ApiError(err.message, { status: 404, code: 'model_not_found', type: 'invalid_request_error' });
        }
        throw err;
      }
    },
    async catalog() {
      return [...new Set(OPENAI_MODELS)].map(info);
    },
    info,
  };
}

function claudeModels(ctx: GatewayContext): GatewayBackendModels {
  let service: ReturnType<typeof createClaudeModelsService> | null = null;
  const svc = () => (service ??= createClaudeModelsService(ctx.db));
  const info = (id: string): GatewayModelInfo => {
    const object = claudeModelObject(id as ClaudeModel);
    return {
      id: object.id,
      display_name: object.display_name,
      created: object.created,
      owned_by: object.owned_by,
      max_input_tokens: object.max_input_tokens,
      max_tokens: object.max_tokens,
    };
  };
  return {
    resolve: (value) => svc().resolveRequestedModel(value),
    async catalog() {
      return (await svc().catalog()).filter((m) => m.enabled).map((m) => info(m.id));
    },
    info,
  };
}

function grokModels(ctx: GatewayContext): GatewayBackendModels {
  let service: ReturnType<typeof createGrokModelsService> | null = null;
  const svc = () => (service ??= createGrokModelsService(ctx.db));
  const info = (id: string): GatewayModelInfo => ({
    id,
    display_name: id,
    created: GROK_CATALOG_CREATED,
    owned_by: 'xai',
    max_input_tokens: GROK_MODEL_CONTEXT_TOKENS,
  });
  return {
    resolve: (value) => svc().resolveRequestedModel(value),
    async catalog() {
      return (await svc().catalog()).filter((m) => m.enabled).map((m) => info(m.id));
    },
    info,
  };
}

// ---------------------------------------------------------------------------
// Cross-surface model ids.

/** Model-id families a client of each identity backend's wire sends. */
const NATIVE_MODEL_FAMILY: Record<Engine, RegExp> = {
  [ENGINE_CODEX]: /^(gpt-|chatgpt-|codex-|o[1-9])/i,
  [ENGINE_CLAUDE]: /^claude-/i,
  [ENGINE_GROK]: /^grok-/i,
};

function isModelNotFound(err: unknown): boolean {
  return err instanceof UnsupportedModelError || (err instanceof ApiError && err.status === 404);
}

/**
 * Generation-time model resolution for a surface whose identity backend is
 * `native`. SDK clients hard-code their wire's model ids, so when the surface
 * is served by another backend, an id of the surface's native family that this
 * backend does not serve answers with the backend's default model (the
 * response's `model` field says which). Everything else — unknown ids of any
 * other shape, disabled models, identity routing — keeps strict resolution.
 */
export async function resolveGenerationModel(
  backend: GatewayBackend,
  native: Engine,
  value: unknown,
): Promise<string> {
  try {
    return await backend.models.resolve(value);
  } catch (err) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (backend.engine !== native && isModelNotFound(err) && NATIVE_MODEL_FAMILY[native].test(id)) {
      return backend.models.resolve(undefined);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Rendering.

export function openAiModelObject(info: GatewayModelInfo): { id: string; object: 'model'; created: number; owned_by: string } {
  return { id: info.id, object: 'model', created: info.created, owned_by: info.owned_by };
}

export function anthropicModelObject(info: GatewayModelInfo): { id: string } & Record<string, unknown> {
  return {
    type: 'model',
    id: info.id,
    display_name: info.display_name,
    created_at: new Date(info.created * 1000).toISOString(),
    ...(info.max_input_tokens !== undefined ? { max_input_tokens: info.max_input_tokens } : {}),
    ...(info.max_tokens !== undefined ? { max_tokens: info.max_tokens } : {}),
    object: 'model',
    created: info.created,
    owned_by: info.owned_by,
  };
}

// ---------------------------------------------------------------------------
// Controls.

/**
 * Request-level controls the surface itself would otherwise synthesize
 * (`stream`) or reject later (`tools`, `top_k`). The Grok gateway contract
 * refuses them outright before any credential is touched; the other backends
 * keep their existing behaviour (SSE synthesized from the completed answer).
 */
export function assertBackendRequestControls(
  engine: Engine,
  controls: { stream?: unknown; tools?: unknown; top_k?: unknown },
): void {
  if (engine !== ENGINE_GROK) return;
  assertControlsSupported(
    { stream: controls.stream === true ? true : undefined, tools: controls.tools, top_k: controls.top_k },
    capabilitiesFor('runner-cli', engine),
  );
}
