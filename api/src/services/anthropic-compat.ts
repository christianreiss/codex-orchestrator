/**
 * Anthropic-shape <-> internal message normalization helpers. Direct port of
 * src/Http/AnthropicCompat.php; same name choices to make the diff small.
 *
 * Used by /anthropic/v1/messages, /anthropic/v1/completions, /anthropic/v1/responses.
 */
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

function normalizeContentPart(part: Record<string, unknown>): ClaudeContentBlock | null {
  const rawType = typeof part.type === 'string' ? part.type.toLowerCase().trim() : '';
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
 * Pull the generation params subset from an Anthropic request body. Supports
 * OpenAI-style `stop` aliasing onto `stop_sequences`.
 */
export function extractParams(payload: Record<string, unknown>): {
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  system?: string;
} {
  const out: Record<string, unknown> = {};
  for (const k of ['max_tokens', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'system'] as const) {
    if (payload[k] !== undefined) out[k] = payload[k];
  }
  if (payload.stop !== undefined && out.stop_sequences === undefined) {
    out.stop_sequences = Array.isArray(payload.stop) ? payload.stop : [payload.stop];
  }
  return out;
}
