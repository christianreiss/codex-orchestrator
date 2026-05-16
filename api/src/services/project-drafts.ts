/**
 * AI-assisted project drafting. Like skill-drafts, the runner integration
 * lives in another Phase 2 worktree; this stub returns a 501 so the WebUI
 * can advise the operator.
 */
import { ApiError } from '../http/errors.js';

export class ProjectDraftsService {
  assist(_slug: string): never {
    throw new ApiError('Project assist requires the runner integration', {
      status: 501,
      code: 'runner_unavailable',
      extra: {
        next_step:
          'Wire AUTH_RUNNER_URL + AUTH_RUNNER_SHARED_SECRET and the runner-client service to enable AI-assisted project drafts.',
      },
    });
  }
}
