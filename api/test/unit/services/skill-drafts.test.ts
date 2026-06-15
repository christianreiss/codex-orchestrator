import { describe, it, expect } from 'vitest';
import { SkillDraftsService } from '../../../src/services/skill-drafts.js';
import type { RunnerClient, RunnerVerifyResult } from '../../../src/services/runner-client.js';
import type {
  CanonicalPayloadRow,
  RunnerValidationService,
} from '../../../src/services/runner-validation.js';

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
    canonicalAuthFromPayload: () => null,
    ensureAuthsFallback: (payload) => payload,
    normalizeAuthEntries: () => [],
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
