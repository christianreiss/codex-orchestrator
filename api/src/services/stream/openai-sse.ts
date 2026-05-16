import type { FastifyReply } from 'fastify';

/**
 * Server-Sent Events writer for OpenAI streaming endpoints. Each chunk is
 * emitted as one `data: <json>\n\n` frame and the stream is terminated with
 * `data: [DONE]\n\n` — matching the legacy PHP `OpenAiResponse::streamEvents`
 * shape exactly.
 *
 * Setting `reply.envelopeRaw = true` opts the response out of the JSON
 * envelope onSend hook, so the framing reaches the wire unmodified.
 */
export function setupSseHeaders(reply: FastifyReply): void {
  reply.envelopeRaw = true;
  reply.header('content-type', 'text/event-stream');
  reply.header('cache-control', 'no-cache');
  reply.header('connection', 'keep-alive');
  reply.header('x-accel-buffering', 'no');
}

export interface SseEvent {
  data: unknown;
  event?: string;
}

export function formatSseFrame(event: SseEvent): string {
  let frame = '';
  if (event.event) frame += `event: ${event.event}\n`;
  frame += `data: ${JSON.stringify(event.data)}\n\n`;
  return frame;
}

export const SSE_DONE = 'data: [DONE]\n\n';

/**
 * Consume an async iterable of OpenAI-shape chunks and serialize them to the
 * raw reply socket. Closes the stream with `[DONE]` and `reply.raw.end()`.
 */
export async function pipeOpenAiStream(
  reply: FastifyReply,
  events: AsyncIterable<SseEvent>,
): Promise<void> {
  setupSseHeaders(reply);
  reply.hijack();
  const res = reply.raw;
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  try {
    for await (const ev of events) {
      res.write(formatSseFrame(ev));
    }
    res.write(SSE_DONE);
  } finally {
    res.end();
  }
}

/**
 * Build the chat.completion.chunk SSE event sequence from a fully-materialized
 * OpenAI chat-completion body. Mirrors `OpenAiCompat::chatCompletionStreamEvents`.
 */
export function chatCompletionStreamEvents(
  completion: Record<string, unknown>,
): SseEvent[] {
  const id =
    typeof completion.id === 'string' && completion.id
      ? completion.id
      : `chatcmpl-${randomHex(12)}`;
  const created = typeof completion.created === 'number' ? completion.created : Math.floor(Date.now() / 1000);
  const model = typeof completion.model === 'string' ? completion.model : '';
  const content = extractChatCompletionContent(completion);

  const base = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
  };

  const events: SseEvent[] = [
    {
      data: {
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '' },
            finish_reason: null,
          },
        ],
      },
    },
  ];

  if (content !== '') {
    events.push({
      data: {
        ...base,
        choices: [
          { index: 0, delta: { content }, finish_reason: null },
        ],
      },
    });
  }

  events.push({
    data: {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  });

  return events;
}

function extractChatCompletionContent(completion: Record<string, unknown>): string {
  const choices = completion.choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== 'object') return '';
  const message = first.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  return typeof content === 'string' ? content : '';
}

function randomHex(bytes: number): string {
  let out = '';
  for (let i = 0; i < bytes; i++) {
    out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  }
  return out;
}
