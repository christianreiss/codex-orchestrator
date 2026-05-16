import { describe, it, expect } from 'vitest';
import { messageStreamEvents } from '../../../src/http/stream/anthropic-sse.js';

describe('messageStreamEvents', () => {
  const sample = {
    id: 'msg_abc123',
    type: 'message' as const,
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'Hello, world.' }],
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 7,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };

  it('emits the canonical 6-event sequence', () => {
    const events = messageStreamEvents(sample);
    const eventNames = events.map((e) => e.event);
    expect(eventNames).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });

  it('attaches the message id, model, and usage to message_start', () => {
    const events = messageStreamEvents(sample);
    expect(events[0]!.data).toMatchObject({
      type: 'message_start',
      message: {
        id: 'msg_abc123',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    });
  });

  it('puts the full output text in content_block_delta', () => {
    const events = messageStreamEvents(sample);
    expect(events[2]!.data).toMatchObject({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello, world.' },
    });
  });

  it('carries stop_reason + output_tokens through message_delta', () => {
    const events = messageStreamEvents(sample);
    expect(events[4]!.data).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 3 },
    });
  });

  it('ends the stream with a bare message_stop', () => {
    const events = messageStreamEvents(sample);
    expect(events[5]!.event).toBe('message_stop');
    expect(events[5]!.data).toEqual({ type: 'message_stop' });
  });
});
