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
import { ENGINE_CLAUDE } from '../../util/engine.js';
import {
  assertControlsSupported,
  capabilitiesFor,
  stopReasonFor,
} from '../transport-capabilities.js';

/** One transport, one engine: the runner's CLI shell-out for Claude. */
const CAPABILITIES = capabilitiesFor('runner-cli', ENGINE_CLAUDE);
import { runnerExecUrl } from './runner-openai.js';

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
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface ClaudeMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{ type: 'text'; text: string }>;
  model: string;
  /**
   * `null` when the backend reported no reason. The CLI transport never does,
   * and `'end_turn'` asserted a clean completion for output that may have been
   * cut short by a timeout — including on the `max_tokens` this transport
   * cannot enforce.
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
  ): Promise<ClaudeMessageResponse>;
}

export interface RunnerClaudeAdapterDeps {
  env: Env;
  /**
   * Provider of the current canonical Claude auth snapshot (auth.json
   * contents). Returns null when no credentials are available — the call
   * fails with a 503-class error in that case.
   */
  getAuthSnapshot?: () => Promise<unknown | null>;
  /**
   * Invoked once per successful runner exec — a real completion with the
   * canonical credential — so traffic can count as auth verification.
   */
  onExecSuccess?: () => void;
  /** Override fetch for tests. */
  fetcher?: typeof fetch;
}

export function createRunnerClaudeAdapter(deps: RunnerClaudeAdapterDeps): RunnerClaudeAdapter | null {
  const url = deps.env.AUTH_RUNNER_URL?.trim();
  const secret = deps.env.AUTH_RUNNER_SHARED_SECRET?.trim();
  if (!url) return null;
  // Any AUTH_RUNNER_URL form — the bare base, the `/verify` endpoint it usually
  // points at, or `/exec` itself — normalises onto the runner's one POST route.
  const execUrl = runnerExecUrl(url) as `${string}/exec`;
  const timeoutSeconds = deps.env.AUTH_RUNNER_TIMEOUT ?? 30;
  const fetcher = deps.fetcher ?? fetch;
  const getAuth = deps.getAuthSnapshot ?? (async () => null);

  return {
    async messages(messages, model, params) {
      const { prompt, images } = buildPromptPayload(messages);

      const auth = await getAuth();
      if (auth === null || auth === undefined) {
        throw new ApiError(
          'No auth credentials available. Upload Claude auth first.',
          { status: 503, code: 'backend_unavailable', type: 'api_error' },
        );
      }

      // Refuse before dispatch: the Claude CLI has no flags for the sampling
      // controls, so forwarding them silently dropped the caller's
      // instructions. `max_tokens` and `system` are the two this transport can
      // legitimately carry — see `transport-capabilities.ts` for why
      // `max_tokens` is accepted but never claimed as enforced.
      assertControlsSupported(
        {
          max_tokens: params.max_tokens,
          temperature: params.temperature,
          top_p: params.top_p,
          top_k: params.top_k,
          stop_sequences: params.stop_sequences,
          system: params.system,
        },
        CAPABILITIES,
      );

      const payload: Record<string, unknown> = {
        auth_json: auth,
        prompt,
        images,
        model,
        engine: ENGINE_CLAUDE,
        timeout_seconds: timeoutSeconds,
      };
      for (const k of ['max_tokens', 'system'] as const) {
        const v = params[k];
        if (v !== undefined && v !== null) payload[k] = v;
      }

      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (secret) headers['x-runner-auth'] = secret;

      const controller = new AbortController();
      const timeoutMs = Math.max(1, timeoutSeconds + 5) * 1000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let res: Response;
      try {
        res = await fetcher(execUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const msg = err instanceof Error ? err.message : String(err);
        throw new ApiError(`Runner request failed: ${msg}`, {
          status: 502,
          code: 'runner_unavailable',
          type: 'api_error',
        });
      }
      clearTimeout(timer);

      let data: unknown;
      try {
        data = await res.json();
      } catch {
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

      deps.onExecSuccess?.();

      const output = typeof obj.output === 'string' ? obj.output : '';
      const usage = extractUsage(obj);

      return {
        id: 'msg_' + randomHex16(),
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: output }],
        model,
        stop_reason: stopReasonFor(CAPABILITIES, stringOrUndefined(obj.stop_reason)),
        stop_sequence: null,
        usage,
      };
    },
  };
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function extractUsage(obj: Record<string, unknown>): ClaudeUsage {
  const num = (k: string): number => {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return 0;
  };
  return {
    input_tokens: num('input_tokens'),
    output_tokens: num('output_tokens'),
    cache_creation_input_tokens: num('cache_creation_input_tokens'),
    cache_read_input_tokens: num('cache_read_input_tokens'),
  };
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
