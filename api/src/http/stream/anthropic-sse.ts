/**
 * Anthropic Server-Sent-Events emitter.
 *
 * Emits the canonical event sequence used by the legacy PHP backend
 * (`AnthropicCompat::messageStreamEvents`):
 *
 *   event: message_start         data: { type:'message_start', message:{…} }
 *   event: content_block_start   data: { type:'content_block_start', index:0, … }
 *   event: content_block_delta   data: { type:'content_block_delta', delta:{ … } }
 *   event: content_block_stop    data: { type:'content_block_stop', index:0 }
 *   event: message_delta         data: { type:'message_delta', delta:{…}, usage:{…} }
 *   event: message_stop          data: { type:'message_stop' }
 *
 * The PHP code generates these from a *completed* response object (the runner
 * has no token streaming). We do the same — one shot, emitted at flush time.
 *
 * Callers set `reply.envelopeRaw = true` and the correct content-type before
 * invoking this module; we only touch `reply.raw` (the Node `ServerResponse`).
 */
import type { FastifyReply } from 'fastify';
import type { ClaudeMessageResponse } from '../../services/adapters/runner-claude.js';
import { CLAUDE_DEFAULT_MODEL } from '../../services/claude-models.js';

export interface AnthropicSseEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Build the canonical sequence of SSE events for a completed Anthropic message.
 */
export function messageStreamEvents(message: ClaudeMessageResponse): AnthropicSseEvent[] {
  const id = message.id || `msg_${randomHex(12)}`;
  const model = message.model || CLAUDE_DEFAULT_MODEL;
  const usage =
    message.usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
  let text = '';
  for (const block of message.content ?? []) {
    if (block.type === 'text') {
      text = block.text;
      break;
    }
  }

  return [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: {
          stop_reason: message.stop_reason ?? 'end_turn',
          stop_sequence: message.stop_sequence ?? null,
        },
        usage: { output_tokens: usage.output_tokens },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

/**
 * Set the headers + body for a Fastify SSE reply. After this call, the response
 * is complete (Node `res.end()` was invoked); the handler should `return reply`
 * (or `return undefined`).
 */
export async function writeSseResponse(
  reply: FastifyReply,
  events: AnthropicSseEvent[],
): Promise<void> {
  reply.envelopeRaw = true;
  reply.header('content-type', 'text/event-stream; charset=utf-8');
  reply.header('cache-control', 'no-cache, no-transform');
  reply.header('connection', 'keep-alive');
  reply.header('x-accel-buffering', 'no'); // tell nginx-style proxies not to buffer
  reply.status(200);

  // Force Fastify to commit headers + own the body.
  reply.hijack();
  const raw = reply.raw;
  // Headers are written lazily by hijack(); ensure they go out now.
  if (!raw.headersSent) {
    // Coerce header values to the Node http types (Fastify allows numbers).
    const headerEntries: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(reply.getHeaders())) {
      if (v === undefined) continue;
      headerEntries[k] = Array.isArray(v) ? v : String(v);
    }
    raw.writeHead(reply.statusCode, headerEntries);
  }

  for (const evt of events) {
    raw.write(`event: ${evt.event}\n`);
    raw.write(`data: ${JSON.stringify(evt.data)}\n\n`);
  }
  raw.end();
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
