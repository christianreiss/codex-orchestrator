import type { Database } from '../../../src/db/client.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ResourceClaims } from '../../../src/services/agent-coordination/claims.js';
import type { AgentCoordination } from '../../../src/services/agent-coordination/index.js';
import { agentResourceClaims, hosts } from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';
const fixture = (engine: string) => {
  const id = randomUUID(),
    db = createDbFake(
      new Map([
        [
          hosts,
          [
            { id: 32, internalRole: null },
            { id: 77, internalRole: null },
          ],
        ],
      ]),
    ) as unknown as Database;
  const core = {
    db,
    protocol: () => 1,
    present: () => false,
    reconcile: vi.fn(async () => {}),
    run: vi.fn(
      async (_id: string, _token: string, action: (tx: unknown, session: unknown) => Promise<unknown>) =>
        action(db, { id, hostId: 32, engine, bindingGeneration: 1 }),
    ),
    event: vi.fn(),
  };
  return { id, db, service: new ResourceClaims(core as unknown as AgentCoordination) };
};
const resource = (kind: string) =>
  kind === 'path'
    ? { kind, path: '/tmp/claim-default' }
    : kind === 'git'
      ? { kind, common_dir: '/tmp/claim-default/.git', branch: 'main' }
      : { kind, service: 'claim-fixture' };
describe('authenticated current-host resource defaults', () => {
  it.each(['codex', 'claude', 'grok'])(
    '%s defaults local resource host and preserves idempotent explicit retry',
    async (engine) => {
      for (const kind of ['path', 'git', 'service']) {
        const f = fixture(engine),
          client_request_id = randomUUID(),
          r = resource(kind),
          input = { client_request_id, purpose: 'local default contract', resources: [r] };
        const first = await f.service.acquire(f.id, 'fixture-token', input);
        expect(first.resources).toEqual([{ ...r, host_id: 32 }]);
        const retry = await f.service.acquire(f.id, 'fixture-token', {
          ...input,
          resources: [{ ...r, host_id: 32 }],
        });
        expect(retry.id).toBe(first.id);
        expect(input.resources).toEqual([r]);
        expect((await f.db.select().from(agentResourceClaims)).length).toBe(1);
      }
    },
  );
  it.each(['codex', 'claude', 'grok'])(
    '%s keeps explicit fleet targets and remote targets distinct',
    async (engine) => {
      const f = fixture(engine);
      const out = await f.service.acquire(f.id, 'fixture-token', {
        client_request_id: randomUUID(),
        purpose: 'explicit targets',
        resources: [
          { kind: 'path', host_id: 77, path: '/tmp/other-host' },
          { kind: 'remote', fqdn: 'BOX.EXAMPLE.TEST.', service: 'emulator' },
        ],
      });
      expect(out.resources).toEqual([
        { kind: 'path', host_id: 77, path: '/tmp/other-host' },
        { kind: 'remote', fqdn: 'box.example.test', service: 'emulator' },
      ]);
    },
  );
  it.each([null, 0, -1, '32'])(
    'rejects explicit invalid host value %s instead of defaulting it',
    async (host_id) => {
      const f = fixture('codex');
      await expect(
        f.service.acquire(f.id, 'fixture-token', {
          client_request_id: randomUUID(),
          purpose: 'invalid host',
          resources: [{ kind: 'path', host_id, path: '/tmp/invalid' }],
        }),
      ).rejects.toThrow();
      expect(await f.db.select().from(agentResourceClaims)).toEqual([]);
    },
  );
});
