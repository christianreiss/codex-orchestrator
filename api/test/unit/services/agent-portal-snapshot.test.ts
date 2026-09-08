import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/db/client.js';
import { sha256 } from '../../../src/security/hash.js';
import { AgentPortalService } from '../../../src/services/agent-portal.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

type Rows = Array<Record<string, unknown>>;
type Query = Promise<Rows> & Record<'from' | 'innerJoin' | 'where' | 'orderBy' | 'groupBy', (...args: unknown[]) => Query>;
function query(rows: Promise<Rows>): Query {
  const builder = rows as Query;
  for (const name of ['from', 'innerJoin', 'where', 'orderBy', 'groupBy'] as const) builder[name] = () => builder;
  return builder;
}

afterEach(() => vi.restoreAllMocks());

describe.each(['codex', 'claude'])('%s projection clock', (engine) => {
  it.each([undefined, Date.parse('2026-09-08T07:00:00Z')])('observes after pending reads while preserving explicit clock %s', async (explicitTime) => {
    const started = Date.parse('2026-09-08T07:00:00Z');
    let clock = started;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let release!: (rows: Rows) => void;
    const delayedRows = new Promise<Rows>((resolve) => { release = resolve; });
    const select = vi.fn()
      .mockImplementationOnce(() => query(delayedRows))
      .mockImplementation(() => query(Promise.resolve([])));
    const service = new AgentPortalService({ select } as unknown as Database, loadTestEnv(), testKeyring());
    const result = service.listAgentsSnapshot(explicitTime);
    // The first read is waiting while a new heartbeat commits on the server.
    expect(select).toHaveBeenCalledTimes(1);
    clock += 2000;
    const heartbeatAt = new Date(started + 1000).toISOString();
    release([{
      host: { id: 1, fqdn: 'clock.example', status: 'active', engines: engine, apiKey: 'synthetic-key', apiKeyHash: null },
      session: {
        id: 'session-1', hostId: 1, engine, status: 'active', hostAuthFingerprint: sha256('synthetic-key'),
        bridgeExpiresAt: new Date(started + 900_000).toISOString(), heartbeatAt,
        relayEnabled: 1, relayHeartbeatAt: heartbeatAt, endedAt: null, activeTurnId: null,
      },
    }]);
    const snapshot = await result;
    expect(snapshot.generated_at).toBe(new Date(explicitTime ?? clock).toISOString());
    expect(snapshot.sessions[0]).toMatchObject({
      engine,
      presence: explicitTime === undefined ? 'listening' : 'offline',
      relay_ready: explicitTime === undefined,
    });
  });
});
