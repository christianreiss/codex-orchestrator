/**
 * Anthropic-compatible HTTP API. Mirrors the legacy
 * src/Http/Controllers/ClaudeApiController.php route surface:
 *
 *   OPTIONS /anthropic/v1/*       (CORS preflight)
 *   POST    /anthropic/v1/messages
 *   POST    /anthropic/v1/completions   (deprecated, supported)
 *   GET     /anthropic/v1/models
 *   POST    /anthropic/v1/responses     (SSE not implemented — same as PHP)
 *   POST    /anthropic/v1/embeddings    (501 — Anthropic has no embeddings API)
 *
 * Auth: `claude-key-resolver` preHandler (Bearer / x-api-key / raw).
 * Kill-switch: `claude-kill-switch` preHandler (versions flag `claude_api_disabled`).
 *
 * Per-key rate limit: bucket `anthropic:<key_id>` with the key's
 * `rate_limit_rpm` setting, in addition to the global IP bucket the rate-limit
 * plugin already enforces.
 *
 * Streaming: synthesised SSE events from the completed runner response, same
 * shape as the legacy PHP `AnthropicCompat::messageStreamEvents`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
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
import {
  createClaudeModelsService,
  type ClaudeModelsService,
} from '../../services/claude-models.js';
import {
  createRunnerClaudeAdapter,
  type RunnerClaudeAdapter,
} from '../../services/adapters/runner-claude.js';
import {
  extractParams,
  extractSystemMessages,
  normalizeChatMessages,
  normalizeResponsesInput,
  responseFromMessage,
} from '../../services/anthropic-compat.js';
import { messageStreamEvents, writeSseResponse } from '../../http/stream/anthropic-sse.js';
import { createRunnerValidationService } from '../../services/runner-validation.js';
import { ENGINE_CLAUDE } from '../../util/engine.js';

interface AnthropicRouteDeps {
  keyResolver: ClaudeKeyResolver;
  killSwitch: ClaudeKillSwitch;
  models: ClaudeModelsService;
  adapter: RunnerClaudeAdapter | null;
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
}

export async function registerAnthropicCompatRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  options: RegisterAnthropicCompatOptions = {},
): Promise<void> {
  const keyResolver = options.keyResolver ?? createClaudeKeyResolver(ctx.db);
  const killSwitch = options.killSwitch ?? createClaudeKillSwitch(ctx.db);
  const models = options.models ?? createClaudeModelsService(ctx.db);
  const runnerValidation = createRunnerValidationService({ db: ctx.db, keyring: ctx.keyring });
  const defaultAuthSnapshot = async (): Promise<unknown | null> => {
    const row = await runnerValidation.resolveCanonicalPayload(ENGINE_CLAUDE);
    if (!row) return null;
    return runnerValidation.canonicalAuthFromPayload(row);
  };
  const adapter =
    options.adapter !== undefined
      ? options.adapter
      : createRunnerClaudeAdapter({
          env: ctx.env,
          getAuthSnapshot: options.getAuthSnapshot ?? defaultAuthSnapshot,
        });

  const deps: AnthropicRouteDeps = { keyResolver, killSwitch, models, adapter };

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
    preHandler: [killSwitchHook(deps), keyResolver.preHandler, rateLimitHook(app)],
    handler: async (req, reply) => {
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
      const model = await models.resolveRequestedModel(payload.model);
      const params = extractParams(payload);

      // Prefer top-level `system` over inline system messages. `extractParams`
      // already normalized the string-or-block-array form onto params.system.
      if (params.system === undefined) {
        const extracted = extractSystemMessages(messages);
        if (extracted.system) {
          params.system = extracted.system;
          messages = extracted.messages;
        }
      }

      ensureAdapter(deps);
      const result = await deps.adapter!.messages(messages, model, params);

      if (payload.stream === true) {
        await writeSseResponse(reply, messageStreamEvents(result));
        return reply;
      }
      return result;
    },
  });

  // POST /anthropic/v1/completions — text completion form. Build a single
  // user message from the prompt and run it through the messages backend.
  app.route({
    method: 'POST',
    url: '/anthropic/v1/completions',
    preHandler: [killSwitchHook(deps), keyResolver.preHandler, rateLimitHook(app)],
    handler: async (req, reply) => {
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
      const model = await models.resolveRequestedModel(payload.model);
      const params = extractParams(payload);
      ensureAdapter(deps);
      const result = await deps.adapter!.messages(
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

      return {
        id: result.id.startsWith('cmpl-') ? result.id : `cmpl-${result.id.replace(/^[^_]+_/, '')}`,
        type: 'completion',
        completion: text,
        model: result.model || model,
        stop_reason: result.stop_reason ?? 'end_turn',
        usage: result.usage ?? { input_tokens: 0, output_tokens: 0 },
      };
    },
  });

  // GET /anthropic/v1/models — static catalog (filtered to enabled models).
  app.route({
    method: 'GET',
    url: '/anthropic/v1/models',
    preHandler: [killSwitchHook(deps), keyResolver.preHandler, rateLimitHook(app)],
    handler: async () => {
      return models.modelsResponse();
    },
  });

  // GET /anthropic/v1/models/:model_id — single-model lookup (Models API).
  app.route({
    method: 'GET',
    url: '/anthropic/v1/models/:model_id',
    preHandler: [killSwitchHook(deps), keyResolver.preHandler, rateLimitHook(app)],
    handler: async (req) => {
      const { model_id: modelId } = req.params as { model_id?: string };
      return models.modelResponse(modelId ?? '');
    },
  });

  // POST /anthropic/v1/responses — OpenAI-style responses wrapping a Claude
  // call. The PHP version refuses streaming here; we keep the same constraint.
  app.route({
    method: 'POST',
    url: '/anthropic/v1/responses',
    preHandler: [killSwitchHook(deps), keyResolver.preHandler, rateLimitHook(app)],
    handler: async (req) => {
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
      ensureAdapter(deps);
      const result = await deps.adapter!.messages(messages, model, params);
      return responseFromMessage(result);
    },
  });

  // POST /anthropic/v1/embeddings — 501; Anthropic has no embeddings endpoint.
  app.route({
    method: 'POST',
    url: '/anthropic/v1/embeddings',
    preHandler: [killSwitchHook(deps), keyResolver.preHandler, rateLimitHook(app)],
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
  };
}

function rateLimitHook(app: FastifyInstance) {
  return async function perKeyRateLimit(req: FastifyRequest) {
    const apiKey = req.claudeApiKey;
    if (!apiKey) return; // resolver ran first; if missing, request will already have failed
    const ip = req.clientIp || '0.0.0.0';
    const rpm = apiKey.rateLimitRpm > 0 ? apiKey.rateLimitRpm : 60;
    const bucket = `anthropic:${apiKey.id}`;
    const res = await app.rateLimiter.hit(ip, bucket, { limit: rpm, windowSeconds: 60 });
    if (!res.ok) {
      const retryAfter = Math.max(
        1,
        Math.ceil((new Date(res.resetAt).getTime() - Date.now()) / 1000),
      );
      throw new ApiError('Rate limit exceeded. Please retry after 60 seconds.', {
        status: 429,
        code: 'rate_limit_exceeded',
        type: 'rate_limit_error',
        extra: { bucket, reset_at: res.resetAt },
        headers: { 'Retry-After': String(retryAfter) },
      });
    }
  };
}

function ensureAdapter(deps: AnthropicRouteDeps): void {
  if (!deps.adapter) {
    throw new ApiError(
      'Anthropic API backend is not configured. Ensure the runner is available.',
      { status: 503, code: 'backend_unavailable', type: 'api_error' },
    );
  }
}
