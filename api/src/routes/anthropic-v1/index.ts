/**
 * Anthropic-compatible HTTP API. Mirrors the legacy
 * src/Http/Controllers/ClaudeApiController.php route surface. Every route this
 * module registers:
 *
 *   OPTIONS /anthropic/v1/*                     (CORS preflight)
 *   POST    /anthropic/v1/messages
 *   POST    /anthropic/v1/messages/count_tokens (estimate — no server tokenizer)
 *   POST    /anthropic/v1/complete              (legacy Text Completions)
 *   POST    /anthropic/v1/completions           (deprecated alias of /complete)
 *   GET     /anthropic/v1/models
 *   GET     /anthropic/v1/models/:model_id      (single-model lookup)
 *   POST    /anthropic/v1/responses             (SSE not implemented — same as PHP)
 *   POST    /anthropic/v1/embeddings            (501 — Anthropic has no embeddings API)
 *
 * Auth: `claude-key-resolver` preHandler (Bearer / x-api-key / raw).
 * Kill-switch: `claude-kill-switch` preHandler (versions flag `claude_api_disabled`).
 *
 * Streaming: synthesised SSE events from the completed runner response, same
 * shape as the legacy PHP `AnthropicCompat::messageStreamEvents`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { RouteContext } from '../index.js';
import { ApiError } from '../../http/errors.js';
import {
  createClaudeKeyResolver,
  type ClaudeKeyResolver,
} from '../../services/claude-key-resolver.js';
import {
  createClaudeKillSwitch,
  type ClaudeKillSwitch,
} from '../../services/claude-kill-switch.js';
import type { ClaudeModelsService } from '../../services/claude-models.js';
import {
  createRunnerClaudeAdapter,
  type RunnerClaudeAdapter,
} from '../../services/adapters/runner-claude.js';
import {
  estimateTokenCount,
  extractParams,
  extractSystemMessages,
  mergeConsecutiveSameRole,
  normalizeChatMessages,
  normalizeResponsesInput,
  normalizeSystemPrompt,
  responseFromMessage,
  validateMessageSequence,
} from '../../services/anthropic-compat.js';
import { messageStreamEvents, writeSseResponse } from '../../http/stream/anthropic-sse.js';
import { API_SURFACES } from '../../services/api-surfaces.js';
import {
  anthropicModelObject,
  assertBackendRequestControls,
  assertSurfaceBackendEnabled,
  defaultGatewayWiring,
  resolveGenerationModel,
  type GatewayBackend,
  type GatewayWiring,
} from '../../services/gateway-backends.js';
import type { Engine } from '../../util/engine.js';

/** The surface's model operations, in the Anthropic Models API shape. */
interface AnthropicModels {
  resolveRequestedModel(value: unknown): Promise<string>;
  modelsResponse(): Promise<unknown>;
  modelResponse(value: unknown): Promise<unknown>;
}

interface AnthropicRouteDeps {
  keyResolver: ClaudeKeyResolver;
  killSwitch: ClaudeKillSwitch;
  /** The backend this request runs on right now, with its adapter and models. */
  backend(): Promise<{ backend: GatewayBackend; adapter: RunnerClaudeAdapter | null; models: AnthropicModels }>;
  /** Throws 503 when that backend engine is switched off fleet-wide. */
  backendEnabled(): Promise<void>;
}

export interface RegisterAnthropicCompatOptions {
  /** Test/integration override for the runner adapter. */
  adapter?: RunnerClaudeAdapter | null;
  /** Test/integration override for the auth-snapshot provider. */
  getAuthSnapshot?: () => Promise<unknown | null>;
  /** Test override for the key resolver. */
  keyResolver?: ClaudeKeyResolver;
  /** Test override for the kill switch. */
  killSwitch?: ClaudeKillSwitch;
  /** Test override for the models service. */
  models?: ClaudeModelsService;
  /** Shared backends + routing; built per registration when absent. */
  gateway?: GatewayWiring;
}

const SURFACE = API_SURFACES.anthropic;

export async function registerAnthropicCompatRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  options: RegisterAnthropicCompatOptions = {},
): Promise<void> {
  const keyResolver = options.keyResolver ?? createClaudeKeyResolver(ctx.db);
  const killSwitch = options.killSwitch ?? createClaudeKillSwitch(ctx.db);
  const gateway = options.gateway ?? defaultGatewayWiring(ctx, app.log);
  const identity = SURFACE.identityBackend;
  const adapters = new Map<Engine, RunnerClaudeAdapter | null>();

  const adapterFor = (backend: GatewayBackend): RunnerClaudeAdapter | null => {
    if (backend.engine === identity && options.adapter !== undefined) return options.adapter;
    if (!adapters.has(backend.engine)) {
      // Successful gateway execs prove the canonical credential live; the
      // backend's traffic verifier touches its verification stamp so
      // background probes stay idle while real traffic flows. Test overrides
      // of getAuthSnapshot leave the touch a no-op (their snapshots have no
      // recorded canonical row).
      adapters.set(backend.engine, createRunnerClaudeAdapter({
        env: ctx.env,
        engine: backend.engine,
        getAuthSnapshot: (backend.engine === identity ? options.getAuthSnapshot : undefined) ?? backend.authSnapshot,
        onExecSuccess: backend.onExecSuccess,
      }));
    }
    return adapters.get(backend.engine) ?? null;
  };

  const modelsFor = (backend: GatewayBackend): AnthropicModels => {
    if (backend.engine === identity && options.models) return options.models;
    return {
      resolveRequestedModel: (value) => resolveGenerationModel(backend, identity, value).catch(asAnthropicNotFound),
      async modelsResponse() {
        const data = (await backend.models.catalog()).map(anthropicModelObject);
        return {
          data,
          has_more: false,
          first_id: data[0]?.id ?? null,
          last_id: data[data.length - 1]?.id ?? null,
          object: 'list',
        };
      },
      async modelResponse(value) {
        // A lookup has no default and no cross-wire fallback: strict 404.
        if (typeof value !== 'string' || value.trim() === '') {
          throw new ApiError('Model not found', {
            status: 404,
            code: 'model_not_found',
            type: 'not_found_error',
            param: 'model_id',
          });
        }
        return anthropicModelObject(backend.models.info(await backend.models.resolve(value).catch(asAnthropicNotFound)));
      },
    };
  };

  const deps: AnthropicRouteDeps = {
    keyResolver,
    killSwitch,
    async backend() {
      const backend = gateway.backends.get(await gateway.routing.backendFor(SURFACE.id));
      return { backend, adapter: adapterFor(backend), models: modelsFor(backend) };
    },
    backendEnabled: () => assertSurfaceBackendEnabled(ctx.db, gateway.routing, SURFACE.id),
  };

  // OPTIONS preflight — CORS plugin handles headers; we just need a 204.
  app.route({
    method: 'OPTIONS',
    url: '/anthropic/v1/*',
    handler: async (_req, reply) => {
      reply.envelopeRaw = true;
      reply.status(204).send();
    },
  });

  // POST /anthropic/v1/messages — primary Anthropic surface.
  app.route({
    method: 'POST',
    url: '/anthropic/v1/messages',
    preHandler: [
      requestIdHook(),
      killSwitchHook(deps),
      keyResolver.preHandler,
      versionHeaderHook(),
    ],
    handler: async (req, reply) => {
      const { backend, adapter, models } = await deps.backend();
      const payload = (req.body ?? {}) as Record<string, unknown>;
      let messages = normalizeChatMessages(payload.messages);
      if (!messages) {
        throw new ApiError('Missing required parameter: messages', {
          status: 400,
          code: 'missing_messages',
          type: 'invalid_request_error',
          param: 'messages',
        });
      }
      if (Array.isArray(payload.tools) && payload.tools.length > 0) {
        throw new ApiError(
          'Tool use is not supported by this backend yet. Remove `tools`/`tool_choice` from the request.',
          { status: 400, code: 'tools_not_supported', type: 'invalid_request_error', param: 'tools' },
        );
      }
      assertBackendRequestControls(backend.engine, { stream: payload.stream });
      const model = await models.resolveRequestedModel(payload.model);
      const params = extractParams(payload, { requireMaxTokens: true });

      // Prefer top-level `system` over inline system messages. `extractParams`
      // already normalized the string-or-block-array form onto params.system.
      if (params.system === undefined) {
        const extracted = extractSystemMessages(messages);
        if (extracted.system) {
          params.system = extracted.system;
          messages = extracted.messages;
        }
      }
      validateMessageSequence(messages);
      // Upstream combines consecutive same-role turns into a single turn.
      messages = mergeConsecutiveSameRole(messages);

      ensureAdapter(adapter);
      const result = await adapter.messages(messages, model, params);

      if (payload.stream === true) {
        await writeSseResponse(reply, messageStreamEvents(result));
        return reply;
      }
      return result;
    },
  });

  // POST /anthropic/v1/messages/count_tokens — best-effort token estimate.
  // No real tokenizer is available server-side (see estimateTokenCount); this
  // exists so SDK clients get a plausible answer instead of a 404.
  app.route({
    method: 'POST',
    url: '/anthropic/v1/messages/count_tokens',
    preHandler: [
      requestIdHook(),
      killSwitchHook(deps),
      keyResolver.preHandler,
      versionHeaderHook(),
    ],
    handler: async (req) => {
      const { models } = await deps.backend();
      const payload = (req.body ?? {}) as Record<string, unknown>;
      const messages = normalizeChatMessages(payload.messages);
      if (!messages) {
        throw new ApiError('Missing required parameter: messages', {
          status: 400,
          code: 'missing_messages',
          type: 'invalid_request_error',
          param: 'messages',
        });
      }
      await models.resolveRequestedModel(payload.model);
      const system = normalizeSystemPrompt(payload.system);
      const tools = Array.isArray(payload.tools) ? payload.tools : [];
      return { input_tokens: estimateTokenCount(messages, system, tools) };
    },
  });

  // Legacy Text Completions. The official anthropic SDKs post to the singular
  // `/complete`; the plural `/completions` is kept as a harmless extra alias.
  const completionsPreHandler = [
    requestIdHook(),
    killSwitchHook(deps),
    keyResolver.preHandler,
    versionHeaderHook(),
  ];
  const completionsHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const { backend, adapter, models } = await deps.backend();
    const payload = (req.body ?? {}) as Record<string, unknown>;
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    if (!prompt.trim()) {
      throw new ApiError('Missing required parameter: prompt', {
        status: 400,
        code: 'missing_prompt',
        type: 'invalid_request_error',
        param: 'prompt',
      });
    }
    assertBackendRequestControls(backend.engine, { stream: payload.stream });
    const model = await models.resolveRequestedModel(payload.model);
    const params = extractParams(payload);
    ensureAdapter(adapter);
    const result = await adapter.messages(
      [{ role: 'user', content: prompt }],
      model,
      params,
    );

    let text = '';
    for (const b of result.content ?? []) if (b.type === 'text') text += b.text;

    if (payload.stream === true) {
      // Re-shape as a Message before streaming so the event sequence matches.
      await writeSseResponse(
        reply,
        messageStreamEvents({
          ...result,
          content: [{ type: 'text', text }],
        }),
      );
      return reply;
    }

    // Text Completions uses `compl_` ids and its own stop_reason enum
    // (stop_sequence | max_tokens) — not the Messages value `end_turn`.
    const suffix = (result.id || '').replace(/^[^_]+_/, '');
    const id = `compl_${suffix || randomBytes(16).toString('hex')}`;
    const stopReason = result.stop_reason === 'max_tokens' ? 'max_tokens' : 'stop_sequence';
    return {
      id,
      type: 'completion',
      completion: text,
      model: result.model || model,
      stop_reason: stopReason,
      usage: result.usage ?? { input_tokens: 0, output_tokens: 0 },
    };
  };
  app.route({
    method: 'POST',
    url: '/anthropic/v1/complete',
    preHandler: completionsPreHandler,
    handler: completionsHandler,
  });
  app.route({
    method: 'POST',
    url: '/anthropic/v1/completions',
    preHandler: completionsPreHandler,
    handler: completionsHandler,
  });

  // GET /anthropic/v1/models — static catalog (filtered to enabled models).
  app.route({
    method: 'GET',
    url: '/anthropic/v1/models',
    preHandler: [
      requestIdHook(),
      killSwitchHook(deps),
      keyResolver.preHandler,
      versionHeaderHook(),
    ],
    handler: async () => {
      const { models } = await deps.backend();
      return models.modelsResponse();
    },
  });

  // GET /anthropic/v1/models/:model_id — single-model lookup (Models API).
  app.route({
    method: 'GET',
    url: '/anthropic/v1/models/:model_id',
    preHandler: [
      requestIdHook(),
      killSwitchHook(deps),
      keyResolver.preHandler,
      versionHeaderHook(),
    ],
    handler: async (req) => {
      const { models } = await deps.backend();
      const { model_id: modelId } = req.params as { model_id?: string };
      return models.modelResponse(modelId ?? '');
    },
  });

  // POST /anthropic/v1/responses — OpenAI-style responses wrapping a Claude
  // call. The PHP version refuses streaming here; we keep the same constraint.
  app.route({
    method: 'POST',
    url: '/anthropic/v1/responses',
    preHandler: [
      requestIdHook(),
      killSwitchHook(deps),
      keyResolver.preHandler,
      versionHeaderHook(),
    ],
    handler: async (req) => {
      const { adapter, models } = await deps.backend();
      const payload = (req.body ?? {}) as Record<string, unknown>;
      if (payload.stream === true) {
        throw new ApiError(
          'Streaming responses are not implemented for this backend yet.',
          {
            status: 400,
            code: 'unsupported_stream',
            type: 'invalid_request_error',
          },
        );
      }
      const messages = normalizeResponsesInput(payload.input, payload.instructions);
      if (!messages) {
        throw new ApiError('Missing required parameter: input', {
          status: 400,
          code: 'missing_input',
          type: 'invalid_request_error',
          param: 'input',
        });
      }
      const model = await models.resolveRequestedModel(payload.model);
      const params = extractParams(payload);
      ensureAdapter(adapter);
      const result = await adapter.messages(messages, model, params);
      return responseFromMessage(result);
    },
  });

  // POST /anthropic/v1/embeddings — 501; Anthropic has no embeddings endpoint.
  app.route({
    method: 'POST',
    url: '/anthropic/v1/embeddings',
    preHandler: [
      requestIdHook(),
      killSwitchHook(deps),
      keyResolver.preHandler,
      versionHeaderHook(),
    ],
    handler: async () => {
      throw new ApiError('Anthropic API does not support embeddings', {
        status: 501,
        code: 'embeddings_unsupported',
        type: 'invalid_request_error',
      });
    },
  });
}

function killSwitchHook(deps: AnthropicRouteDeps) {
  return async function checkKillSwitch(_req: FastifyRequest) {
    await deps.killSwitch.ensureEnabled();
    await deps.backendEnabled();
  };
}

/** Anthropic SDKs read this specific header for diagnostics/support requests —
 * distinct from this gateway's own general-purpose `x-request-id`. */
function requestIdHook() {
  return async function anthropicRequestId(_req: FastifyRequest, reply: FastifyReply) {
    reply.header('request-id', `req_${randomBytes(16).toString('hex')}`);
  };
}

const SUPPORTED_ANTHROPIC_VERSIONS = new Set(['2023-06-01', '2023-01-01']);

function versionHeaderHook() {
  return async function checkAnthropicVersion(req: FastifyRequest) {
    const raw = req.headers['anthropic-version'];
    const version = Array.isArray(raw) ? raw[0] : raw;
    if (!version || !SUPPORTED_ANTHROPIC_VERSIONS.has(version)) {
      throw new ApiError(
        `anthropic-version: "${version ?? ''}" is not a supported version. Use one of: ${Array.from(SUPPORTED_ANTHROPIC_VERSIONS).join(', ')}`,
        { status: 400, code: 'invalid_anthropic_version', type: 'invalid_request_error' },
      );
    }
  };
}

/** Another backend's unknown-model 404 in Anthropic's spelling (`not_found_error`). */
function asAnthropicNotFound(err: unknown): never {
  if (err instanceof ApiError && err.status === 404) {
    throw new ApiError(err.message, { status: 404, code: err.code, type: 'not_found_error', param: err.param ?? 'model' });
  }
  throw err;
}

function ensureAdapter(adapter: RunnerClaudeAdapter | null): asserts adapter is RunnerClaudeAdapter {
  if (!adapter) {
    throw new ApiError(
      'Anthropic API backend is not configured. Ensure the runner is available.',
      { status: 503, code: 'backend_unavailable', type: 'api_error' },
    );
  }
}
