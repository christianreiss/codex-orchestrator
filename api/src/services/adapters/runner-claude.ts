import { assertRunnerPrompt } from './runner-prompt.js';
import { withRunnerCancellation } from './runner-cancellation.js';
/**
 * Runner-backed Anthropic adapter. Mirror of src/Adapters/ClaudeBackendAdapter.php.
 *
 * The wire contract with the runner is unchanged:
 *   POST <runner_url>/exec
 *   X-Runner-Auth: <shared secret>
 *   Content-Type: application/json
 *   body: {
 *     auth_json: <canonical auth snapshot>,
 *     prompt: <flattened transcript>,
 *     images: [{url, detail?}, ...],
 *     model: <claude-…>,
 *     engine: 'claude',
 *     timeout_seconds: <seconds>,
 *     max_tokens?, temperature?, top_p?, top_k?, stop_sequences?, system?
 *   }
 *
 * The runner returns either `{status:'ok', output:'…', input_tokens, …}` or
 * `{status:'fail', error:'…'}`. Failures bubble up as 502 ApiError; the
 * envelope plugin then renders them in the Anthropic shape.
 *
 * Streaming is implemented in the route handler — the PHP version synthesises
 * SSE events from the completed response (no token-by-token stream); we do
 * the same to stay drop-in compatible.
 */
import { ApiError } from '../../http/errors.js';
import type { Env } from '../../env.js';
import { ENGINE_CLAUDE, ENGINE_GROK, ENGINE_KIMI, ENGINE_LABELS, type Engine } from '../../util/engine.js';
import {
  assertControlsSupported,
  capabilitiesFor,
  stopReasonFor,
} from '../transport-capabilities.js';
import { nativeTokenCount, runnerExecUrl } from './runner-openai.js';

export interface ClaudeMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ClaudeContentBlock[];
}

export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source:
        | { type: 'base64'; media_type: string; data: string }
        | { type: 'url'; url: string };
    };

export interface ClaudeRequestParams {
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  system?: string;
}

export interface ClaudeUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  reasoning_tokens?: number | null;
  usage_known?: boolean;
}

export interface ClaudeMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{ type: 'text'; text: string }>;
  model: string;
  /**
   * Null when the CLI reported no stop reason.
   */
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | string | null;
  stop_sequence: string | null;
  usage: ClaudeUsage;
}

export interface RunnerClaudeAdapter {
  messages(
    messages: ClaudeMessage[],
    model: string,
    params: ClaudeRequestParams,
    signal?: AbortSignal,
  ): Promise<ClaudeMessageResponse>;
}

export interface RunnerClaudeAdapterDeps {
  env: Env;
  /**
   * Backend engine that executes the Anthropic-shaped request; Claude unless
   * the `/anthropic/v1` surface is routed elsewhere (see `api-surfaces.ts`).
   */
  engine?: Engine;
  /**
   * Provider of the current canonical Claude auth snapshot (auth.json
   * contents). Returns null when no credentials are available — the call
   * fails with a 503-class error in that case.
   */
  getAuthSnapshot?: () => Promise<unknown | null>;
  /**
   * Invoked once per successful runner exec — a real completion with the
   * canonical credential — with the exact snapshot used for that execution,
   * so overlapping requests can count as verification of their own generation.
   */
  onExecSuccess?: (authSnapshot: unknown) => void;
  /** Override fetch for tests. */
  fetcher?: typeof fetch;
}

export function createRunnerClaudeAdapter(deps: RunnerClaudeAdapterDeps): RunnerClaudeAdapter | null {
  const engine = deps.engine ?? ENGINE_CLAUDE;
  /** One transport, one engine: the runner's CLI shell-out for the backend. */
  const capabilities = capabilitiesFor('runner-cli', engine);
  const url = deps.env.AUTH_RUNNER_URL?.trim();
  const secret = deps.env.AUTH_RUNNER_SHARED_SECRET?.trim();
  if (!url) return null;
  // Any AUTH_RUNNER_URL form — the bare base, the `/verify` endpoint it usually
  // points at, or `/exec` itself — normalises onto the runner's one POST route.
  const execUrl = runnerExecUrl(url) as `${string}/exec`;
  const timeoutSeconds = deps.env.AUTH_RUNNER_EXEC_TIMEOUT ?? 600;
  const fetcher = deps.fetcher ?? fetch;
  const getAuth = deps.getAuthSnapshot ?? (async () => null);

  return {
    async messages(messages, model, params, signal) {
      signal?.throwIfAborted();
      // Codex has nowhere to put a system instruction: fold it into the
      // transcript as a leading `system:` line, exactly how a system turn
      // reaches Codex through `/v1`. Grok cannot accept `max_tokens`, which
      // the Anthropic wire requires on every request — it stays the
      // accepted-unenforceable control it is everywhere else and is not sent.
      let system = params.system;
      const transcript =
        system !== undefined && system !== null && system !== '' && capabilities.controls.system === 'unsupported'
          ? [{ role: 'system' as const, content: system }, ...messages]
          : messages;
      if (transcript !== messages) system = undefined;
      const maxTokens = capabilities.controls.max_tokens === 'unsupported' ? undefined : params.max_tokens;
      const { prompt, images } = buildPromptPayload(transcript);

      assertRunnerPrompt(engine, prompt, system);
      if ((engine === ENGINE_GROK || engine === ENGINE_KIMI) && images.length > 0) {
        throw new ApiError(`Image inputs are not supported by the ${ENGINE_LABELS[engine]} CLI transport`, {
          status: 400, code: 'unsupported_generation_control', type: 'invalid_request_error', param: 'images',
        });
      }

      // Refuse before dispatch: the CLIs have no flags for the sampling
      // controls, so forwarding them silently dropped the caller's
      // instructions. `max_tokens` and `system` are the two this transport can
      // legitimately carry — see `transport-capabilities.ts` for why
      // `max_tokens` is accepted but never claimed as enforced.
      assertControlsSupported(
        {
          max_tokens: maxTokens,
          temperature: params.temperature,
          top_p: params.top_p,
          top_k: params.top_k,
          stop_sequences: params.stop_sequences,
          system,
        },
        capabilities,
      );

      const auth = await getAuth();
      signal?.throwIfAborted();
      if (auth === null || auth === undefined) {
        throw new ApiError(
          `No auth credentials available. Upload ${ENGINE_LABELS[engine]} auth first.`,
          { status: 503, code: 'backend_unavailable', type: 'api_error' },
        );
      }

      const payload: Record<string, unknown> = {
        auth_json: auth,
        prompt,
        images,
        model,
        engine,
        timeout_seconds: timeoutSeconds,
      };
      if (maxTokens !== undefined && maxTokens !== null) payload.max_tokens = maxTokens;
      if (system !== undefined && system !== null) payload.system = system;

      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (secret) headers['x-runner-auth'] = secret;

      return withRunnerCancellation(Math.max(1, timeoutSeconds + 5) * 1000, signal, async (activeSignal) => {
        let res: Response;
        try {
          res = await fetcher(execUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: activeSignal,
          });
        } catch (err) {
          activeSignal.throwIfAborted();
          const msg = err instanceof Error ? err.message : String(err);
          throw new ApiError(`Runner request failed: ${msg}`, {
            status: 502,
            code: 'runner_unavailable',
            type: 'api_error',
          });
        }
        activeSignal.throwIfAborted();

        let data: unknown;
        try {
          data = await res.json();
        } catch {
          activeSignal.throwIfAborted();
          throw new ApiError('Invalid runner response (not JSON)', {
            status: 502,
            code: 'runner_bad_response',
            type: 'api_error',
          });
        }
        if (!data || typeof data !== 'object') {
          throw new ApiError('Invalid runner response shape', {
            status: 502,
            code: 'runner_bad_response',
            type: 'api_error',
          });
        }

        const obj = data as Record<string, unknown>;
        if (obj.status !== 'ok') {
          const error =
            stringOrUndefined(obj.error) ??
            stringOrUndefined(obj.reason) ??
            stringOrUndefined(obj.detail) ??
            'Runner execution failed';
          throw new ApiError(error, {
            status: 502,
            code: 'runner_failed',
            type: 'api_error',
          });
        }

        activeSignal.throwIfAborted();
        deps.onExecSuccess?.(auth);

        const output = typeof obj.output === 'string' ? obj.output : '';
        const usage = extractUsage(obj, engine);

        return {
          id: 'msg_' + randomHex16(),
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: output }],
          model,
          stop_reason: stopReasonFor(capabilities, engine === ENGINE_KIMI ? null : anthropicStopReason(obj)),
          stop_sequence: null,
          usage,
        };
      });
    },
  };
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function extractUsage(obj: Record<string, unknown>, engine: Engine): ClaudeUsage {
  const usage = {
    input_tokens: nativeTokenCount(obj.input_tokens),
    output_tokens: nativeTokenCount(obj.output_tokens),
    cache_creation_input_tokens: nativeTokenCount(obj.cache_creation_input_tokens),
    cache_read_input_tokens: nativeTokenCount(obj.cache_read_input_tokens),
    reasoning_tokens: nativeTokenCount(obj.reasoning_tokens),
    ...(obj.usage_known === false ? { usage_known: false } : {}),
  };
  if (engine === ENGINE_GROK && obj.usage_known === true) {
    const { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write } = usage;
    if (input !== null && read !== null && write !== null && read + write <= input && usage.output_tokens !== null) {
      return { ...usage, input_tokens: input - read - write };
    }
  }
  if (engine === ENGINE_GROK || engine === ENGINE_KIMI) {
    return { input_tokens: null, output_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, usage_known: false };
  }
  return usage;
}

/** OpenAI finish reasons a runner may report, in Anthropic's vocabulary. */
const ANTHROPIC_STOP_REASONS: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  content_filter: 'refusal',
};

function anthropicStopReason(obj: Record<string, unknown>): string | undefined {
  const native = stringOrUndefined(obj.stop_reason) ?? stringOrUndefined(obj.native_stop_reason);
  if (native) return native;
  const finish = stringOrUndefined(obj.finish_reason);
  return finish ? ANTHROPIC_STOP_REASONS[finish] ?? finish : undefined;
}

function randomHex16(): string {
  // 16 bytes -> 32 hex chars. Done with Web Crypto for portability.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Flattens an Anthropic-shaped message list into the runner's prompt string +
 * image list. Mirrors PHP ClaudeBackendAdapter::buildPromptPayload.
 */
export function buildPromptPayload(messages: ClaudeMessage[]): {
  prompt: string;
  images: Array<{ url: string; detail?: string }>;
} {
  const lines: string[] = [];
  const images: Array<{ url: string; detail?: string }> = [];
  let imageNumber = 1;

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = typeof message.role === 'string' && message.role.trim() ? message.role.trim() : 'user';
    const content = renderContent(message.content, images, () => imageNumber++);
    if (!content) continue;
    lines.push(`${role}: ${content}`);
  }

  return { prompt: lines.join('\n'), images };
}

function renderContent(
  content: string | ClaudeContentBlock[] | undefined,
  images: Array<{ url: string; detail?: string }>,
  nextImageNumber: () => number,
): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      const v = (part as string).trim();
      if (v) parts.push(v);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') {
      const t = typeof part.text === 'string' ? part.text.trim() : '';
      if (t) parts.push(t);
      continue;
    }
    if (part.type === 'image') {
      const src = part.source;
      if (!src) continue;
      let url: string | null = null;
      if (src.type === 'base64' && src.data) {
        const mediaType = src.media_type || 'image/png';
        url = `data:${mediaType};base64,${src.data}`;
      } else if (src.type === 'url' && src.url) {
        url = src.url;
      }
      if (!url) continue;
      images.push({ url });
      const n = nextImageNumber();
      parts.push(`[Image ${n} attached]`);
    }
  }
  return parts.join('\n');
}
