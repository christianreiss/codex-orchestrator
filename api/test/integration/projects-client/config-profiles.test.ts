import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { agentsDocuments, clientConfigDocuments, type Host } from '../../../src/db/schema.js';
import { HostAgentsService } from '../../../src/services/host-agents.js';
import { createDbFake } from '../../helpers/db-fake.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const stamp = '2026-09-29T00:00:00Z';

function build(clientVersion: string | null) {
  const db = createDbFake();
  const host = { id: 1, fqdn: 'host.example', engines: 'codex', status: 'active', secure: 1, apiKey: 'host-key', clientVersion } as Host;
  db.tables.set(clientConfigDocuments, [{
    id: 1, engine: 'codex', body: '{}', sha256: digest('{}'), updatedAt: stamp,
    settings: { model: 'gpt-6-astra', profiles: [{ name: 'fast', model: 'gpt-6-luna', model_reasoning_effort: 'low' }] },
  }]);
  db.tables.set(agentsDocuments, []);
  const service = new HostAgentsService(db as never, { publicBaseUrl: 'https://orchestrator.example', keyring: null as never });
  return (sha: string | null = null) => service.retrieveConfig(sha, host, 'codex', { home: null, username: null });
}

// `POST /sync/bootstrap` serves this as its `config` block, and the Codex
// wrapper decodes the `profiles` list from it (orchestrator.ConfigProfile), so
// this pins the live shape a hand-written Go fixture could otherwise drift from.
describe('Codex config profile sidecars', () => {
  it('ships profiles beside the body for a current Codex', async () => {
    const json = await build('0.158.0')();
    expect(json.content).not.toContain('[profiles.');
    expect(json.profiles).toEqual([
      { name: 'fast', sha256: expect.any(String), content: 'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\n' },
    ]);
  });

  it('keeps sending profiles when the body is unchanged, so pruning and repair keep working', async () => {
    const retrieve = build('0.158.0');
    const first = await retrieve();
    const again = await retrieve(first.sha256 as string);
    expect(again.status).toBe('unchanged');
    expect(again.content).toBeUndefined();
    expect(again.profiles).toEqual(first.profiles);
  });

  it('sends no profiles key to a Codex that still reads [profiles.*] from config.toml', async () => {
    const json = await build('0.155.0')();
    expect(json.content).toContain('[profiles.fast]');
    expect(json).not.toHaveProperty('profiles');
  });
});
