import { describe, it, expect } from 'vitest';
import { buildPromptPayload } from '../../../src/services/adapters/runner-claude.js';

describe('buildPromptPayload', () => {
  it('flattens a simple user/assistant transcript', () => {
    const out = buildPromptPayload([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]);
    expect(out.prompt).toBe('user: hello\nassistant: world');
    expect(out.images).toEqual([]);
  });

  it('extracts image blocks and replaces with placeholders', () => {
    const out = buildPromptPayload([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } },
        ],
      },
    ]);
    expect(out.prompt).toBe('user: look at this\n[Image 1 attached]');
    expect(out.images).toEqual([{ url: 'https://example.com/x.png' }]);
  });

  it('handles base64 image sources by building a data URL', () => {
    const out = buildPromptPayload([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'ZGVhZGJlZWY=' },
          },
        ],
      },
    ]);
    expect(out.images).toEqual([{ url: 'data:image/png;base64,ZGVhZGJlZWY=' }]);
  });

  it('skips empty content messages', () => {
    const out = buildPromptPayload([
      { role: 'user', content: '   ' },
      { role: 'user', content: 'real' },
    ]);
    expect(out.prompt).toBe('user: real');
  });
});
