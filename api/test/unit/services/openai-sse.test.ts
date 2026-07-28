import { describe, it, expect } from 'vitest';
import type { FastifyReply } from 'fastify';
import {
  chatCompletionStreamEvents,
  formatSseFrame,
  pipeOpenAiStream,
  SSE_DONE,
  type SseEvent,
} from '../../../src/services/stream/openai-sse.js';

/** A materialized chat completion with every field present and non-empty content. */
function sampleCompletion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-abc',
    created: 1_700_000_000,
    model: 'gpt-5.4',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
    ...overrides,
  };
}

function dataOf(event: SseEvent): Record<string, unknown> {
  return event.data as Record<string, unknown>;
}

/** The `usage` object on the trailing empty-choices chunk (include_usage only). */
function trailingUsage(completion: Record<string, unknown>): unknown {
  const events = chatCompletionStreamEvents(completion, { includeUsage: true });
  return dataOf(events[events.length - 1]!).usage;
}

describe('chatCompletionStreamEvents include_usage', () => {
  it('appends a trailing usage chunk and marks content chunks usage:null', () => {
    const events = chatCompletionStreamEvents(sampleCompletion(), { includeUsage: true });
    expect(events).toHaveLength(4);

    for (const ev of events.slice(0, 3)) {
      const data = dataOf(ev);
      expect(data.usage).toBeNull();
      expect((data.choices as unknown[]).length).toBe(1);
    }

    const last = dataOf(events[3]!);
    expect(last.choices).toEqual([]);
    expect(last.usage).toEqual({ prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 });
    expect(last.object).toBe('chat.completion.chunk');
  });

  it('omits the usage key entirely when the option is unset or false', () => {
    for (const events of [
      chatCompletionStreamEvents(sampleCompletion()),
      chatCompletionStreamEvents(sampleCompletion(), { includeUsage: false }),
    ]) {
      expect(events).toHaveLength(3);
      for (const ev of events) expect(dataOf(ev)).not.toHaveProperty('usage');
    }
  });
});

describe('chatCompletionStreamEvents field fallbacks', () => {
  it('generates an id when the completion omits or mistypes it', () => {
    for (const completion of [
      sampleCompletion({ id: undefined }),
      sampleCompletion({ id: 42 }),
      sampleCompletion({ id: '' }),
    ]) {
      const data = dataOf(chatCompletionStreamEvents(completion)[0]!);
      expect(data.id).toMatch(/^chatcmpl-[0-9a-f]{24}$/);
    }
  });

  it('stamps a second-precision timestamp when created is not a number', () => {
    const before = Math.floor(Date.now() / 1000);
    const data = dataOf(chatCompletionStreamEvents(sampleCompletion({ created: '99' }))[0]!);
    const after = Math.floor(Date.now() / 1000);
    expect(Number.isInteger(data.created)).toBe(true);
    expect(data.created as number).toBeGreaterThanOrEqual(before);
    expect(data.created as number).toBeLessThanOrEqual(after);
  });

  it('falls back to an empty model when model is not a string', () => {
    const data = dataOf(chatCompletionStreamEvents(sampleCompletion({ model: null }))[0]!);
    expect(data.model).toBe('');
  });
});

describe('chatCompletionStreamEvents usage extraction', () => {
  it('defaults to zeros when usage is missing or not an object', () => {
    const zeros = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    expect(trailingUsage(sampleCompletion({ usage: undefined }))).toEqual(zeros);
    expect(trailingUsage(sampleCompletion({ usage: 'none' }))).toEqual(zeros);
  });

  it('derives total_tokens from prompt + completion when it is absent', () => {
    expect(trailingUsage(sampleCompletion({ usage: { prompt_tokens: 9 } }))).toEqual({
      prompt_tokens: 9,
      completion_tokens: 0,
      total_tokens: 9,
    });
  });

  it('passes a fully populated usage object through unchanged', () => {
    expect(trailingUsage(sampleCompletion())).toEqual({
      prompt_tokens: 11,
      completion_tokens: 4,
      total_tokens: 15,
    });
  });
});

describe('chatCompletionStreamEvents content extraction', () => {
  it('skips the content delta for unusable choices', () => {
    for (const completion of [
      sampleCompletion({ choices: [] }),
      sampleCompletion({ choices: 'nope' }),
      sampleCompletion({ choices: [{ index: 0, finish_reason: 'stop' }] }),
      sampleCompletion({ choices: [{ index: 0, message: { content: { text: 'hi' } } }] }),
    ]) {
      const events = chatCompletionStreamEvents(completion);
      expect(events).toHaveLength(2);
      expect(dataOf(events[0]!).choices).toEqual([
        { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null },
      ]);
      expect(dataOf(events[1]!).choices).toEqual([
        { index: 0, delta: {}, finish_reason: 'stop' },
      ]);
    }
  });
});

describe('formatSseFrame', () => {
  it('prefixes an event line when the event is named', () => {
    expect(formatSseFrame({ data: { ok: true }, event: 'ping' })).toBe(
      'event: ping\ndata: {"ok":true}\n\n',
    );
  });

  it('emits only the data line when the event name is absent or empty', () => {
    expect(formatSseFrame({ data: { ok: true } })).toBe('data: {"ok":true}\n\n');
    expect(formatSseFrame({ data: 1, event: '' })).toBe('data: 1\n\n');
  });
});

/**
 * Minimal stand-in for the pieces of FastifyReply `pipeOpenAiStream` touches:
 * the envelope opt-out flag, `header()`, `hijack()`, and the raw socket sink.
 */
function makeFakeReply() {
  const headers: Record<string, string> = {};
  const rawHeaders: Record<string, string> = {};
  const writes: string[] = [];
  const calls = { hijack: 0, end: 0 };
  const raw = {
    statusCode: 0,
    setHeader(name: string, value: string) {
      rawHeaders[name] = value;
    },
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    end() {
      calls.end += 1;
    },
  };
  const state = {
    envelopeRaw: false,
    raw,
    header(name: string, value: string) {
      headers[name] = value;
    },
    hijack() {
      calls.hijack += 1;
    },
  };
  return { state, reply: state as unknown as FastifyReply, headers, rawHeaders, writes, calls, raw };
}

async function* twoEvents(): AsyncGenerator<SseEvent> {
  yield { data: { n: 1 } };
  yield { data: { n: 2 } };
}

async function* explodingEvents(): AsyncGenerator<SseEvent> {
  yield { data: { n: 1 } };
  throw new Error('upstream exploded');
}

describe('pipeOpenAiStream', () => {
  it('hijacks the reply, sets SSE headers, and frames every event before [DONE]', async () => {
    const fake = makeFakeReply();
    await pipeOpenAiStream(fake.reply, twoEvents());

    expect(fake.state.envelopeRaw).toBe(true);
    expect(fake.calls.hijack).toBe(1);
    expect(fake.headers['content-type']).toBe('text/event-stream');
    expect(fake.headers['cache-control']).toBe('no-cache');
    expect(fake.headers['connection']).toBe('keep-alive');
    expect(fake.headers['x-accel-buffering']).toBe('no');
    expect(fake.raw.statusCode).toBe(200);
    expect(fake.rawHeaders['content-type']).toBe('text/event-stream');
    expect(fake.writes).toEqual([
      'data: {"n":1}\n\n',
      'data: {"n":2}\n\n',
      SSE_DONE,
    ]);
    expect(fake.calls.end).toBe(1);
  });

  it('ends the response even when the iterable throws mid-stream', async () => {
    const fake = makeFakeReply();
    await expect(pipeOpenAiStream(fake.reply, explodingEvents())).rejects.toThrow(
      'upstream exploded',
    );
    expect(fake.writes).toEqual(['data: {"n":1}\n\n']);
    expect(fake.calls.end).toBe(1);
  });
});
