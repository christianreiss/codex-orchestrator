import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RunnerOpenAiAdapter,
  makeRunnerConfig,
  runnerExecUrl,
} from '../../../src/services/adapters/runner-openai.js';

describe('runner-openai', () => {
  it('derives /exec from the shared AUTH_RUNNER_URL verify endpoint', () => {
    expect(runnerExecUrl('http://auth-runner:8080/verify')).toBe('http://auth-runner:8080/exec');
    expect(runnerExecUrl('http://auth-runner:8080/verify/')).toBe('http://auth-runner:8080/exec');
  });

  it('keeps explicit /exec URLs and appends /exec to bare runner bases', () => {
    expect(runnerExecUrl('http://auth-runner:8080/exec')).toBe('http://auth-runner:8080/exec');
    expect(runnerExecUrl('http://auth-runner:8080')).toBe('http://auth-runner:8080/exec');
  });

  it('uses the derived exec URL in runner config', () => {
    const config = makeRunnerConfig({
      AUTH_RUNNER_URL: 'http://auth-runner:8080/verify',
      AUTH_RUNNER_SHARED_SECRET: 'secret',
      AUTH_RUNNER_TIMEOUT: 12,
    } as Parameters<typeof makeRunnerConfig>[0]);

    expect(config).toMatchObject({
      execUrl: 'http://auth-runner:8080/exec',
      sharedSecret: 'secret',
      timeoutSeconds: 12,
    });
  });
});

describe('onExecSuccess traffic hook', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function adapterWith(runnerBody: unknown, status = 200) {
    const onExecSuccess = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(runnerBody), { status })),
    );
    const adapter = new RunnerOpenAiAdapter({
      execUrl: 'http://auth-runner:8080/exec',
      sharedSecret: 'secret',
      timeoutSeconds: 1,
      authSnapshot: async () => ({ tokens: { access_token: 'a' } }),
      onExecSuccess,
    });
    return { adapter, onExecSuccess };
  }

  it('fires exactly once on a successful exec', async () => {
    const { adapter, onExecSuccess } = adapterWith({ status: 'ok', output: 'pong' });
    await adapter.chatCompletions([{ role: 'user', content: 'ping' }], 'gpt-test', {});
    expect(onExecSuccess).toHaveBeenCalledTimes(1);
  });

  it('does not fire on a failed exec', async () => {
    const { adapter, onExecSuccess } = adapterWith({ status: 'fail', error: 'nope' });
    await expect(
      adapter.chatCompletions([{ role: 'user', content: 'ping' }], 'gpt-test', {}),
    ).rejects.toThrow();
    expect(onExecSuccess).not.toHaveBeenCalled();
  });

  it('does not fire on the empty-prompt short-circuit (no runner call happened)', async () => {
    const { adapter, onExecSuccess } = adapterWith({ status: 'ok', output: 'unreachable' });
    await adapter.chatCompletions([{ role: 'user', content: '   ' }], 'gpt-test', {});
    expect(onExecSuccess).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
