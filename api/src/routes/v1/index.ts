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
import {
  resolveRequestedModel,
  UnsupportedModelError,
  buildModelList,
} from '../../services/openai-models.js';
import { createRunnerValidationService } from '../../services/runner-validation.js';
import { ENGINE_CODEX } from '../../util/engine.js';

/**
 * Optional test seam — supplying any of these overrides skips the default
 * production wiring for that piece. Used by integration tests to inject
 * stubbed services without touching MySQL or a runner.
 */
export interface OpenAiCompatOverrides {
  keys?: OpenAiKeyService;
  killSwitch?: KillSwitch;
  adapter?: RunnerOpenAiAdapter | null;
}

/**
 * Register the OpenAI-compatible `/v1/*` route group. The envelope plugin
 * already shapes errors via the `/v1/` URL prefix; this module only needs to
 * mount handlers, apply the auth + kill-switch preHandlers, and call into the
 * runner adapter.
 */
export async function registerOpenAiCompatRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  overrides: OpenAiCompatOverrides = {},
): Promise<void> {
  const keys = overrides.keys ?? new OpenAiKeyService({ db: ctx.db, keyring: ctx.keyring });
  const killSwitch = overrides.killSwitch ?? makeOpenAiKillSwitch(ctx.db);
  const keyResolver = makeOpenAiKeyResolver({
    keys,
    rateLimiter: app.rateLimiter,
  });
  const killSwitchHook = makeKillSwitchPreHandler(killSwitch);

  const runnerConfig = makeRunnerConfig(ctx.env);
  if (runnerConfig) {
    const runnerValidation = createRunnerValidationService({ db: ctx.db, keyring: ctx.keyring });
    runnerConfig.authSnapshot = async () => {
      const row = await runnerValidation.resolveCanonicalPayload(ENGINE_CODEX);
      if (!row) return null;
      return runnerValidation.canonicalAuthFromPayload(row);
    };
  }
  const adapter =
    overrides.adapter !== undefined
      ? overrides.adapter
      : runnerConfig
        ? new RunnerOpenAiAdapter(runnerConfig)
        : null;

  // OPTIONS: short-circuit at preHandler; CORS plugin sets the headers.
  app.options('/v1/*', async (_req, reply) => {
    reply.envelopeRaw = true;
    reply.code(204).send();
  });

  app.post('/v1/chat/completions', {
    preHandler: [killSwitchHook, keyResolver],
    handler: async (req, reply) => {
      ensureAdapter(adapter);
      const payload = parseBody(req.body);
      const messages = normalizeChatMessages(payload.messages);
      if (messages === null) {
        throw new ApiError('Missing required parameter: messages', {
          status: 400,
          code: 'invalid_request_error',
          type: 'invalid_request_error',
          param: 'messages',
        });
      }
      const model = resolveModel(payload.model);
      const params = extractParams(payload);
      const result = await adapter.chatCompletions(messages, model, params);

      if (payload.stream) {
        const events = chatCompletionStreamEvents(result as unknown as Record<string, unknown>);
        await pipeOpenAiStream(reply, asyncIter(events));
        return reply;
      }
      return result;
    },
  });

  app.post('/v1/responses', {
    preHandler: [killSwitchHook, keyResolver],
    handler: async (req, _reply) => {
      ensureAdapter(adapter);
      const payload = parseBody(req.body);
      const messages = normalizeResponsesInput(payload.input, payload.instructions);
      if (messages === null) {
        throw new ApiError('Missing required parameter: input', {
          status: 400,
          code: 'invalid_request_error',
          type: 'invalid_request_error',
          param: 'input',
        });
      }
      const model = resolveModel(payload.model);
      const params = extractParams(payload);
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
      ensureAdapter(adapter);
      const payload = parseBody(req.body);
      const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
      if (!prompt.trim()) {
        throw new ApiError('Missing required parameter: prompt', {
          status: 400,
          code: 'invalid_request_error',
          type: 'invalid_request_error',
          param: 'prompt',
        });
      }
      const model = resolveModel(payload.model);
      const params = extractParams(payload);
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
      // Runner backend has no embeddings support. Surface the same 501 the
      // legacy PHP NullBackendAdapter / RunnerBackendAdapter::embeddings emitted.
      throw new ApiError('Embeddings are not supported by this backend', {
        status: 501,
        code: 'feature_not_supported',
        type: 'not_implemented',
      });
    },
  });

  app.get('/v1/models', {
    preHandler: [killSwitchHook, keyResolver],
    handler: async () => buildModelList(),
  });
}

function makeKillSwitchPreHandler(kill: KillSwitch): preHandlerHookHandler {
  return async function killSwitchPreHandler(req): Promise<void> {
    if (req.method === 'OPTIONS') return;
    await kill.throwIfDisabled();
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

function resolveModel(value: unknown): string {
  try {
    return resolveRequestedModel(value);
  } catch (err) {
    if (err instanceof UnsupportedModelError) {
      throw new ApiError(err.message, {
        status: 400,
        code: 'invalid_request_error',
        type: 'invalid_request_error',
        param: 'model',
      });
    }
    throw err;
  }
}

function parseBody(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function extractParams(payload: Record<string, unknown>): OpenAiGenerationParams {
  const out: OpenAiGenerationParams = {};
  if (typeof payload.max_tokens === 'number') out.max_tokens = payload.max_tokens;
  if (typeof payload.temperature === 'number') out.temperature = payload.temperature;
  if (typeof payload.top_p === 'number') out.top_p = payload.top_p;
  if (typeof payload.stop === 'string') out.stop = payload.stop;
  else if (Array.isArray(payload.stop)) out.stop = payload.stop.filter((s) => typeof s === 'string') as string[];
  if (typeof payload.system === 'string') out.system = payload.system;
  return out;
}

async function* asyncIter<T>(items: Iterable<T>): AsyncIterable<T> {
  for (const item of items) yield item;
}
