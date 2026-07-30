import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFiles } from '../routes/registered-routes.js';
import * as worker from '../../../src/ops/agent-portal-worker.js';
import * as portal from '../../../src/services/agent-portal.js';

/**
 * The agent portal used to fan every lifecycle event out to Matrix, each message
 * carrying a freshly rendered permanent link. That is gone: the portal is
 * pull-only, reached through a link the operator bookmarks once. Deleting the
 * code is not enough to keep it gone — the tempting "just ping me when an agent
 * needs input" patch reintroduces exactly the deep-link spray that was removed,
 * and no other suite would notice.
 *
 * This scan fails when any Matrix transport, outbox table, or outbound push
 * reappears anywhere under `api/src`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = resolve(HERE, '../../../src');

/** Every token that only exists to push portal content off-box. */
const FORBIDDEN = [
  'MATRIX_API_URL',
  'MATRIX_API_KEY',
  'agent_matrix_outbox',
  'agentMatrixOutbox',
  'AGENT_PORTAL_MATRIX_WORKER_INTERVAL_SECONDS',
  'AGENT_PORTAL_MATRIX_TIMEOUT_SECONDS',
];

describe('agent portal has no outbound push channel', () => {
  it('names no Matrix transport anywhere under src', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(API_SRC, ['.ts'])) {
      const source = readFileSync(join(API_SRC, file), 'utf8');
      for (const token of FORBIDDEN) {
        if (!source.includes(token)) continue;
        const line = source.slice(0, source.indexOf(token)).split('\n').length;
        hits.push(`${file}:${line} references ${token}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('exports no delivery surface from the worker or the service', () => {
    expect(Object.keys(worker)).toEqual(['startAgentPortalWorker']);
    const surface = Object.getOwnPropertyNames(portal.AgentPortalService.prototype);
    // `releaseUndeliveredAnswerPrompt` is portal-internal prompt bookkeeping and
    // deliberately not matched here; what must stay gone is anything that pushes.
    expect(surface.filter((name) => /matrix|onboard|resend|outbox/i.test(name))).toEqual([]);
  });

  it('keeps the permanent link off every route that is not owner/admin gated', () => {
    const routes = readFileSync(join(API_SRC, 'routes/agent-portal/admin-host.ts'), 'utf8');
    const publicRoutes = readFileSync(join(API_SRC, 'routes/agent-portal/public.ts'), 'utf8');
    // `magic_url` reaches a client from exactly three admin mutations plus the
    // gated reveal; the portal's own `/go` surface never sees it.
    expect(publicRoutes).not.toContain('magic_url');
    expect(publicRoutes).not.toContain('revealUserLink');
    const revealAt = routes.indexOf("'/admin/agent-portal/users/:id/link'");
    expect(revealAt).toBeGreaterThan(-1);
    expect(routes.slice(revealAt, revealAt + 200)).toContain('requireAgentPortalMutationRole');
  });
});
