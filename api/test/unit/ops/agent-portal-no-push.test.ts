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
 * Matrix link delivery stays retired. The explicitly paired Android companion
 * has a separate FCM outbox carrying opaque identifiers, never permanent links.
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

describe('agent portal has no Matrix link delivery', () => {
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

  it('exports no magic-link or browser identity surface', () => {
    const surface = Object.getOwnPropertyNames(portal.AgentPortalService.prototype);
    expect(surface.filter((name) => /User|MagicLink|Browser|Authenticated/.test(name))).toEqual([]);
  });
});
