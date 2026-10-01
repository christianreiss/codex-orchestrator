import { randomBytes } from 'node:crypto';
import { ApiError } from '../../http/errors.js';
import {
  assertControlsSupported,
  capabilitiesFor,
  stopReasonFor,
} from '../transport-capabilities.js';
import { ENGINE_CODEX, ENGINE_GROK, type Engine } from '../../util/engine.js';
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
    prompt_tokens_details?: { cached_tokens: number };
    completion_tokens_details?: { reasoning_tokens: number };
  } | null;
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
  } | null;
}

export interface ResponsesResult {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed' | 'incomplete';
  model: string;
  // Nullable-default fields the upstream `response` object always carries.
  // Required-without-default fields (`tools`, `tool_choice`, `text`) below
  // otherwise AttributeError under openai-python's typed Response object.
  error: null;
  incomplete_details: { reason: 'max_output_tokens' | 'content_filter' } | null;
  instructions: string | null;
  metadata: Record<string, never>;
  tools: never[];
  tool_choice: 'auto';
  text: { format: { type: 'text' } };
  output: Array<{
    id: string;
    type: 'message';
    status: 'completed' | 'incomplete';
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
    input_tokens_details: { cached_tokens: number } | null;
    output_tokens: number;
    output_tokens_details: { reasoning_tokens: number } | null;
    total_tokens: number;
  } | null;
}

export interface RunnerOpenAiConfig {
  engine?: Engine;
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
   * canonical credential — with the exact snapshot used for that execution,
   * so overlapping requests can count as verification of their own generation.
   */
  onExecSuccess?: (authSnapshot: unknown) => void;
}

export function makeRunnerConfig(env: Env, engine: Engine = ENGINE_CODEX): RunnerOpenAiConfig | null {
  const url = env.AUTH_RUNNER_URL ?? (engine === ENGINE_CODEX ? env.AUTH_RUNNER_CODEX_BASE_URL : undefined);
  if (!url || !env.AUTH_RUNNER_SHARED_SECRET) return null;
  const execUrl = runnerExecUrl(url);
  return {
    execUrl,
    engine,
    sharedSecret: env.AUTH_RUNNER_SHARED_SECRET,
    timeoutSeconds: env.AUTH_RUNNER_EXEC_TIMEOUT ?? 600,
  };
}

export function runnerExecUrl(url: string): string {
  const trimmed = url.replace(/\/$/, '');
  if (trimmed.endsWith('/exec')) return trimmed;
  if (/\/verify(?:-grok|-claude)?$/.test(trimmed)) return trimmed.replace(/\/verify(?:-grok|-claude)?$/, '/exec');
  return `${trimmed}/exec`;
}

export class RunnerOpenAiAdapter {
  private readonly capabilities;
  constructor(private readonly config: RunnerOpenAiConfig) {
    this.capabilities = capabilitiesFor('runner-cli', config.engine ?? ENGINE_CODEX);
  }

  async chatCompletions(
    messages: OpenAiMessage[],
    model: string,
    params: OpenAiGenerationParams = {},
  ): Promise<ChatCompletionResult> {
    const grok = this.config.engine === ENGINE_GROK;
    const systemMessages = grok ? messages.filter(message => ['system', 'developer'].includes(message.role)) : [];
    const systemImages: OpenAiMessageImage[] = [];
    const system = systemMessages.map(message => renderMessageContent(message.content, systemImages, () => systemImages.length + 1)).filter(Boolean).join('\n');
    const { prompt, images } = buildPromptPayload(grok ? messages.filter(message => !systemMessages.includes(message)) : messages);
    images.push(...systemImages);
    if (system) params = { ...params, system: [params.system, system].filter(Boolean).join('\n') };
    const result = await this.runPrompt(prompt, model, images, params);
    const usage = extractUsage(result, this.config.engine === ENGINE_GROK);
    return {
      id: `chatcmpl-${randomBytes(12).toString('hex')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: stringOrEmpty(result.output) },
          finish_reason: stopReasonFor(this.capabilities, result.finish_reason),
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
    return responseFromChatCompletion(completion, this.config.engine === ENGINE_GROK);
  }

  async completions(
    prompt: string,
    model: string,
    params: OpenAiGenerationParams = {},
  ): Promise<CompletionResult> {
    const result = await this.runPrompt(prompt, model, [], params);
    const usage = extractUsage(result, this.config.engine === ENGINE_GROK);
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
          finish_reason: stopReasonFor(this.capabilities, result.finish_reason),
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
    if (this.config.engine === ENGINE_GROK && images.length > 0) {
      throw new ApiError('Image inputs are not supported by the Grok CLI transport', {
        status: 400, code: 'unsupported_generation_control', type: 'invalid_request_error', param: 'images',
      });
    }
    if (prompt.trim() === '') {
      return { status: 'ok', output: '', input_tokens: 0, output_tokens: 0 };
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
      this.capabilities,
    );

    const authPayload = this.config.authSnapshot ? await this.config.authSnapshot() : null;
    if (this.config.authSnapshot && authPayload === null) {
      throw new ApiError(
        'No auth credentials available. Upload auth.json first.',
        { status: 502, code: 'no_auth_snapshot', type: 'api_error' },
      );
    }

    const body: Record<string, unknown> = {
      auth_json: authPayload,
      prompt,
      images,
      model,
      engine: this.config.engine ?? ENGINE_CODEX,
      timeout_seconds: this.config.timeoutSeconds,
    };
    // `max_tokens` is `accepted-unenforceable`: it is forwarded because callers
    // and the protocol expect to be able to send it, and nothing downstream
    // reports a `max_tokens` finish reason on this transport as a result.
    if (params.max_tokens !== undefined) body.max_tokens = params.max_tokens;
    if (params.system !== undefined) body.system = params.system;

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
      this.config.onExecSuccess?.(authPayload);
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
  usage_known?: boolean;
  output?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  reasoning_tokens?: unknown;
  /**
   * The runner's `/exec` does not report one today, so this is always absent
   * and `stopReasonFor` answers `null`. It is declared so a transport that
   * *does* report one needs no change here.
   */
  finish_reason?: string | null;
}

function extractUsage(result: RunnerResponse, requireExact = false): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens: number };
} | null {
  if (requireExact && (result.usage_known !== true || ![result.input_tokens, result.output_tokens].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0))) return null;
  const prompt = numberOrZero(result.input_tokens);
  const completion = numberOrZero(result.output_tokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(requireExact ? {
      ...(typeof result.cache_read_input_tokens === 'number' ? { prompt_tokens_details: { cached_tokens: result.cache_read_input_tokens } } : {}),
      ...(typeof result.reasoning_tokens === 'number' ? { completion_tokens_details: { reasoning_tokens: result.reasoning_tokens } } : {}),
    } : {}),
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
  nativeGrok = false,
): ResponsesResult {
  const responseId = deriveId(completion.id, 'resp_');
  const messageId = deriveId(completion.id, 'msg_');
  const content = completion.choices[0]?.message.content ?? '';
  const usage = completion.usage;
  const reason = completion.choices[0]?.finish_reason;
  const incomplete = nativeGrok && (reason === 'length' || reason === 'content_filter');
  return {
    id: responseId,
    object: 'response',
    created_at: completion.created,
    status: incomplete ? 'incomplete' : 'completed',
    model: completion.model,
    error: null,
    incomplete_details: incomplete ? { reason: reason === 'length' ? 'max_output_tokens' : 'content_filter' } : null,
    instructions: null,
    metadata: {},
    tools: [],
    tool_choice: 'auto',
    text: { format: { type: 'text' } },
    output: [
      {
        id: messageId,
        type: 'message',
        status: incomplete ? 'incomplete' : 'completed',
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
    usage: usage ? {
      input_tokens: usage.prompt_tokens,
      input_tokens_details: nativeGrok ? usage.prompt_tokens_details ?? null : { cached_tokens: 0 },
      output_tokens: usage.completion_tokens,
      output_tokens_details: nativeGrok ? usage.completion_tokens_details ?? null : { reasoning_tokens: 0 },
      total_tokens: usage.total_tokens,
    } : null,
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
