import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { RouteContext } from '../index.js';
import { ApiError } from '../../http/errors.js';
import { OpenAiKeyService } from '../../services/openai-keys.js';
import { makeOpenAiKeyResolver } from '../../services/openai-key-resolver.js';
import { makeOpenAiKillSwitch, type KillSwitch } from '../../services/openai-kill-switch.js';
import {
  RunnerOpenAiAdapter,
  makeRunnerConfig,
  normalizeChatMessages,
  normalizeResponsesInput,
  type OpenAiGenerationParams,
} from '../../services/adapters/runner-openai.js';
import {
  chatCompletionStreamEvents,
  pipeOpenAiStream,
} from '../../services/stream/openai-sse.js';
import { API_SURFACES, type ApiSurfaceId } from '../../services/api-surfaces.js';
import {
  assertBackendRequestControls,
  assertSurfaceBackendEnabled,
  defaultGatewayWiring,
  openAiModelObject,
  resolveGenerationModel,
  type GatewayBackend,
  type GatewayWiring,
} from '../../services/gateway-backends.js';
import type { Engine } from '../../util/engine.js';

/**
 * Optional test seam — supplying any of these overrides skips the default
 * production wiring for that piece. Used by integration tests to inject
 * stubbed services without touching MySQL or a runner.
 */
export interface OpenAiCompatOverrides {
  /** Which OpenAI-wire surface this mounts: `/v1` (default) or `/grok/v1`. */
  surface?: Extract<ApiSurfaceId, 'openai' | 'grok'>;
  /** Shared backends + routing; built per registration when absent. */
  gateway?: GatewayWiring;
  // The overrides below replace pieces of the surface's identity backend only.
  authSnapshot?: () => Promise<unknown | null>;
  onExecSuccess?: (snapshot: unknown) => void;
  models?: {
    resolveRequestedModel(value: unknown): Promise<string>;
    modelsResponse(): Promise<unknown>;
  };
  keys?: OpenAiKeyService;
  killSwitch?: KillSwitch;
  adapter?: RunnerOpenAiAdapter | null;
}

/**
 * Register an OpenAI-wire route group (`/v1/*`, or `/grok/v1/*` when mounted
 * under the `/grok` prefix). The envelope plugin already shapes errors via the
 * URL prefix; this module mounts handlers, applies the surface's auth +
 * kill-switch preHandlers, and hands each request to whichever backend engine
 * the surface is routed to right now (see `api-surfaces.ts`).
 */
export async function registerOpenAiCompatRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  overrides: OpenAiCompatOverrides = {},
): Promise<void> {
  const surface = API_SURFACES[overrides.surface ?? 'openai'];
  const gateway = overrides.gateway ?? defaultGatewayWiring(ctx, app.log);
  const keys = overrides.keys ?? new OpenAiKeyService({ db: ctx.db, keyring: ctx.keyring });
  const killSwitch = overrides.killSwitch ?? makeOpenAiKillSwitch(ctx.db, surface.disabledFlag, surface.id === 'grok' ? 'Grok' : 'OpenAI');
  const keyResolver = makeOpenAiKeyResolver({ keys, engine: surface.keyEngine });
  const killSwitchHook = makeKillSwitchPreHandler(killSwitch, () =>
    assertSurfaceBackendEnabled(ctx.db, gateway.routing, surface.id),
  );

  const identity = surface.identityBackend;
  const adapters = new Map<Engine, RunnerOpenAiAdapter | null>();
  const adapterFor = (backend: GatewayBackend): RunnerOpenAiAdapter | null => {
    if (backend.engine === identity && overrides.adapter !== undefined) return overrides.adapter;
    if (!adapters.has(backend.engine)) {
      const runnerConfig = makeRunnerConfig(ctx.env, backend.engine);
      if (runnerConfig) {
        // Successful gateway execs prove the canonical credential live; the
        // backend's traffic verifier touches its verification stamp so
        // background probes stay idle while real traffic flows.
        const own = backend.engine === identity;
        runnerConfig.authSnapshot = (own ? overrides.authSnapshot : undefined) ?? backend.authSnapshot;
        runnerConfig.onExecSuccess = (own ? overrides.onExecSuccess : undefined) ?? backend.onExecSuccess;
      }
      adapters.set(backend.engine, runnerConfig ? new RunnerOpenAiAdapter(runnerConfig) : null);
    }
    return adapters.get(backend.engine) ?? null;
  };
  const backendNow = async (): Promise<GatewayBackend> =>
    gateway.backends.get(await gateway.routing.backendFor(surface.id));
  const resolveRequested = (backend: GatewayBackend, value: unknown): Promise<string> =>
    backend.engine === identity && overrides.models
      ? overrides.models.resolveRequestedModel(value)
      : resolveGenerationModel(backend, identity, value);
  const validateBackendControls = (backend: GatewayBackend, payload: Record<string, unknown>) =>
    assertBackendRequestControls(backend.engine, { stream: payload.stream, tools: payload.tools ?? payload.functions, top_k: payload.top_k });

  // OPTIONS: short-circuit at preHandler; CORS plugin sets the headers.
  app.options('/v1/*', async (_req, reply) => {
    reply.envelopeRaw = true;
    reply.code(204).send();
  });

  app.post('/v1/chat/completions', {
    preHandler: [killSwitchHook, keyResolver],
    handler: async (req, reply) => {
      const backend = await backendNow();
      const adapter = adapterFor(backend);
      ensureAdapter(adapter);
      const payload = parseBody(req.body);
      validateBackendControls(backend, payload);
      const messages = normalizeChatMessages(payload.messages);
      if (messages === null) {
        throw new ApiError('Missing required parameter: messages', {
          status: 400,
          code: 'invalid_request_error',
          type: 'invalid_request_error',
          param: 'messages',
        });
      }
      // This backend cannot emit tool_calls. Silently returning plain text when
      // the client FORCED a tool call (tool_choice:'required'/named function,
      // or a named legacy function_call) is a wire lie that hangs agentic
      // loops, so fail closed. tool_choice:'auto'/'none'/absent still returns
      // text, which is wire-legal upstream.
      if (toolChoiceForcesCall(payload)) {
        throw new ApiError(
          'Tool calling is not supported by this backend; a forced tool call (tool_choice "required" or a named function) cannot be fulfilled. Remove tool_choice or set it to "auto".',
          {
            status: 400,
            code: 'tools_not_supported',
            type: 'invalid_request_error',
            param: 'tool_choice',
          },
        );
      }
      const model = await resolveRequested(backend, payload.model);
      const params = extractParams(payload, { capKeys: ['max_completion_tokens', 'max_tokens'] });
      const result = await adapter.chatCompletions(messages, model, params);

      if (payload.stream) {
        const events = chatCompletionStreamEvents(result as unknown as Record<string, unknown>, {
          includeUsage: wantsUsageChunk(payload),
        });
        await pipeOpenAiStream(reply, asyncIter(events));
        return reply;
      }
      return result;
    },
  });

  app.post('/v1/responses', {
    preHandler: [killSwitchHook, keyResolver],
    handler: async (req, _reply) => {
      const backend = await backendNow();
      const adapter = adapterFor(backend);
      ensureAdapter(adapter);
      const payload = parseBody(req.body);
      validateBackendControls(backend, payload);
      const messages = normalizeResponsesInput(payload.input, payload.instructions);
      if (messages === null) {
        throw new ApiError('Missing required parameter: input', {
          status: 400,
          code: 'invalid_request_error',
          type: 'invalid_request_error',
          param: 'input',
        });
      }
      const model = await resolveRequested(backend, payload.model);
      const params = extractParams(payload, { capKeys: ['max_output_tokens'] });
      if (payload.stream) {
        throw new ApiError(
          'Streaming responses are not implemented for this backend yet.',
          {
            status: 400,
            code: 'unsupported_stream',
            type: 'invalid_request_error',
          },
        );
      }
      return adapter.responses(messages, model, params);
    },
  });

  app.post('/v1/completions', {
    preHandler: [killSwitchHook, keyResolver],
    handler: async (req, reply) => {
      const backend = await backendNow();
      const adapter = adapterFor(backend);
      ensureAdapter(adapter);
      const payload = parseBody(req.body);
      validateBackendControls(backend, payload);
      const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
      if (!prompt.trim()) {
        throw new ApiError('Missing required parameter: prompt', {
          status: 400,
          code: 'invalid_request_error',
          type: 'invalid_request_error',
          param: 'prompt',
        });
      }
      const model = await resolveRequested(backend, payload.model);
      const params = extractParams(payload, { capKeys: ['max_tokens'] });
      const result = await adapter.completions(prompt, model, params);

      if (payload.stream) {
        await pipeOpenAiStream(reply, asyncIter([{ data: result as unknown }]));
        return reply;
      }
      return result;
    },
  });

  app.post('/v1/embeddings', {
    preHandler: [killSwitchHook, keyResolver],
    handler: async () => {
      // Runner backend has no embeddings support. Return a non-retriable 4xx
      // with an OpenAI-shaped type: a 501 (`not_implemented`) leaked an
      // Anthropic/internal type and, being >=500, triggered the OpenAI SDK's
      // exponential-backoff retry loop against a permanently-unsupported call.
      throw new ApiError('Embeddings are not supported by this backend', {
        status: 400,
        code: 'unsupported_endpoint',
        type: 'invalid_request_error',
      });
    },
  });

  app.get('/v1/models', {
    preHandler: [killSwitchHook, keyResolver],
    handler: async () => {
      const backend = await backendNow();
      if (backend.engine === identity && overrides.models) return overrides.models.modelsResponse();
      return { object: 'list', data: (await backend.models.catalog()).map(openAiModelObject) };
    },
  });

  // GET /v1/models/{model} — single-model retrieve (OpenAI `models.retrieve()`).
  // Without this route the request fell through to the SPA/404 handler, so every
  // client.models.retrieve(...) 404'd. Unknown ids get the same 404 +
  // model_not_found shape as the chat/completions path.
  app.get('/v1/models/:model', {
    preHandler: [killSwitchHook, keyResolver],
    handler: async (req) => {
      const { model } = req.params as { model?: string };
      const id = typeof model === 'string' ? model.trim() : '';
      if (id === '') {
        throw new ApiError('The model does not exist', {
          status: 404,
          code: 'model_not_found',
          type: 'invalid_request_error',
        });
      }
      // Strict lookup in the backend's catalog: legacy aliases upgrade, unknown
      // ids throw the 404 model_not_found shape, and — unlike a generation
      // request — another wire's model id never falls back to the default.
      const backend = await backendNow();
      const selected = backend.engine === identity && overrides.models
        ? await overrides.models.resolveRequestedModel(id)
        : await backend.models.resolve(id);
      return openAiModelObject(backend.models.info(selected));
    },
  });
}

function makeKillSwitchPreHandler(kill: KillSwitch, backendEnabled: () => Promise<void>): preHandlerHookHandler {
  return async function killSwitchPreHandler(req): Promise<void> {
    if (req.method === 'OPTIONS') return;
    await kill.throwIfDisabled();
    await backendEnabled();
  };
}

function ensureAdapter(
  adapter: RunnerOpenAiAdapter | null,
): asserts adapter is RunnerOpenAiAdapter {
  if (!adapter) {
    throw new ApiError(
      'OpenAI API backend is not configured. Ensure the runner is available.',
      { status: 503, code: 'backend_unavailable', type: 'api_error' },
    );
  }
}

function parseBody(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

/**
 * Extract generation params, reading the correct output-cap parameter for the
 * endpoint. `capKeys` is a priority-ordered list of the request fields that
 * carry the output token cap: chat completions use `max_completion_tokens`
 * (with the deprecated `max_tokens` as fallback), the Responses API uses
 * `max_output_tokens`, and legacy completions use `max_tokens`. The first
 * present numeric key wins and is mapped onto the runner cap. Previously only
 * `max_tokens` was read, so a modern SDK client's cap was silently dropped.
 *
 * `temperature`/`top_p` are range-validated against the upstream bounds
 * ([0,2] and [0,1]); an out-of-range value 400s the way upstream does. Valid
 * values (including 0 and fractions) are untouched.
 */
function extractParams(
  payload: Record<string, unknown>,
  opts: { capKeys: readonly string[] },
): OpenAiGenerationParams {
  const out: OpenAiGenerationParams = {};

  for (const key of opts.capKeys) {
    const v = payload[key];
    if (typeof v === 'number') {
      if (!Number.isInteger(v) || v < 1) {
        throw new ApiError(`${key} must be a positive integer`, {
          status: 400,
          code: 'invalid_request_error',
          type: 'invalid_request_error',
          param: key,
        });
      }
      out.max_tokens = v;
      break;
    }
  }

  if (typeof payload.temperature === 'number') {
    if (payload.temperature < 0 || payload.temperature > 2) {
      throw new ApiError('temperature must be between 0 and 2', {
        status: 400,
        code: 'invalid_request_error',
        type: 'invalid_request_error',
        param: 'temperature',
      });
    }
    out.temperature = payload.temperature;
  }
  if (typeof payload.top_p === 'number') {
    if (payload.top_p < 0 || payload.top_p > 1) {
      throw new ApiError('top_p must be between 0 and 1', {
        status: 400,
        code: 'invalid_request_error',
        type: 'invalid_request_error',
        param: 'top_p',
      });
    }
    out.top_p = payload.top_p;
  }
  if (typeof payload.stop === 'string') out.stop = payload.stop;
  else if (Array.isArray(payload.stop)) out.stop = payload.stop.filter((s) => typeof s === 'string') as string[];
  if (typeof payload.system === 'string') out.system = payload.system;
  return out;
}

/** True when the client asked for a usage chunk via `stream_options.include_usage`. */
function wantsUsageChunk(payload: Record<string, unknown>): boolean {
  const so = payload.stream_options;
  return !!so && typeof so === 'object' && (so as Record<string, unknown>).include_usage === true;
}

/**
 * True when the request forces a tool call the backend can't fulfill:
 * `tool_choice:"required"`, a named `tool_choice:{type:"function"|"tool", ...}`,
 * or a named legacy `function_call`. `auto`/`none`/absent do NOT force a call.
 */
function toolChoiceForcesCall(payload: Record<string, unknown>): boolean {
  const tc = payload.tool_choice;
  if (tc === 'required') return true;
  if (tc && typeof tc === 'object') {
    const type = (tc as Record<string, unknown>).type;
    if (type === 'function' || type === 'tool') return true;
  }
  const fc = payload.function_call;
  if (fc === 'required') return true;
  if (fc && typeof fc === 'object') return true; // { name: "..." } forces the named function
  return false;
}

async function* asyncIter<T>(items: Iterable<T>): AsyncIterable<T> {
  for (const item of items) yield item;
}
