import { describe, expect, it } from 'vitest';
import { makeRunnerConfig, runnerExecUrl } from '../../../src/services/adapters/runner-openai.js';

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
