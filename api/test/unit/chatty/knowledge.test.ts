import { resolve } from 'node:path';
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
