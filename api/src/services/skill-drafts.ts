/**
 * AI-assisted skill drafting. The legacy PHP `SkillDraftService` calls into
 * the AUTH_RUNNER backend to generate / refine manifests. The runner client
 * lives in a separate Phase 2 worktree, so this service returns a 501
 * indicating the runner integration is not wired up yet. The frontend
 * already handles a `runner_unavailable` body and shows a clear prompt.
 */
import { ApiError } from '../http/errors.js';

export class SkillDraftsService {
  generate(_input: unknown): never {
    throw new ApiError('Skill draft generation requires the runner integration', {
      status: 501,
      code: 'runner_unavailable',
      extra: {
        next_step:
          'Wire AUTH_RUNNER_URL + AUTH_RUNNER_SHARED_SECRET and the runner-client service to enable AI-assisted skill drafts.',
      },
    });
  }

  assist(_input: unknown): never {
    throw new ApiError('Skill assist requires the runner integration', {
      status: 501,
      code: 'runner_unavailable',
      extra: {
        next_step:
          'Wire AUTH_RUNNER_URL + AUTH_RUNNER_SHARED_SECRET and the runner-client service to enable AI-assisted skill assist.',
      },
    });
  }
}
