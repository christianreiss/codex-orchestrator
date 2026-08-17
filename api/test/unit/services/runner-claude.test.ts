import { describe, it, expect } from 'vitest';
import {
  buildPromptPayload,
  createRunnerClaudeAdapter,
} from '../../../src/services/adapters/runner-claude.js';

const baseEnv = {
  AUTH_RUNNER_URL: '',
  AUTH_RUNNER_SHARED_SECRET: 'secret',
  AUTH_RUNNER_TIMEOUT: 1,
} as unknown as Parameters<typeof createRunnerClaudeAdapter>[0]['env'];

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

describe('createRunnerClaudeAdapter', () => {
  // The runner only registers POST /exec, so every AUTH_RUNNER_URL form has to
  // land there — not just the `/verify` endpoint the deployment docs use.
  it.each([
    'https://runner.example',
    'https://runner.example/verify',
    'https://runner.example/verify/',
    'https://runner.example/exec',
  ])('posts to the runner exec route for AUTH_RUNNER_URL %s', async (url) => {
    const targets: string[] = [];
    const fakeFetch = (async (target: string) => {
      targets.push(target);
      return new Response(JSON.stringify({ status: 'ok', output: 'pong' }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createRunnerClaudeAdapter({
      env: { ...baseEnv, AUTH_RUNNER_URL: url },
      getAuthSnapshot: async () => ({ token: 't' }),
      fetcher: fakeFetch,
    });
    if (!adapter) throw new Error('adapter should be configured');

    const res = await adapter.messages([{ role: 'user', content: 'ping' }], 'claude-sonnet-4', {});

    expect(targets).toEqual(['https://runner.example/exec']);
    expect(res.content).toEqual([{ type: 'text', text: 'pong' }]);
  });
});

describe('onExecSuccess traffic hook', () => {
  const okFetch = (async () =>
    new Response(JSON.stringify({ status: 'ok', output: 'pong' }), {
      status: 200,
    })) as unknown as typeof fetch;
  const failFetch = (async () =>
    new Response(JSON.stringify({ status: 'fail', error: 'nope' }), {
      status: 200,
    })) as unknown as typeof fetch;

  it('fires exactly once on a successful exec', async () => {
    let fired = 0;
    const adapter = createRunnerClaudeAdapter({
      env: { ...baseEnv, AUTH_RUNNER_URL: 'https://runner.example' },
      getAuthSnapshot: async () => ({ token: 't' }),
      onExecSuccess: () => {
        fired += 1;
      },
      fetcher: okFetch,
    });
    if (!adapter) throw new Error('adapter should be configured');
    await adapter.messages([{ role: 'user', content: 'ping' }], 'claude-test', {});
    expect(fired).toBe(1);
  });

  it('does not fire on a failed exec', async () => {
    let fired = 0;
    const adapter = createRunnerClaudeAdapter({
      env: { ...baseEnv, AUTH_RUNNER_URL: 'https://runner.example' },
      getAuthSnapshot: async () => ({ token: 't' }),
      onExecSuccess: () => {
        fired += 1;
      },
      fetcher: failFetch,
    });
    if (!adapter) throw new Error('adapter should be configured');
    await expect(
      adapter.messages([{ role: 'user', content: 'ping' }], 'claude-test', {}),
    ).rejects.toThrow();
    expect(fired).toBe(0);
  });
});

describe('generation controls the Claude CLI cannot honor', () => {
  function adapterWith(record: { body?: Record<string, unknown> }) {
    const fetcher = (async (_url: string, init?: { body?: string }) => {
      record.body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ status: 'ok', output: 'pong', input_tokens: 3, output_tokens: 4 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const adapter = createRunnerClaudeAdapter({
      env: { ...baseEnv, AUTH_RUNNER_URL: 'https://runner.example' },
      getAuthSnapshot: async () => ({ token: 't' }),
      fetcher,
    });
    if (!adapter) throw new Error('adapter should be configured');
    return adapter;
  }

  it.each([
    ['temperature', { temperature: 0 }],
    ['top_p', { top_p: 0.9 }],
    ['top_k', { top_k: 40 }],
    ['stop_sequences', { stop_sequences: ['END'] }],
  ])('refuses %s instead of forwarding it to a CLI that drops it', async (_name, params) => {
    const record: { body?: Record<string, unknown> } = {};
    const adapter = adapterWith(record);

    await expect(
      adapter.messages([{ role: 'user', content: 'hi' }], 'claude-test', params),
    ).rejects.toMatchObject({ status: 400, code: 'unsupported_generation_control' });

    // The refusal happens before dispatch: the runner is never called.
    expect(record.body).toBeUndefined();
  });

  it('still forwards max_tokens and system, which this transport can carry', async () => {
    const record: { body?: Record<string, unknown> } = {};
    const adapter = adapterWith(record);

    await adapter.messages([{ role: 'user', content: 'hi' }], 'claude-test', {
      max_tokens: 512,
      system: 'be brief',
    });

    expect(record.body).toMatchObject({ max_tokens: 512, system: 'be brief' });
  });

  it('reports a null stop_reason rather than asserting end_turn', async () => {
    // The runner's /exec reports no stop reason, so `end_turn` was a claim that
    // the model finished its turn — asserted even for output cut short by a
    // timeout, and for the `max_tokens` this transport cannot enforce.
    const record: { body?: Record<string, unknown> } = {};
    const adapter = adapterWith(record);

    const res = await adapter.messages([{ role: 'user', content: 'hi' }], 'claude-test', {});

    expect(res.stop_reason).toBeNull();
  });
});
