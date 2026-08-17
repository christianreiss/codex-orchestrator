import { randomBytes } from 'node:crypto';
import { ApiError } from '../../http/errors.js';
import {
  assertControlsSupported,
  capabilitiesFor,
  stopReasonFor,
} from '../transport-capabilities.js';
import { ENGINE_CODEX } from '../../util/engine.js';
import type { Env } from '../../env.js';

/**
 * Talks to the codex runner over HTTP using the same shared-secret header the
 * legacy PHP `RunnerBackendAdapter` used (`X-Runner-Auth`). The runner exposes
 * a `/exec` endpoint that takes a flat prompt + optional images and returns a
 * `{ status: 'ok', output, input_tokens, output_tokens }` payload. We translate
 * OpenAI-shape requests into the runner's contract here and serialize the
 * result back into the OpenAI-shape response body so the route doesn't have to
 * know about the runner's wire format.
 *
 * When the env vars are unset the constructor throws — callers must check
 * `isConfigured(env)` first and surface a `backend_unavailable` 503 to clients.
 */

export interface OpenAiMessageImage {
  url: string;
  detail?: string;
}

export interface OpenAiMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
}

export interface OpenAiGenerationParams {
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  /** OpenAI `stop` — accepted as string or array; mapped to runner `stop_sequences`. */
  stop?: string | string[];
  system?: string;
}

export interface ChatCompletionResult {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    /**
     * `null` when the backend reported no reason. The CLI transport never
     * does, and asserting `'stop'` claimed the model finished its turn for
     * output that may have been cut short by a timeout or a crash.
     */
    finish_reason: string | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface CompletionResult {
  id: string;
  object: 'text_completion';
  created: number;
  model: string;
  choices: Array<{
    text: string;
    index: number;
    logprobs: null;
    /**
     * `null` when the backend reported no reason. The CLI transport never
     * does, and asserting `'stop'` claimed the model finished its turn for
     * output that may have been cut short by a timeout or a crash.
     */
    finish_reason: string | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ResponsesResult {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed';
  model: string;
  // Nullable-default fields the upstream `response` object always carries.
  // Required-without-default fields (`tools`, `tool_choice`, `text`) below
  // otherwise AttributeError under openai-python's typed Response object.
  error: null;
  incomplete_details: null;
  instructions: string | null;
  metadata: Record<string, never>;
  tools: never[];
  tool_choice: 'auto';
  text: { format: { type: 'text' } };
  output: Array<{
    id: string;
    type: 'message';
    status: 'completed';
    role: 'assistant';
    content: Array<{
      type: 'output_text';
      text: string;
      annotations: never[];
      logprobs: never[];
    }>;
  }>;
  parallel_tool_calls: false;
  usage: {
    input_tokens: number;
    input_tokens_details: { cached_tokens: 0 };
    output_tokens: number;
    output_tokens_details: { reasoning_tokens: 0 };
    total_tokens: number;
  };
}

export interface RunnerOpenAiConfig {
  execUrl: string;
  sharedSecret: string;
  timeoutSeconds: number;
  /**
   * Optional auth-snapshot provider. When set, the adapter attaches the latest
   * canonical auth.json to every request just like the PHP adapter did. In the
   * Node rewrite the host-auth worktree owns the snapshot service; the OpenAI
   * worktree consumes it through this hook to avoid a hard import cycle.
   */
  authSnapshot?: () => Promise<unknown | null>;
  /**
   * Invoked once per successful runner exec — a real completion with the
   * canonical credential — so traffic can count as auth verification.
   */
  onExecSuccess?: () => void;
}

export function makeRunnerConfig(env: Env): RunnerOpenAiConfig | null {
  const url = env.AUTH_RUNNER_URL ?? env.AUTH_RUNNER_CODEX_BASE_URL;
  if (!url || !env.AUTH_RUNNER_SHARED_SECRET) return null;
  const execUrl = runnerExecUrl(url);
  return {
    execUrl,
    sharedSecret: env.AUTH_RUNNER_SHARED_SECRET,
    timeoutSeconds: env.AUTH_RUNNER_TIMEOUT ?? 30,
  };
}

export function runnerExecUrl(url: string): string {
  const trimmed = url.replace(/\/$/, '');
  if (trimmed.endsWith('/exec')) return trimmed;
  if (trimmed.endsWith('/verify')) return trimmed.replace(/\/verify$/, '/exec');
  return `${trimmed}/exec`;
}

/** One transport, one engine: the runner's CLI shell-out for Codex. */
const CAPABILITIES = capabilitiesFor('runner-cli', ENGINE_CODEX);

export class RunnerOpenAiAdapter {
  constructor(private readonly config: RunnerOpenAiConfig) {}

  async chatCompletions(
    messages: OpenAiMessage[],
    model: string,
    params: OpenAiGenerationParams = {},
  ): Promise<ChatCompletionResult> {
    const { prompt, images } = buildPromptPayload(messages);
    const result = await this.runPrompt(prompt, model, images, params);
    const usage = extractUsage(result);
    return {
      id: `chatcmpl-${randomBytes(12).toString('hex')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: stringOrEmpty(result.output) },
          finish_reason: stopReasonFor(CAPABILITIES, result.finish_reason),
        },
      ],
      usage,
    };
  }

  async responses(
    messages: OpenAiMessage[],
    model: string,
    params: OpenAiGenerationParams = {},
  ): Promise<ResponsesResult> {
    const completion = await this.chatCompletions(messages, model, params);
    return responseFromChatCompletion(completion);
  }

  async completions(
    prompt: string,
    model: string,
    params: OpenAiGenerationParams = {},
  ): Promise<CompletionResult> {
    const result = await this.runPrompt(prompt, model, [], params);
    const usage = extractUsage(result);
    return {
      id: `cmpl-${randomBytes(12).toString('hex')}`,
      object: 'text_completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          text: stringOrEmpty(result.output),
          index: 0,
          logprobs: null,
          finish_reason: stopReasonFor(CAPABILITIES, result.finish_reason),
        },
      ],
      usage,
    };
  }

  private async runPrompt(
    prompt: string,
    model: string,
    images: OpenAiMessageImage[],
    params: OpenAiGenerationParams,
  ): Promise<RunnerResponse> {
    if (prompt.trim() === '') {
      return { status: 'ok', output: '', input_tokens: 0, output_tokens: 0 };
    }

    const authPayload = this.config.authSnapshot ? await this.config.authSnapshot() : null;
    if (this.config.authSnapshot && authPayload === null) {
      throw new ApiError(
        'No auth credentials available. Upload auth.json first.',
        { status: 502, code: 'no_auth_snapshot', type: 'api_error' },
      );
    }

    // Refuse before dispatch. `codex exec` has no flags for the sampling
    // controls, so forwarding them produced a request whose instructions were
    // silently dropped — a caller asking for `temperature: 0` got a sampled
    // answer and no way to know.
    assertControlsSupported(
      {
        max_tokens: params.max_tokens,
        temperature: params.temperature,
        top_p: params.top_p,
        system: params.system,
        stop_sequences: params.stop,
      },
      CAPABILITIES,
    );

    const body: Record<string, unknown> = {
      auth_json: authPayload,
      prompt,
      images,
      model,
      engine: 'codex',
      timeout_seconds: this.config.timeoutSeconds,
    };
    // `max_tokens` is `accepted-unenforceable`: it is forwarded because callers
    // and the protocol expect to be able to send it, and nothing downstream
    // reports a `max_tokens` finish reason on this transport as a result.
    if (params.max_tokens !== undefined) body.max_tokens = params.max_tokens;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.sharedSecret.trim()) {
      headers['x-runner-auth'] = this.config.sharedSecret.trim();
    }

    let res: Response;
    const controller = new AbortController();
    const timeoutMs = (this.config.timeoutSeconds + 5) * 1000;
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetch(this.config.execUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Runner request failed';
      throw new ApiError(message, { status: 502, code: 'runner_unreachable', type: 'api_error' });
    } finally {
      clearTimeout(timeoutHandle);
    }

    let decoded: unknown;
    try {
      decoded = await res.json();
    } catch {
      throw new ApiError('Invalid runner response', {
        status: 502,
        code: 'runner_bad_response',
        type: 'api_error',
      });
    }
    if (!decoded || typeof decoded !== 'object') {
      throw new ApiError('Invalid runner response', {
        status: 502,
        code: 'runner_bad_response',
        type: 'api_error',
      });
    }
    const obj = decoded as RunnerResponse & { error?: unknown; reason?: unknown; detail?: unknown };
    if (obj.status === 'ok') {
      this.config.onExecSuccess?.();
      return obj;
    }
    const errorMsg =
      typeof obj.error === 'string'
        ? obj.error
        : typeof obj.reason === 'string'
          ? obj.reason
          : typeof obj.detail === 'string'
            ? obj.detail
            : 'Runner execution failed';
    throw new ApiError(errorMsg, { status: 502, code: 'runner_failed', type: 'api_error' });
  }
}

interface RunnerResponse {
  status?: string;
  output?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  /**
   * The runner's `/exec` does not report one today, so this is always absent
   * and `stopReasonFor` answers `null`. It is declared so a transport that
   * *does* report one needs no change here.
   */
  finish_reason?: string | null;
}

function extractUsage(result: RunnerResponse): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const prompt = numberOrZero(result.input_tokens);
  const completion = numberOrZero(result.output_tokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

function numberOrZero(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function stringOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function buildPromptPayload(messages: OpenAiMessage[]): {
  prompt: string;
  images: OpenAiMessageImage[];
} {
  const lines: string[] = [];
  const images: OpenAiMessageImage[] = [];
  let imageNumber = 1;
  for (const message of messages) {
    const role = typeof message.role === 'string' && message.role.trim() !== ''
      ? message.role.trim()
      : 'user';
    const content = renderMessageContent(message.content, images, () => imageNumber++);
    if (content === '') continue;
    lines.push(`${role}: ${content}`);
  }
  return { prompt: lines.join('\n'), images };
}

function renderMessageContent(
  content: unknown,
  images: OpenAiMessageImage[],
  nextImageNumber: () => number,
): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const rawPart of content) {
    if (typeof rawPart === 'string') {
      const value = rawPart.trim();
      if (value !== '') parts.push(value);
      continue;
    }
    if (!rawPart || typeof rawPart !== 'object') continue;
    const part = rawPart as Record<string, unknown>;
    const type = typeof part.type === 'string' ? part.type.toLowerCase() : '';
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = part.text;
      if (typeof text === 'string' && text.trim() !== '') parts.push(text.trim());
      continue;
    }
    if (type === 'image_url' || type === 'input_image') {
      const imageUrl = part.image_url;
      let url: unknown = null;
      let detail: unknown = part.detail;
      if (imageUrl && typeof imageUrl === 'object') {
        const obj = imageUrl as Record<string, unknown>;
        url = obj.url;
        detail = obj.detail ?? detail;
      } else {
        url = imageUrl;
      }
      if (typeof url !== 'string' || url.trim() === '') continue;
      const image: OpenAiMessageImage = { url: url.trim() };
      if (typeof detail === 'string' && detail.trim() !== '') image.detail = detail.trim();
      images.push(image);
      parts.push(`[Image ${nextImageNumber()} attached]`);
    }
  }
  return parts.join('\n');
}

export function responseFromChatCompletion(
  completion: ChatCompletionResult,
): ResponsesResult {
  const responseId = deriveId(completion.id, 'resp_');
  const messageId = deriveId(completion.id, 'msg_');
  const content = completion.choices[0]?.message.content ?? '';
  const usage = completion.usage;
  return {
    id: responseId,
    object: 'response',
    created_at: completion.created,
    status: 'completed',
    model: completion.model,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    tools: [],
    tool_choice: 'auto',
    text: { format: { type: 'text' } },
    output: [
      {
        id: messageId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: content,
            annotations: [],
            logprobs: [],
          },
        ],
      },
    ],
    parallel_tool_calls: false,
    usage: {
      input_tokens: usage.prompt_tokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: usage.completion_tokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: usage.total_tokens,
    },
  };
}

function deriveId(sourceId: string, prefix: string): string {
  if (sourceId) {
    const suffix = sourceId.replace(/^[^-_]+[-_]/, '');
    if (suffix) return `${prefix}${suffix}`;
  }
  return `${prefix}${randomBytes(12).toString('hex')}`;
}

/**
 * Normalize OpenAI chat-style messages into the canonical
 * `{ role, content }[]` shape. Returns null if no usable message survives.
 */
export function normalizeChatMessages(raw: unknown): OpenAiMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: OpenAiMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const role = normalizeRole(obj.role);
    const content = normalizeMessageContent(obj.content);
    if (content === null) continue;
    out.push({ role, content });
  }
  return out.length > 0 ? out : null;
}

/**
 * Normalize the `/v1/responses` `input` shape (string | object | array) and
 * the optional `instructions` system prompt into a chat-style message list.
 */
export function normalizeResponsesInput(
  rawInput: unknown,
  rawInstructions: unknown,
): OpenAiMessage[] | null {
  const messages: OpenAiMessage[] = [];
  if (typeof rawInstructions === 'string' && rawInstructions.trim() !== '') {
    messages.push({ role: 'system', content: rawInstructions.trim() });
  }
  if (typeof rawInput === 'string') {
    const content = rawInput.trim();
    if (content === '') return null;
    messages.push({ role: 'user', content });
    return messages;
  }
  if (!Array.isArray(rawInput)) return null;

  const inputMessages: OpenAiMessage[] = [];
  for (const entry of rawInput) {
    if (typeof entry === 'string') {
      const content = entry.trim();
      if (content === '') continue;
      inputMessages.push({ role: 'user', content });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const role = normalizeRole(obj.role);
    const content = normalizeMessageContent(obj.content);
    if (obj.type === 'message' && content !== null) {
      inputMessages.push({ role, content });
      continue;
    }
    if (content !== null && obj.role !== undefined) {
      inputMessages.push({ role, content });
    }
  }

  if (inputMessages.length === 0) {
    const content = normalizeMessageContent(rawInput);
    if (content !== null) inputMessages.push({ role: 'user', content });
  }

  const combined = [...messages, ...inputMessages];
  return combined.length > 0 ? combined : null;
}

function normalizeRole(role: unknown): string {
  const candidate = typeof role === 'string' ? role.toLowerCase().trim() : 'user';
  return ['system', 'developer', 'assistant'].includes(candidate) ? candidate : 'user';
}

function normalizeMessageContent(
  content: unknown,
): string | Array<Record<string, unknown>> | null {
  if (typeof content === 'string') {
    const value = content.trim();
    return value !== '' ? value : null;
  }
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object' && looksLikeSinglePart(content as Record<string, unknown>)) {
      return normalizeMessageContent([content]);
    }
    return null;
  }
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (typeof part === 'string') {
      const value = part.trim();
      if (value !== '') parts.push({ type: 'text', text: value });
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const normalized = normalizeContentPart(part as Record<string, unknown>);
    if (normalized !== null) parts.push(normalized);
  }
  if (parts.length === 0) return null;
  const only = parts[0];
  if (parts.length === 1 && only && only.type === 'text' && typeof only.text === 'string') {
    return only.text;
  }
  return parts;
}

function looksLikeSinglePart(content: Record<string, unknown>): boolean {
  return 'type' in content || 'text' in content || 'image_url' in content;
}

function normalizeContentPart(part: Record<string, unknown>): Record<string, unknown> | null {
  const type = typeof part.type === 'string' ? part.type.toLowerCase() : '';
  if (type === 'text' || type === 'input_text' || type === 'output_text') {
    const text = part.text;
    if (typeof text !== 'string') return null;
    const value = text.trim();
    if (value === '') return null;
    return { type: 'text', text: value };
  }
  if (type === 'image_url' || type === 'input_image') {
    const imageUrl = part.image_url;
    let url: unknown = null;
    let detail: unknown = part.detail;
    if (imageUrl && typeof imageUrl === 'object') {
      const obj = imageUrl as Record<string, unknown>;
      url = obj.url;
      detail = obj.detail ?? detail;
    } else {
      url = imageUrl;
    }
    if (typeof url !== 'string' || url.trim() === '') return null;
    const normalized: Record<string, unknown> = {
      type: 'image_url',
      image_url: { url: url.trim() } as Record<string, unknown>,
    };
    if (typeof detail === 'string' && detail.trim() !== '') {
      (normalized.image_url as Record<string, unknown>).detail = detail.trim();
    }
    return normalized;
  }
  return null;
}
