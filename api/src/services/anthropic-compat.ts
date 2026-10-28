/**
 * Anthropic-shape <-> internal message normalization helpers. Direct port of
 * src/Http/AnthropicCompat.php; same name choices to make the diff small.
 *
 * Used by /anthropic/v1/messages, /anthropic/v1/completions, /anthropic/v1/responses.
 */
import { ApiError } from '../http/errors.js';
import type {
  ClaudeMessage,
  ClaudeContentBlock,
  ClaudeMessageResponse,
} from './adapters/runner-claude.js';

type Role = 'user' | 'assistant' | 'system';

function normalizeRole(role: unknown): Role {
  const v = typeof role === 'string' ? role.toLowerCase().trim() : 'user';
  if (v === 'system' || v === 'developer') return 'system';
  if (v === 'assistant') return 'assistant';
  return 'user';
}

function looksLikeSingleContentPart(c: Record<string, unknown>): boolean {
  return 'type' in c || 'text' in c || 'source' in c;
}

/**
 * Content block types this text-only backend genuinely cannot process. They
 * used to be silently dropped — a PDF request returned 200 with the document
 * ignored — which is a wire lie. Mirror the top-level `tools` 400 gate and
 * reject them explicitly instead.
 */
const UNSUPPORTED_CONTENT_BLOCK_TYPES = new Set([
  'document',
  'tool_use',
  'tool_result',
  'thinking',
  'redacted_thinking',
  'server_tool_use',
  'web_search_tool_result',
  'search_result',
]);

function normalizeContentPart(part: Record<string, unknown>): ClaudeContentBlock | null {
  const rawType = typeof part.type === 'string' ? part.type.toLowerCase().trim() : '';
  if (UNSUPPORTED_CONTENT_BLOCK_TYPES.has(rawType)) {
    throw new ApiError(
      `messages: content block of type "${rawType}" is not supported by this backend`,
      {
        status: 400,
        code: 'unsupported_content_block',
        type: 'invalid_request_error',
        param: 'messages',
      },
    );
  }
  if (rawType === 'input_text' || rawType === 'text' || rawType === 'output_text') {
    const text = part.text;
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    return { type: 'text', text: trimmed };
  }
  if (rawType === 'image') {
    const src = part.source as Record<string, unknown> | undefined;
    if (!src || typeof src !== 'object') return null;
    const sourceType = typeof src.type === 'string' ? src.type : '';
    if (sourceType === 'base64') {
      const mediaType = src.media_type;
      const data = src.data;
      if (typeof mediaType !== 'string' || typeof data !== 'string' || !data) return null;
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    }
    if (sourceType === 'url') {
      const url = src.url;
      if (typeof url !== 'string' || !url.trim()) return null;
      return { type: 'image', source: { type: 'url', url: url.trim() } };
    }
    return null;
  }
  if (rawType === 'image_url' || rawType === 'input_image') {
    const imageUrl: unknown = part.image_url;
    let url: string | null = null;
    if (imageUrl && typeof imageUrl === 'object') {
      url =
        typeof (imageUrl as Record<string, unknown>).url === 'string'
          ? ((imageUrl as Record<string, unknown>).url as string)
          : null;
    } else if (typeof imageUrl === 'string') {
      url = imageUrl;
    }
    if (!url || !url.trim()) return null;
    url = url.trim();
    // data URL
    const m = /^data:image\/([^;]+);base64,(.+)$/.exec(url);
    if (m) {
      return {
        type: 'image',
        source: { type: 'base64', media_type: `image/${m[1]}`, data: m[2]! },
      };
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return { type: 'image', source: { type: 'url', url } };
    }
    return null;
  }
  return null;
}

function normalizeMessageContent(content: unknown): string | ClaudeContentBlock[] | null {
  if (typeof content === 'string') {
    const v = content.trim();
    return v !== '' ? v : null;
  }
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object') {
      const single = content as Record<string, unknown>;
      if (looksLikeSingleContentPart(single)) return normalizeMessageContent([single]);
    }
    return null;
  }
  const parts: ClaudeContentBlock[] = [];
  for (const p of content) {
    if (typeof p === 'string') {
      const v = p.trim();
      if (v) parts.push({ type: 'text', text: v });
      continue;
    }
    if (!p || typeof p !== 'object') continue;
    const norm = normalizeContentPart(p as Record<string, unknown>);
    if (norm) parts.push(norm);
  }
  if (parts.length === 0) return null;
  if (parts.length === 1 && parts[0]!.type === 'text') {
    return (parts[0] as { type: 'text'; text: string }).text;
  }
  return parts;
}

/**
 * Normalize the messages array from a /messages or /completions request.
 * Returns null when the input is malformed / empty.
 */
export function normalizeChatMessages(messages: unknown): ClaudeMessage[] | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const out: ClaudeMessage[] = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const content = normalizeMessageContent(e.content);
    if (content === null) continue;
    out.push({ role: normalizeRole(e.role), content });
  }
  return out.length > 0 ? out : null;
}

/**
 * Pull system messages out of the conversation. Anthropic's API takes a
 * top-level `system` string; OpenAI-shape inputs interleave `role:'system'`
 * entries. We hoist them to the dedicated `system` param.
 */
export function extractSystemMessages(messages: ClaudeMessage[]): {
  system: string | null;
  messages: ClaudeMessage[];
} {
  const systemParts: string[] = [];
  const conversation: ClaudeMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      const text =
        typeof message.content === 'string' ? message.content : extractText(message.content);
      if (text) systemParts.push(text);
      continue;
    }
    conversation.push(message);
  }
  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : null,
    messages: conversation,
  };
}

function extractText(blocks: ClaudeContentBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) if (b.type === 'text' && b.text) out.push(b.text);
  return out.join('\n');
}

/**
 * Normalize the OpenAI /v1/responses-shaped `input` parameter (+ optional
 * `instructions`) into the Anthropic message list.
 */
export function normalizeResponsesInput(
  input: unknown,
  instructions: unknown = null,
): ClaudeMessage[] | null {
  const messages: ClaudeMessage[] = [];
  if (typeof instructions === 'string' && instructions.trim()) {
    messages.push({ role: 'system', content: instructions.trim() });
  }
  if (typeof input === 'string') {
    const v = input.trim();
    if (!v) return null;
    messages.push({ role: 'user', content: v });
    return messages;
  }
  if (!Array.isArray(input)) return null;

  const inputMessages: ClaudeMessage[] = [];
  for (const entry of input) {
    if (typeof entry === 'string') {
      const v = entry.trim();
      if (v) inputMessages.push({ role: 'user', content: v });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const role = normalizeRole(e.role);
    const content = normalizeMessageContent(e.content);
    if (e.type === 'message' && content !== null) {
      inputMessages.push({ role, content });
      continue;
    }
    if (content !== null && 'role' in e) {
      inputMessages.push({ role, content });
    }
  }
  if (inputMessages.length === 0) {
    const content = normalizeMessageContent(input);
    if (content !== null) inputMessages.push({ role: 'user', content });
  }
  const out = [...messages, ...inputMessages];
  return out.length > 0 ? out : null;
}

/** Build an OpenAI /v1/responses-shaped body from an Anthropic message reply. */
export function responseFromMessage(message: ClaudeMessageResponse): Record<string, unknown> {
  const sourceId = message.id || '';
  const responseId = deriveId(sourceId, 'resp_');
  const messageId = deriveId(sourceId, 'msg_');
  const model = message.model || '';
  const usage =
    message.usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
  let text = '';
  for (const block of message.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output: [
      {
        id: messageId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
      },
    ],
    parallel_tool_calls: false,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: usage.input_tokens + usage.output_tokens,
    },
  };
}

function deriveId(sourceId: string, prefix: string): string {
  if (sourceId) {
    const suffix = sourceId.replace(/^[^-_]+[-_]/, '');
    if (suffix) return prefix + suffix;
  }
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return prefix + hex;
}

/**
 * Normalize the Anthropic top-level `system` parameter. The wire format accepts
 * either a plain string or an array of text content blocks (the shape every
 * prompt-caching client and the official SDKs send). This backend flattens the
 * prompt to a single string, so block arrays are joined and per-block metadata
 * (`cache_control`) is dropped.
 *
 * Returns null when there is no usable system prompt.
 */
export function normalizeSystemPrompt(value: unknown): string | null {
  if (typeof value === 'string') {
    const v = value.trim();
    return v !== '' ? v : null;
  }
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const block of value) {
    if (typeof block === 'string') {
      const v = block.trim();
      if (v) parts.push(v);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const type = typeof b.type === 'string' ? b.type.toLowerCase().trim() : '';
    // `type` is optional in practice; treat any block carrying text as text.
    if (type !== '' && type !== 'text' && type !== 'input_text') continue;
    if (typeof b.text !== 'string') continue;
    const v = b.text.trim();
    if (v) parts.push(v);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * Pull the generation params subset from an Anthropic request body. Supports
 * OpenAI-style `stop` aliasing onto `stop_sequences`, and normalizes the
 * string-or-block-array `system` parameter.
 *
 * Throws ApiError(400) for a present-but-invalid `max_tokens` always; throws
 * for a *missing* `max_tokens` only when `opts.requireMaxTokens` is set. The
 * real Messages API requires it and every official SDK sends it, so
 * `/anthropic/v1/messages` opts in — but the OpenAI-shaped `/completions` and
 * `/responses` shims never advertised it as required, so they stay lenient.
 */
export function extractParams(
  payload: Record<string, unknown>,
  opts: { requireMaxTokens?: boolean } = {},
): {
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  system?: string;
} {
  const out: Record<string, unknown> = {};
  for (const k of ['max_tokens', 'temperature', 'top_p', 'top_k', 'stop_sequences'] as const) {
    if (payload[k] !== undefined) out[k] = payload[k];
  }
  if (out.max_tokens === undefined && opts.requireMaxTokens) {
    throw new ApiError('max_tokens: Field required', {
      status: 400,
      code: 'missing_max_tokens',
      type: 'invalid_request_error',
      param: 'max_tokens',
    });
  }
  if (out.max_tokens !== undefined) {
    const v = out.max_tokens;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      throw new ApiError('max_tokens: Input should be a valid integer greater than 0', {
        status: 400,
        code: 'invalid_max_tokens',
        type: 'invalid_request_error',
        param: 'max_tokens',
      });
    }
  }
  const system = normalizeSystemPrompt(payload.system);
  if (system !== null) out.system = system;
  if (payload.stop !== undefined && out.stop_sequences === undefined) {
    out.stop_sequences = Array.isArray(payload.stop) ? payload.stop : [payload.stop];
  }
  return out;
}

/**
 * `anthropic-version` values this surface accepts, newest first. `2026-10-21`
 * is the default of @anthropic-ai/sdk >= 1.0.0 and the other official SDK
 * majors released with it.
 */
export const ANTHROPIC_API_VERSIONS = ['2026-10-21', '2023-06-01', '2023-01-01'] as const;
export type AnthropicApiVersion = (typeof ANTHROPIC_API_VERSIONS)[number];

export function isAnthropicApiVersion(value: unknown): value is AnthropicApiVersion {
  return typeof value === 'string' && (ANTHROPIC_API_VERSIONS as readonly string[]).includes(value);
}

const VERSION_2026_10_21 = '2026-10-21';
const REMOVED_SAMPLING_PARAMS = ['temperature', 'top_p', 'top_k'] as const;

function removedInVersion(message: string, param: string): ApiError {
  return new ApiError(message, {
    status: 400,
    code: 'unsupported_in_api_version',
    type: 'invalid_request_error',
    param,
  });
}

function hasNonEmptyCitations(block: Record<string, unknown>): boolean {
  return Array.isArray(block.citations) && block.citations.length > 0;
}

function rawContentBlocks(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  // The gateway also tolerates one bare block object; check it the same way.
  if (content && typeof content === 'object') return [content];
  return [];
}

/**
 * Request rules an API version adds on the Messages API and token counting,
 * checked on the raw body before normalization (which would otherwise reject
 * a document with the generic backend error or drop `citations` silently).
 *
 * `2026-10-21` (platform.claude.com/docs/en/api/versioning and
 * /api/migration-2026-10-21, fetched 2026-10-28) returns 400 for:
 * - `temperature`, `top_p` or `top_k`, even at the default value (a JSON
 *   `null` counts as sent, as everywhere else in this surface);
 * - a `document` block placed directly in an `assistant` message;
 * - a `text` block with a non-empty `citations` array in a `user` message,
 *   directly or inside a `search_result` block.
 * Earlier versions are unchanged. The check is wire-level, so it applies to
 * whichever backend engine answers the surface.
 */
export function assertMessagesRequestForApiVersion(
  version: AnthropicApiVersion,
  payload: Record<string, unknown>,
): void {
  if (version !== VERSION_2026_10_21) return;
  for (const param of REMOVED_SAMPLING_PARAMS) {
    if (payload[param] !== undefined) {
      throw removedInVersion(
        `${param}: This parameter is not supported in anthropic-version ${VERSION_2026_10_21}. Remove it, or send anthropic-version: 2023-06-01 to keep using it.`,
        param,
      );
    }
  }
  if (!Array.isArray(payload.messages)) return;
  payload.messages.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') return;
    const message = entry as Record<string, unknown>;
    const role = normalizeRole(message.role);
    rawContentBlocks(message.content).forEach((raw, j) => {
      if (!raw || typeof raw !== 'object') return;
      const block = raw as Record<string, unknown>;
      const type = typeof block.type === 'string' ? block.type.toLowerCase().trim() : '';
      const path = `messages.${i}.content.${j}`;
      if (role === 'assistant' && type === 'document') {
        throw removedInVersion(
          `${path}: A document block cannot be placed directly in an assistant message in anthropic-version ${VERSION_2026_10_21}. Send documents in user messages.`,
          path,
        );
      }
      if (role !== 'user') return;
      if (type === 'text' && hasNonEmptyCitations(block)) {
        throw removedInVersion(
          `${path}: A text block in a user message cannot carry citations in anthropic-version ${VERSION_2026_10_21}. Remove citations from the block.`,
          path,
        );
      }
      if (type === 'search_result') {
        rawContentBlocks(block.content).forEach((inner, k) => {
          if (!inner || typeof inner !== 'object') return;
          const text = inner as Record<string, unknown>;
          if (text.type === 'text' && hasNonEmptyCitations(text)) {
            const innerPath = `${path}.content.${k}`;
            throw removedInVersion(
              `${innerPath}: A text block in a user message cannot carry citations in anthropic-version ${VERSION_2026_10_21}. Remove citations from the block.`,
              innerPath,
            );
          }
        });
      }
    });
  });
}

/**
 * Validate the final (post system-hoist) conversation the way the real
 * Messages API does: non-empty and only `user`/`assistant` roles. Throws
 * ApiError(400) on the first violation.
 *
 * Note: consecutive same-role turns are NOT rejected. The real Messages API
 * documents that "consecutive user or assistant turns in your request will be
 * combined into a single turn" — see {@link mergeConsecutiveSameRole}, which the
 * route applies before dispatch. A hard 400 here (as an earlier revision did)
 * spuriously rejects requests the upstream API accepts.
 */
export function validateMessageSequence(messages: ClaudeMessage[]): void {
  if (messages.length === 0) {
    throw new ApiError('messages: at least one message is required', {
      status: 400,
      code: 'empty_messages',
      type: 'invalid_request_error',
      param: 'messages',
    });
  }
  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]!.role;
    if (role !== 'user' && role !== 'assistant') {
      throw new ApiError(
        `messages.${i}.role: Input should be 'user' or 'assistant'`,
        {
          status: 400,
          code: 'invalid_message_role',
          type: 'invalid_request_error',
          param: `messages.${i}.role`,
        },
      );
    }
  }
}

/**
 * Collapse consecutive same-role turns into a single turn, matching the real
 * Messages API ("consecutive user or assistant turns ... will be combined into
 * a single turn"). This both restores conformance (the upstream API accepts
 * these requests) and hands the downstream `claude` CLI a clean alternating
 * sequence. Content blocks are concatenated; an all-text merge is flattened
 * back to a joined string. The input array is not mutated.
 */
export function mergeConsecutiveSameRole(messages: ClaudeMessage[]): ClaudeMessage[] {
  const out: ClaudeMessage[] = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === msg.role) {
      out[out.length - 1] = { role: prev.role, content: mergeContent(prev.content, msg.content) };
    } else {
      out.push(msg);
    }
  }
  return out;
}

function toBlocks(content: string | ClaudeContentBlock[]): ClaudeContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function mergeContent(
  a: string | ClaudeContentBlock[],
  b: string | ClaudeContentBlock[],
): string | ClaudeContentBlock[] {
  const blocks = [...toBlocks(a), ...toBlocks(b)];
  if (blocks.every((block) => block.type === 'text')) {
    return blocks.map((block) => (block as { type: 'text'; text: string }).text).join('\n\n');
  }
  return blocks;
}

/**
 * Best-effort token estimate for `POST /messages/count_tokens`. This backend
 * has no access to the real Anthropic tokenizer (the runner shells out to the
 * `claude` CLI, not a raw model endpoint), so this is a character-based
 * approximation (~4 chars/token, the commonly-cited English average) plus a
 * small per-message and per-tool overhead. It will not match the exact count
 * the real API returns — see docs/API.md.
 */
export function estimateTokenCount(
  messages: ClaudeMessage[],
  system: string | null,
  tools: unknown[],
): number {
  const CHARS_PER_TOKEN = 4;
  const PER_MESSAGE_OVERHEAD = 4;
  let chars = 0;
  let overhead = 0;
  if (system) chars += system.length;
  for (const message of messages) {
    overhead += PER_MESSAGE_OVERHEAD;
    chars += contentLength(message.content);
  }
  for (const tool of tools) {
    overhead += PER_MESSAGE_OVERHEAD;
    chars += JSON.stringify(tool ?? '').length;
  }
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN) + overhead);
}

function contentLength(content: string | ClaudeContentBlock[]): number {
  if (typeof content === 'string') return content.length;
  let total = 0;
  for (const block of content) {
    if (block.type === 'text') total += block.text.length;
    else total += 256; // flat estimate for non-text blocks (images, etc.)
  }
  return total;
}
