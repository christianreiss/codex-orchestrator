import { describe, it, expect } from 'vitest';
import {
  extractParams,
  extractSystemMessages,
  normalizeChatMessages,
  normalizeResponsesInput,
  normalizeSystemPrompt,
  responseFromMessage,
} from '../../../src/services/anthropic-compat.js';

describe('normalizeChatMessages', () => {
  it('returns null for empty/invalid input', () => {
    expect(normalizeChatMessages(null)).toBeNull();
    expect(normalizeChatMessages([])).toBeNull();
    expect(normalizeChatMessages('not array')).toBeNull();
  });

  it('preserves a simple user message', () => {
    const out = normalizeChatMessages([{ role: 'user', content: 'hi' }]);
    expect(out).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('collapses single-text content blocks back to a string', () => {
    const out = normalizeChatMessages([
      { role: 'user', content: [{ type: 'text', text: '  hello  ' }] },
    ]);
    expect(out).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('keeps multi-block content as an array of blocks', () => {
    const out = normalizeChatMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see this' },
          { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
        ],
      },
    ]);
    expect(out).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see this' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } },
        ],
      },
    ]);
  });

  it('normalizes role aliases', () => {
    const out = normalizeChatMessages([
      { role: 'developer', content: 'sys' },
      { role: 'ASSISTANT', content: 'a' },
      { role: 'unknown', content: 'u' },
    ]);
    expect(out).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'u' },
    ]);
  });
});

describe('extractSystemMessages', () => {
  it('hoists system entries and concatenates with double newline', () => {
    const out = extractSystemMessages([
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'user', content: 'q' },
    ]);
    expect(out.system).toBe('A\n\nB');
    expect(out.messages).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('returns null system when there are no system entries', () => {
    const out = extractSystemMessages([{ role: 'user', content: 'q' }]);
    expect(out.system).toBeNull();
    expect(out.messages).toEqual([{ role: 'user', content: 'q' }]);
  });
});

describe('normalizeResponsesInput', () => {
  it('handles a bare string input with instructions', () => {
    expect(normalizeResponsesInput('hello', 'be brief')).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('handles an array of input items', () => {
    expect(
      normalizeResponsesInput(
        [
          { type: 'message', role: 'user', content: 'q1' },
          'q2',
        ],
        null,
      ),
    ).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'user', content: 'q2' },
    ]);
  });

  it('returns null for empty/invalid input', () => {
    expect(normalizeResponsesInput('', null)).toBeNull();
    expect(normalizeResponsesInput(42, null)).toBeNull();
  });
});

describe('extractParams', () => {
  it('passes through supported generation params', () => {
    const p = extractParams({
      max_tokens: 1024,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ['END'],
      system: 'sys',
      unrelated: 'x',
    });
    expect(p).toEqual({
      max_tokens: 1024,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ['END'],
      system: 'sys',
    });
  });

  it('aliases OpenAI stop onto stop_sequences', () => {
    expect(extractParams({ stop: 'END' })).toEqual({ stop_sequences: ['END'] });
    expect(extractParams({ stop: ['A', 'B'] })).toEqual({ stop_sequences: ['A', 'B'] });
  });

  it('does not overwrite an explicit stop_sequences', () => {
    expect(extractParams({ stop: 'END', stop_sequences: ['X'] })).toEqual({
      stop_sequences: ['X'],
    });
  });

  it('flattens a block-array system prompt', () => {
    expect(
      extractParams({
        system: [
          { type: 'text', text: ' A ', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'B' },
        ],
      }),
    ).toEqual({ system: 'A\n\nB' });
  });

  it('drops an empty or unusable system prompt', () => {
    expect(extractParams({ system: '   ' })).toEqual({});
    expect(extractParams({ system: [] })).toEqual({});
    expect(extractParams({ system: [{ type: 'image', source: {} }] })).toEqual({});
    expect(extractParams({ system: 42 })).toEqual({});
  });

  it('rejects a present-but-invalid max_tokens', () => {
    for (const bad of [0, -3, 1.5, '10', null]) {
      expect(() => extractParams({ max_tokens: bad })).toThrow(/max_tokens/);
    }
    expect(extractParams({})).toEqual({});
    expect(extractParams({ max_tokens: 1 })).toEqual({ max_tokens: 1 });
  });
});

describe('normalizeSystemPrompt', () => {
  it('accepts both wire forms', () => {
    expect(normalizeSystemPrompt('hi')).toBe('hi');
    expect(normalizeSystemPrompt([{ type: 'text', text: 'hi' }])).toBe('hi');
    // `type` is optional in practice; any block carrying text counts.
    expect(normalizeSystemPrompt([{ text: 'hi' }])).toBe('hi');
    expect(normalizeSystemPrompt(['a', 'b'])).toBe('a\n\nb');
    expect(normalizeSystemPrompt(undefined)).toBeNull();
  });
});

describe('responseFromMessage', () => {
  it('shapes an OpenAI /v1/responses-style body from a Claude message', () => {
    const out = responseFromMessage({
      id: 'msg_abc123',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi there' }],
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 5,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    expect(out.object).toBe('response');
    expect(out.status).toBe('completed');
    expect(out.model).toBe('claude-sonnet-4-6');
    expect((out.id as string).startsWith('resp_')).toBe(true);
    const output = out.output as Array<{ content: Array<{ text: string }> }>;
    expect(output[0]?.content[0]?.text).toBe('Hi there');
    expect((out.usage as Record<string, number>).total_tokens).toBe(15);
  });
});
