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
  buildModelObject,
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
  const keyResolver = makeOpenAiKeyResolver({ keys });
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
      const model = resolveModel(payload.model);
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
    handler: async () => buildModelList(),
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
      // resolveModel upgrades legacy aliases and throws the 404 model_not_found
      // shape for unknown ids. Return the canonical resolved id's object.
      return buildModelObject(resolveModel(id));
    },
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
      // Upstream OpenAI returns HTTP 404 with error.code "model_not_found" for
      // an unknown/unavailable model, while keeping error.type
      // "invalid_request_error" and param null. (This is deliberately NOT the
      // Anthropic `not_found_error` type — the two wire formats differ here.)
      throw new ApiError(err.message, {
        status: 404,
        code: 'model_not_found',
        type: 'invalid_request_error',
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
