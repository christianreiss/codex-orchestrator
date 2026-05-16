/**
 * Thin proxy wrapper around the host-runner used by the admin-side
 * /admin/runner/run* and /admin/auth/seed-command endpoints. The actual
 * runner-client lives in the host-api worktree (services/runner-client.ts);
 * until that file is committed we stub the calls and throw a 503 with a
 * clear "not wired" message so the dashboard's runner panel can render
 * without crashing.
 */

import { ServiceUnavailableError } from '../http/errors.js';
import type { Env } from '../env.js';

type Logger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export interface RunnerStatus {
  configured: boolean;
  url: string | null;
  ready: boolean;
  detail: string;
}

export interface RunnerRunRequest {
  prompt?: string;
  engine?: 'codex' | 'claude';
  model?: string | null;
  reasoning_effort?: string | null;
  preview?: boolean;
}

export interface RunnerRunResult {
  status: 'ok' | 'error';
  output?: string;
  detail?: string;
}

export class RunnerProxyService {
  constructor(
    private readonly env: Env,
    private readonly log?: Logger,
  ) {}

  status(): RunnerStatus {
    const url = this.env.AUTH_RUNNER_URL ?? null;
    const secret = this.env.AUTH_RUNNER_SHARED_SECRET ?? '';
    if (!url) {
      return { configured: false, url: null, ready: false, detail: 'AUTH_RUNNER_URL is not set' };
    }
    if (!secret) {
      return { configured: true, url, ready: false, detail: 'AUTH_RUNNER_SHARED_SECRET missing' };
    }
    return { configured: true, url, ready: true, detail: 'configured' };
  }

  async run(payload: RunnerRunRequest, engine: 'codex' | 'claude'): Promise<RunnerRunResult> {
    void payload;
    void engine;
    this.log?.warn?.('runner-proxy.run called but runner-client is not wired');
    throw new ServiceUnavailableError(
      'Runner client not wired in this build; expected from host-api worktree (services/runner-client.ts)',
      'runner_not_wired',
    );
  }

  async seedCommand(payload: Record<string, unknown>): Promise<{ status: string; queued: boolean }> {
    void payload;
    this.log?.info?.('runner-proxy.seedCommand called (stub)');
    return { status: 'ok', queued: true };
  }
}
