import type { Env } from '../env.js';

/**
 * Port of RunnerVerifier.php. POSTs canonical auth payloads to the runner's
 * `/verify` endpoint for inspection, returning the verdict (and optionally an
 * `updated_auth` blob if the runner refreshed tokens).
 *
 * Behavior contract preserved:
 *   - returns `{ ok: true, status: 'ok', updated_auth?, ... }` on success
 *   - returns `{ ok: false, status: 'fail', reason }` on transport / parse error
 *   - returns `{ status: 'unconfigured' }` when AUTH_RUNNER_URL is unset
 *
 * Timeout via AbortSignal.timeout. The legacy PHP code did a /health probe
 * before sending the body — we skip that here: a single POST with sane
 * timeouts is enough; the route layer can implement a retry on its own.
 */

export interface RunnerVerifyInput {
  authJson: Record<string, unknown>;
  timeoutSeconds?: number;
}

export interface RunnerVerifyResult {
  ok: boolean;
  status: 'ok' | 'fail' | 'unconfigured';
  reason?: string;
  updated_auth?: Record<string, unknown>;
  reachable: boolean;
  latency_ms?: number;
  [key: string]: unknown;
}

export interface RunnerSkillGenerateInput {
  prompt: string;
  authJson: Record<string, unknown>;
  slugHint?: string | null;
  timeoutSeconds?: number;
}

export interface RunnerSkillAssistInput {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  skill: Record<string, unknown>;
  authJson: Record<string, unknown>;
  mode?: 'new' | 'edit';
  slugLocked?: boolean;
  timeoutSeconds?: number;
}

export interface RunnerProjectAssistInput {
  slug: string;
  project: Record<string, unknown>;
  authJson: Record<string, unknown>;
  timeoutSeconds?: number;
}

export interface RunnerClient {
  verify(input: RunnerVerifyInput): Promise<RunnerVerifyResult>;
  verifyClaude(input: RunnerVerifyInput): Promise<RunnerVerifyResult>;
  generateSkillDraft?(input: RunnerSkillGenerateInput): Promise<RunnerVerifyResult>;
  assistSkillDraft?(input: RunnerSkillAssistInput): Promise<RunnerVerifyResult>;
  assistProjectDraft?(input: RunnerProjectAssistInput): Promise<RunnerVerifyResult>;
  isConfigured(): boolean;
}

export interface RunnerClientDeps {
  env: Env;
  fetchImpl?: typeof fetch;
}

export function createRunnerClient(deps: RunnerClientDeps): RunnerClient {
  const env = deps.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = env.AUTH_RUNNER_URL ?? '';
  const secret = env.AUTH_RUNNER_SHARED_SECRET ?? '';
  const defaultTimeout = (env.AUTH_RUNNER_TIMEOUT ?? 8) * 1000;

  async function send(target: string, body: Record<string, unknown>, timeoutMs: number): Promise<RunnerVerifyResult> {
    if (!url) return { ok: false, status: 'unconfigured', reachable: false, reason: 'AUTH_RUNNER_URL not set' };
    const start = Date.now();
    try {
      const res = await fetchImpl(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret ? { 'x-runner-auth': secret } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const latencyMs = Date.now() - start;
      const text = await res.text();
      if (!text) {
        return {
          ok: false,
          status: 'fail',
          reachable: true,
          latency_ms: latencyMs,
          reason: `runner returned empty response (status ${res.status})`,
        };
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(text);
      } catch {
        return {
          ok: false,
          status: 'fail',
          reachable: true,
          latency_ms: latencyMs,
          reason: `invalid runner response (status ${res.status})`,
        };
      }
      if (!decoded || typeof decoded !== 'object') {
        return {
          ok: false,
          status: 'fail',
          reachable: true,
          latency_ms: latencyMs,
          reason: `invalid runner response (status ${res.status})`,
        };
      }
      const d = decoded as Record<string, unknown>;
      const isOk = (d.status ?? 'fail') === 'ok' && res.ok;
      return {
        ...d,
        ok: isOk,
        status: isOk ? 'ok' : 'fail',
        reachable: true,
        latency_ms: typeof d.latency_ms === 'number' ? d.latency_ms : latencyMs,
      };
    } catch (err) {
      return {
        ok: false,
        status: 'fail',
        reachable: false,
        latency_ms: Date.now() - start,
        reason: err instanceof Error ? err.message : 'runner unreachable',
      };
    }
  }

  function deriveClaudeUrl(base: string): string {
    return base.replace(/\/verify$/, '/verify-claude');
  }

  function deriveFeatureUrl(base: string, featurePath: string): string {
    if (!base) return '';
    try {
      const u = new URL(base);
      const path = u.pathname;
      if (path === '' || path === '/') {
        u.pathname = featurePath;
      } else if (/\/verify\/?$/.test(path)) {
        u.pathname = path.replace(/\/verify\/?$/, featurePath);
      } else {
        u.pathname = path.replace(/\/+$/, '') + featurePath;
      }
      return u.toString();
    } catch {
      return '';
    }
  }

  return {
    isConfigured: () => Boolean(url),
    async verify(input) {
      const timeout = (input.timeoutSeconds ?? env.AUTH_RUNNER_TIMEOUT ?? 8) * 1000;
      return send(url, { auth_json: input.authJson, timeout_seconds: timeout / 1000 }, timeout || defaultTimeout);
    },
    async verifyClaude(input) {
      const timeout = (input.timeoutSeconds ?? env.AUTH_RUNNER_TIMEOUT ?? 8) * 1000;
      return send(
        deriveClaudeUrl(url),
        { auth_json: input.authJson, timeout_seconds: timeout / 1000 },
        timeout || defaultTimeout,
      );
    },
    async generateSkillDraft(input) {
      const target = deriveFeatureUrl(url, '/skills/generate');
      if (!target) {
        return {
          ok: false,
          status: 'fail',
          reachable: false,
          reason: 'skill generation endpoint is not configured',
        };
      }
      const timeout = (input.timeoutSeconds ?? env.AUTH_RUNNER_TIMEOUT ?? 8) * 1000;
      const body: Record<string, unknown> = {
        auth_json: input.authJson,
        prompt: input.prompt,
        timeout_seconds: timeout / 1000,
      };
      const hint = typeof input.slugHint === 'string' ? input.slugHint.trim() : '';
      if (hint !== '') body.slug_hint = hint;
      return send(target, body, timeout || defaultTimeout);
    },
    async assistSkillDraft(input) {
      const target = deriveFeatureUrl(url, '/skills/assist');
      if (!target) {
        return {
          ok: false,
          status: 'fail',
          reachable: false,
          reason: 'skill assist endpoint is not configured',
        };
      }
      const timeout = (input.timeoutSeconds ?? env.AUTH_RUNNER_TIMEOUT ?? 8) * 1000;
      const mode = input.mode === 'edit' ? 'edit' : 'new';
      return send(
        target,
        {
          auth_json: input.authJson,
          messages: input.messages,
          skill: input.skill,
          mode,
          slug_locked: Boolean(input.slugLocked),
          timeout_seconds: timeout / 1000,
        },
        timeout || defaultTimeout,
      );
    },
    async assistProjectDraft(input) {
      const target = deriveFeatureUrl(url, '/projects/assist');
      if (!target) {
        return {
          ok: false,
          status: 'fail',
          reachable: false,
          reason: 'project assist endpoint is not configured',
        };
      }
      const timeout = (input.timeoutSeconds ?? env.AUTH_RUNNER_TIMEOUT ?? 8) * 1000;
      return send(
        target,
        {
          auth_json: input.authJson,
          slug: input.slug,
          project: input.project,
          timeout_seconds: timeout / 1000,
        },
        timeout || defaultTimeout,
      );
    },
  };
}
