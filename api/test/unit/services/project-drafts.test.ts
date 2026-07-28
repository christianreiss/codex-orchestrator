import { describe, it, expect } from 'vitest';
import { ProjectDraftsService } from '../../../src/services/project-drafts.js';
import { createRunnerClient } from '../../../src/services/runner-client.js';
import type { ProjectDetail, ProjectsService } from '../../../src/services/projects.js';
import type {
  CanonicalPayloadRow,
  RunnerValidationService,
} from '../../../src/services/runner-validation.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../../../src/util/engine.js';

/**
 * The runner prepares provider credentials from the posted `engine`, so the
 * engine ProjectDraftsService resolved the canonical auth for has to travel
 * with the body — a Claude blob sent as codex is rejected as unusable.
 */

const runnerEnv = {
  AUTH_RUNNER_URL: 'https://runner/verify',
  AUTH_RUNNER_SHARED_SECRET: '',
  AUTH_RUNNER_TIMEOUT: 1,
} as unknown as Parameters<typeof createRunnerClient>[0]['env'];

function fakeValidation(resolvedFor: Engine[]): RunnerValidationService {
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
    async resolveCanonicalPayload(engine) {
      resolvedFor.push(engine);
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

function fakeProjects(): ProjectsService {
  const detail: ProjectDetail = {
    project: {
      slug: 'demo',
      about: { title: 'Demo', name: 'Demo', description: 'A demo project.' },
      roster_markdown: '- alice',
      latest_seq: 1,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      counts: { notes: 0, open_todos: 0, done_todos: 0, files: 0, feedback: 0 },
    },
    notes: [],
    todos: [],
    files: [],
    feedback: [],
    recent_changes: [],
  };
  return { async detail() { return detail; } } as unknown as ProjectsService;
}

function wiredService(engine?: Engine): {
  svc: ProjectDraftsService;
  bodies: Array<Record<string, unknown>>;
  resolvedFor: Engine[];
} {
  const bodies: Array<Record<string, unknown>> = [];
  const resolvedFor: Engine[] = [];
  const fetchImpl = (async (_target: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        status: 'ok',
        assistant_message: 'Tightened the roster.',
        description: 'A sharper demo project.',
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const svc = new ProjectDraftsService({
    projects: fakeProjects(),
    runner: createRunnerClient({ env: runnerEnv, fetchImpl }),
    runnerValidation: fakeValidation(resolvedFor),
    engine,
  });
  return { svc, bodies, resolvedFor };
}

describe('ProjectDraftsService runner engine forwarding', () => {
  it('posts the Claude engine it resolved the canonical auth for', async () => {
    const { svc, bodies, resolvedFor } = wiredService(ENGINE_CLAUDE);

    const out = await svc.assist('demo');

    expect(bodies.map((b) => b.engine)).toEqual(['claude']);
    expect(resolvedFor).toEqual(['claude']);
    expect(out.assistant_message).toBe('Tightened the roster.');
  });

  it('posts the Codex engine when constructed with it or with no engine at all', async () => {
    const explicit = wiredService(ENGINE_CODEX);
    const implicit = wiredService();

    await explicit.svc.assist('demo');
    await implicit.svc.assist('demo');

    expect(explicit.bodies.map((b) => b.engine)).toEqual(['codex']);
    expect(implicit.bodies.map((b) => b.engine)).toEqual(['codex']);
    expect(implicit.resolvedFor).toEqual(['codex']);
  });
});
