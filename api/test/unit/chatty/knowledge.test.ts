import { resolve } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { signature } from '../../../src/services/chatty/contracts.js';
import { describe, it, expect } from 'vitest';
import { buildKnowledge, searchKnowledge } from '../../../src/services/chatty/knowledge.js';

// Paired DE/EN product questions, evaluated against the actual shipped sources.
const CASES: Array<[string, string, string]> = [
  ['Was macht der Engine master switch?', 'What happens when an engine master switch is off?', 'suspend'],
  ['Wie funktionieren Account leases?', 'How are provider account leases balanced?', 'lease'],
  ['Wie funktionieren Skills und skill_retrieve?', 'How do I retrieve a skill manifest?', 'skill'],
  ['Wie finde ich shared_memory_search?', 'How do I search shared memory?', 'shared_memory'],
  [
    'Wie erstelle ich ein Projekt mit project_bootstrap?',
    'What does project_bootstrap return?',
    'project_bootstrap',
  ],
  ['Wie funktioniert git_merge_request?', 'When do I request a Git Director merge lease?', 'git_merge'],
  ['Wie erstelle ich einen Zeitplan schedule_create?', 'How do schedule_create and cron work?', 'schedule'],
  ['Wie funktioniert watchdog_enable?', 'How does bounded watchdog recovery work?', 'watchdog'],
  ['Wie funktioniert agent_call_open?', 'How do agents open a live call?', 'call'],
  ['Wie arbeitet agent_conf_dispatch?', 'How does conference task dispatch work?', 'conf'],
  ['Wie funktioniert transfer_put?', 'How long does a transfer upload live?', 'transfer'],
  ['Wie nutze ich secret_search?', 'How can an agent search credential metadata?', 'secret'],
  ['Was ist BrowserOS MCP?', 'How does BrowserOS integrate with MCP?', 'browseros'],
  ['Wie funktioniert quota_hard_fail?', 'What does quota_hard_fail enforce?', 'quota'],
  ['Wie funktionieren Claude output styles?', 'Where are Claude output styles stored?', 'output'],
  ['Wie läuft Grok OIDC refresh?', 'Who owns Grok OIDC token refresh?', 'grok'],
  [
    'Wie funktioniert agent_receiver_reply?',
    'How does agent_receiver_reply update the portal?',
    'agent_receiver_reply',
  ],
  ['Wie funktionieren idempotente Migrationen?', 'How are idempotent database migrations applied?', 'migrat'],
  ['Wie funktionieren passkeys und WebAuthn?', 'How does passkey authentication work?', 'passkey'],
  ['Wie funktioniert der Setup Wizard?', 'What does setup_complete mean in the setup wizard?', 'setup'],
];
describe('Chatty product knowledge', () => {
  const bundle = buildKnowledge(resolve(import.meta.dirname, '../../../..'));
  it('ships a deterministic private corpus with stable source provenance', () => {
    expect(bundle.sources.length).toBeGreaterThan(100);
    expect(new Set(bundle.sources.map((s) => s.id)).size).toBe(bundle.sources.length);
    expect(bundle.version).toHaveLength(64);
    for (const source of bundle.sources) {
      expect(source.sha256).toHaveLength(64);
      expect(source.path).not.toMatch(/\.env|storage\//);
    }
  });
  it('includes current operator and runtime guides with the exact current file digest', () => {
    const repo = resolve(import.meta.dirname, '../../../..');
    const paths = [
      'docs/INSTALL.md', 'docs/SECURITY.md', 'docs/LOGIN.md', 'docs/USAGE.md',
      'docs/MCP.md', 'docs/communicator.md', 'docs/control-plane-owner.md',
      'docs/owner-cutover.md', 'docs/android-companion.md', 'docs/workflows.md',
      'docs/agent-coordination.md', 'docs/file-transfers.md',
      'docs/documentation-maintenance.md',
      'api/README.md', 'wrappers/README.md', 'runner/README.md',
      'docs/skills/README.md', 'docs/contracts/README.md',
    ];
    for (const path of paths) {
      const sources = bundle.sources.filter((source) => source.path === path);
      expect(sources.length, path).toBeGreaterThan(0);
      const digest = signature(readFileSync(resolve(repo, path), 'utf8'));
      expect(sources.every((source) => source.sha256 === digest), path).toBe(true);
    }
    expect(bundle.sources.some((source) => /docs\/(archive|verification)\/|\d{4}-\d{2}-\d{2}/.test(source.path))).toBe(false);
  });
  it.each(['Dockerfile', 'api/Dockerfile'])('%s supplies every file source to the knowledge build', (dockerfile) => {
    const repo = resolve(import.meta.dirname, '../../../..');
    const text = readFileSync(resolve(repo, dockerfile), 'utf8').split(/FROM .* AS prod-deps/i)[0]!;
    const copies: Array<{ source: string; target: string; directory: boolean }> = [];
    let workdir = '/';
    for (const line of text.split('\n')) {
      if (line.startsWith('WORKDIR ')) workdir = resolve(workdir, line.slice(8));
      if (!line.startsWith('COPY ') || line.includes('--from=')) continue;
      const parts = line.slice(5).trim().split(/\s+/);
      const destination = parts.pop()!;
      for (const source of parts) {
        const directory = statSync(resolve(repo, source)).isDirectory();
        copies.push({ source, directory, target: resolve(workdir, destination) });
      }
    }
    for (const path of new Set(bundle.sources.map((source) => source.path).filter((path) => !path.includes('://')))) {
      expect(copies.some((copy) => copy.directory
        ? path.startsWith(`${copy.source}/`) && resolve(copy.target, path.slice(copy.source.length + 1)) === `/app/${path}`
        : copy.source === path && copy.target === `/app/${path}`), path).toBe(true);
    }
  });
  it('makes recent operational corrections available as supporting knowledge', () => {
    const install = bundle.sources.filter((source) => source.path === 'docs/INSTALL.md').map((source) => source.body).join('\n');
    expect(install).toContain('rollback');
    expect(install).toContain('standalone quota writer are retired');
    expect(searchKnowledge(bundle, 'database storage rollback bundle', 8).some((source) => source.path === 'docs/INSTALL.md')).toBe(true);
    expect(searchKnowledge(bundle, 'Grok subscription billing usage weekly monthly', 8).some((source) => source.path === 'wrappers/README.md')).toBe(true);
  });
  it('retrieves supporting evidence in the top five for at least 90% of 40 DE/EN questions', () => {
    const missed = CASES.flatMap(([de, en, evidence]) =>
      [de, en]
        .filter(
          (query) =>
            !searchKnowledge(bundle, query, 5).some((s) =>
              `${s.heading} ${s.body}`.toLowerCase().includes(evidence),
            ),
        )
        .map((query) => ({ query, evidence })),
    );
    expect(missed.length, JSON.stringify(missed, null, 2)).toBeLessThanOrEqual(4);
  });
});
