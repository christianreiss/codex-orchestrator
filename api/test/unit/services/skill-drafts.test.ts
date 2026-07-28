import { describe, it, expect } from 'vitest';
import { SkillDraftsService } from '../../../src/services/skill-drafts.js';
import { createRunnerClient } from '../../../src/services/runner-client.js';
import type { RunnerClient, RunnerVerifyResult } from '../../../src/services/runner-client.js';
import type {
  CanonicalPayloadRow,
  RunnerValidationService,
} from '../../../src/services/runner-validation.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../../../src/util/engine.js';

/**
 * Covers the finalized runner wiring: with a configured runner + canonical auth,
 * SkillDraftsService.generate must reach the runner and return a normalized
 * draft + manifest. The dep-less `runner_unavailable` path is covered by the
 * admin-content integration test.
 */

function fakeValidation(): RunnerValidationService {
  const row: CanonicalPayloadRow = {
    id: 1,
    lastRefresh: '2026-01-01T00:00:00Z',
    sha256: 'deadbeef',
    body: '{}',
    engine: 'codex',
    createdAt: '2026-01-01T00:00:00Z',
    verificationState: 'verified',
    verificationCheckedAt: '2026-01-01T00:00:00Z',
  };
  return {
    async resolveCanonicalPayload() {
      return row;
    },
    validateCanonicalPayload() {
      return {
        auth: { auths: { 'api.openai.com': { token: 't' } } },
        digest: 'deadbeef',
        last_refresh: '2026-01-01T00:00:00Z',
      };
    },
    canonicalAuthFromPayload: () => ({
      auths: { 'api.openai.com': { token: 'verified-test-token' } },
    }),
    ensureAuthsFallback: (payload) => payload,
    normalizeAuthEntries: () => [],
    hasUsableEngineCredential: () => true,
    canonicalizeAuthPayload: (payload) => payload,
    calculateDigest: () => 'deadbeef',
  };
}

describe('SkillDraftsService.generate (wired runner)', () => {
  it('returns a normalized draft + manifest when the runner succeeds', async () => {
    let sentPrompt = '';
    const runner: Partial<RunnerClient> = {
      isConfigured: () => true,
      async generateSkillDraft(input): Promise<RunnerVerifyResult> {
        sentPrompt = input.prompt;
        return {
          ok: true,
          status: 'ok',
          reachable: true,
          slug: 'demo-skill',
          display_name: 'Demo Skill',
          description: 'A demo skill.',
          tags: ['demo'],
          what: 'Does demo things.',
          when: 'Use it for demos.',
          steps: '1. Do the demo.',
        } as RunnerVerifyResult;
      },
    };

    const svc = new SkillDraftsService({
      runner: runner as RunnerClient,
      runnerValidation: fakeValidation(),
    });

    const out = await svc.generate({ prompt: 'make a demo skill' });

    expect(sentPrompt).toBe('make a demo skill');
    expect(out.slug).toBe('demo-skill');
    expect(typeof out.manifest).toBe('string');
    expect(out.manifest as string).toContain('Demo Skill');
  });
});

const runnerEnv = {
  AUTH_RUNNER_URL: 'https://runner/verify',
  AUTH_RUNNER_SHARED_SECRET: '',
  AUTH_RUNNER_TIMEOUT: 1,
} as unknown as Parameters<typeof createRunnerClient>[0]['env'];

const runnerDraft = {
  status: 'ok',
  slug: 'demo-skill',
  display_name: 'Demo Skill',
  description: 'A demo skill.',
  tags: ['demo'],
  what: 'Does demo things.',
  when: 'Use it for demos.',
  steps: '1. Do the demo.',
  assistant_message: 'Here is a draft.',
};

/**
 * Wires the service to a real runner client so the assertions see the wire
 * body, not just the client-method input.
 */
function wiredService(engine?: Engine): {
  svc: SkillDraftsService;
  bodies: Array<Record<string, unknown>>;
  resolvedFor: Engine[];
} {
  const bodies: Array<Record<string, unknown>> = [];
  const resolvedFor: Engine[] = [];
  const fetchImpl = (async (_target: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(runnerDraft), { status: 200 });
  }) as unknown as typeof fetch;
  const validation: RunnerValidationService = {
    ...fakeValidation(),
    async resolveCanonicalPayload(requested) {
      resolvedFor.push(requested);
      return fakeValidation().resolveCanonicalPayload(requested);
    },
  };
  const svc = new SkillDraftsService({
    runner: createRunnerClient({ env: runnerEnv, fetchImpl }),
    runnerValidation: validation,
    engine,
  });
  return { svc, bodies, resolvedFor };
}

async function callBothEndpoints(svc: SkillDraftsService): Promise<void> {
  await svc.generate({ prompt: 'make a demo skill' });
  await svc.assist({ messages: [{ role: 'user', content: 'tighten the steps' }], mode: 'new', skill: {} });
}

describe('SkillDraftsService runner engine forwarding', () => {
  it('posts the Claude engine it resolved the canonical auth for', async () => {
    const { svc, bodies, resolvedFor } = wiredService(ENGINE_CLAUDE);

    await callBothEndpoints(svc);

    expect(bodies.map((b) => b.engine)).toEqual(['claude', 'claude']);
    expect(resolvedFor).toEqual(['claude', 'claude']);
  });

  it('posts the Codex engine when constructed with it or with no engine at all', async () => {
    const explicit = wiredService(ENGINE_CODEX);
    const implicit = wiredService();

    await callBothEndpoints(explicit.svc);
    await callBothEndpoints(implicit.svc);

    expect(explicit.bodies.map((b) => b.engine)).toEqual(['codex', 'codex']);
    expect(implicit.bodies.map((b) => b.engine)).toEqual(['codex', 'codex']);
    expect(implicit.resolvedFor).toEqual(['codex', 'codex']);
  });
});
