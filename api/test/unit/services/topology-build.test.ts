import { describe, expect, it } from 'vitest';
import {
  buildTopology,
  type PortalSessionInput,
  type TopologyInputs,
} from '../../../src/services/topology/build.js';
import type { CommunicatorSnapshot, SessionEvidence } from '../../../src/services/topology/communicator-registry.js';

const NOW = Date.parse('2026-10-13T18:00:00.000Z');
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

const session = (id: string, overrides: Partial<PortalSessionInput> = {}): PortalSessionInput => ({
  id,
  engine: 'claude',
  host_id: 4,
  host: 'web01.example',
  username: 'alice',
  cwd: '/srv/work',
  launch_name: null,
  session_name: null,
  invocation_kind: 'interactive',
  presence: 'listening',
  status: 'active',
  relay_ready: true,
  started_at: '2026-10-13T17:00:00.000Z',
  heartbeat_at: '2026-10-13T17:59:50.000Z',
  ended_at: null,
  close: null,
  ...overrides,
});

const evidence = (seenMsAgo: number): SessionEvidence => ({
  first_seen_ms: NOW - 600_000,
  last_seen_ms: NOW - seenMsAgo,
  requests: 5,
  last_route: 'POST /host/agent-sessions/:id/heartbeat',
});

function communicator(
  id: string,
  seen: Record<string, number> = {},
  overrides: Partial<CommunicatorSnapshot> & { host_id?: number; username?: string; version?: string } = {},
): CommunicatorSnapshot {
  return {
    view: {
      id,
      host_id: overrides.host_id ?? 4,
      username: overrides.username ?? 'alice',
      version: overrides.version ?? '0.9.74',
      connected_at: '2026-10-13T17:30:00.000Z',
      sessions: 2,
      requests: 40,
      synced_at: null,
    },
    remote_address: '192.0.2.4',
    capabilities: { terminate: false, pid: null, started_at: null },
    connected_ms: NOW - 1_800_000,
    last_frame_ms: NOW - 3000,
    last_heartbeat_ms: NOW - 3000,
    daemon_attached: false,
    closing: false,
    evidence: new Map(Object.entries(seen).map(([sid, ago]) => [sid, evidence(ago)])),
    ...overrides,
  } as CommunicatorSnapshot;
}

function inputs(overrides: Partial<TopologyInputs> = {}): TopologyInputs {
  return {
    now: NOW,
    serverLabel: 'orchestrator.example',
    startedAtMs: NOW - 86_400_000,
    communicatorEnabled: true,
    portalEnabled: true,
    evidenceFreshSeconds: 45,
    communicators: [],
    hostNames: new Map([[4, 'web01.example']]),
    sessions: [],
    addresses: new Map(),
    daemonBySession: new Map(),
    tombstones: [],
    ...overrides,
  };
}

describe('topology association', () => {
  it('parents a session to the socket that carried its traffic', () => {
    const topology = buildTopology(inputs({ communicators: [communicator('c1', { [S1]: 4000 })], sessions: [session(S1)] }));
    expect(topology.agents[0]!.association).toMatchObject({ state: 'attributed', basis: 'session_traffic', parent_id: 'c1', age_s: 4 });
    expect(topology.communicators[0]!.agent_ids).toEqual([S1]);
    expect(topology.counts).toMatchObject({ attributed: 1, stale: 0, unattributed: 0 });
  });

  it('does NOT parent by host and engine: a session with no traffic evidence hangs off the server', () => {
    // Same host, same OS user, same engine as the communicator — and still no proof.
    const topology = buildTopology(
      inputs({ communicators: [communicator('c1', { [S1]: 4000 })], sessions: [session(S1), session(S2)] }),
    );
    const direct = topology.agents.find((a) => a.id === S2)!;
    expect(direct.association).toEqual({
      state: 'unattributed',
      basis: 'none',
      parent_id: 'server',
      last_seen_at: null,
      age_s: null,
      also_seen_on: [],
    });
    expect(topology.communicators[0]!.agent_ids).toEqual([S1]);
  });

  it('keeps the parent but marks the link stale once the evidence outlives the presence window', () => {
    const topology = buildTopology(inputs({ communicators: [communicator('c1', { [S1]: 120_000 })], sessions: [session(S1)] }));
    expect(topology.agents[0]!.association).toMatchObject({ state: 'stale', parent_id: 'c1', age_s: 120 });
    expect(topology.counts.stale).toBe(1);
  });

  it('picks the socket that saw the session most recently and reports the overlap', () => {
    const topology = buildTopology(
      inputs({
        communicators: [communicator('old', { [S1]: 30_000 }), communicator('new', { [S1]: 2000 })],
        sessions: [session(S1)],
      }),
    );
    expect(topology.agents[0]!.association).toMatchObject({ parent_id: 'new', also_seen_on: ['old'] });
    expect(topology.communicators.find((c) => c.id === 'old')!.agent_ids).toEqual([]);
    expect(topology.communicators.find((c) => c.id === 'new')!.agent_ids).toEqual([S1]);
  });

  it('ignores evidence from a socket on another host', () => {
    const topology = buildTopology(
      inputs({ communicators: [communicator('c9', { [S1]: 1000 }, { host_id: 9 })], sessions: [session(S1)] }),
    );
    expect(topology.agents[0]!.association.state).toBe('unattributed');
  });

  it('separates two communicators of one user on one host', () => {
    const topology = buildTopology(
      inputs({
        communicators: [communicator('a', { [S1]: 1000 }), communicator('b', { [S2]: 1000 })],
        sessions: [session(S1), session(S2)],
      }),
    );
    expect(topology.communicators.find((c) => c.id === 'a')!.agent_ids).toEqual([S1]);
    expect(topology.communicators.find((c) => c.id === 'b')!.agent_ids).toEqual([S2]);
  });

  it('leaves ended sessions out of the tree', () => {
    const topology = buildTopology(
      inputs({
        communicators: [communicator('c1', { [S1]: 1000 })],
        sessions: [session(S1, { ended_at: '2026-10-13T17:59:00.000Z' })],
      }),
    );
    expect(topology.agents).toEqual([]);
    expect(topology.communicators[0]!.agent_ids).toEqual([]);
  });
});

describe('topology nodes', () => {
  it('names an agent from its launch name, then its session name, then its id', () => {
    const topology = buildTopology(
      inputs({
        sessions: [
          session(S1, { launch_name: 'Raffaela', session_name: 'Raffaela — topology' }),
          session(S2, { session_name: 'Unnamed task' }),
          session(S3),
        ],
      }),
    );
    const names = Object.fromEntries(topology.agents.map((a) => [a.id, a.name]));
    expect(names[S1]).toBe('Raffaela');
    expect(names[S2]).toBe('Unnamed task');
    expect(names[S3]).toBe('claude 33333333');
  });

  it('flags a communicator that has gone quiet, and one that is being closed', () => {
    const topology = buildTopology(
      inputs({
        communicators: [
          communicator('quiet', {}, { last_frame_ms: NOW - 60_000, connected_ms: NOW - 400_000 }),
          communicator('closing', {}, { closing: true }),
          communicator('fine'),
        ],
      }),
    );
    const health = Object.fromEntries(topology.communicators.map((c) => [c.id, c.health]));
    expect(health).toEqual({ quiet: 'stale', closing: 'closing', fine: 'live' });
    expect(topology.communicators.find((c) => c.id === 'quiet')!.idle_s).toBe(60);
  });

  it('counts sync scopes that report an error', () => {
    const c = communicator('c1');
    c.view.sync_scopes = [
      { scope: 'a', running: false, content_error: '', auth: { state: 'ok' } },
      { scope: 'b', running: false, content_error: 'boom', auth: { state: 'ok' } },
      { scope: 'c', running: false, content_error: '', auth: { state: 'error', error: 'bad' } },
    ];
    const node = buildTopology(inputs({ communicators: [c] })).communicators[0]!;
    expect(node).toMatchObject({ sync_scopes: 3, sync_errors: 2 });
  });

  it('orders nodes by host, user and start so positions are stable', () => {
    const a = communicator('b-late');
    a.view.connected_at = '2026-10-13T17:40:00.000Z';
    const b = communicator('a-early');
    b.view.connected_at = '2026-10-13T17:10:00.000Z';
    const c = communicator('other-host', {}, { host_id: 5 });
    const topology = buildTopology(
      inputs({ communicators: [a, c, b], hostNames: new Map([[4, 'web01.example'], [5, 'app02.example']]) }),
    );
    expect(topology.communicators.map((n) => n.id)).toEqual(['other-host', 'a-early', 'b-late']);
  });

  it('reports the recent disconnects with the connection that replaced them', () => {
    const topology = buildTopology(
      inputs({
        tombstones: [
          {
            id: 'gone',
            host_id: 4,
            username: 'alice',
            version: '0.9.74',
            connected_at: '2026-10-13T17:00:00.000Z',
            ended_at: '2026-10-13T17:59:00.000Z',
            reason: 'admin_disconnect',
            actor: 'ops',
            pid: 4242,
            process_started_at: null,
            session_ids: [S1],
            successor_id: 'back',
          },
        ],
      }),
    );
    expect(topology.recent_disconnects[0]).toMatchObject({
      id: 'gone',
      host: 'web01.example',
      reason: 'admin_disconnect',
      actor: 'ops',
      affected_agent_ids: [S1],
      successor_id: 'back',
    });
  });

  it('describes the server root honestly as this process only', () => {
    const topology = buildTopology(inputs());
    expect(topology.server).toMatchObject({ id: 'server', label: 'orchestrator.example', scope: 'api_process', uptime_s: 86400 });
  });
});

describe('what an operator may do to an agent', () => {
  it('offers a cooperative close only while the agent is listening and has not been asked', () => {
    const t = buildTopology(
      inputs({
        sessions: [
          session(S1),
          session(S2, { relay_ready: false, presence: 'working' }),
          session(S3, { close: { state: 'pending', requested_at: '2026-10-13T17:59:30.000Z' } }),
        ],
      }),
    );
    const actions = Object.fromEntries(t.agents.map((a) => [a.id, a.actions.request_close]));
    expect(actions[S1]).toEqual({ allowed: true, reason: null });
    expect(actions[S2]).toEqual({ allowed: false, reason: 'agent_not_listening' });
    expect(actions[S3]).toEqual({ allowed: false, reason: 'close_already_requested' });
  });

  it('offers a process stop only for sessions the host daemon launched', () => {
    const t = buildTopology(
      inputs({
        sessions: [session(S1), session(S2), session(S3)],
        daemonBySession: new Map([
          [S2, { session_id: 'daemon-2', status: 'running' }],
          [S3, { session_id: 'daemon-3', status: 'stopping' }],
        ]),
      }),
    );
    const stop = Object.fromEntries(t.agents.map((a) => [a.id, a.actions.stop_process]));
    expect(stop[S1]).toEqual({ allowed: false, reason: 'not_daemon_managed' });
    expect(stop[S2]).toEqual({ allowed: true, reason: null });
    expect(stop[S3]).toEqual({ allowed: false, reason: 'stop_in_progress' });
    expect(t.agents.find((a) => a.id === S2)!.daemon).toEqual({ session_id: 'daemon-2', status: 'running' });
  });

  it('always allows ending the record of a live session', () => {
    const t = buildTopology(inputs({ sessions: [session(S1, { relay_ready: false, presence: 'offline' })] }));
    expect(t.agents[0]!.actions.end_record).toEqual({ allowed: true, reason: null });
  });
});

describe('what an owner process says about itself', () => {
  it('can be stopped remotely only when the owner said so, and shows its own pid', () => {
    const silent = communicator('old', {}, { version: '0.9.74' });
    const capable = communicator('new', {}, { version: '0.9.76', capabilities: { terminate: true, pid: 4242, started_at: '2026-10-13T17:00:00Z' } });
    const topology = buildTopology(inputs({ communicators: [silent, capable] }));
    const byId = Object.fromEntries(topology.communicators.map((c) => [c.id, c]));
    expect(byId.old).toMatchObject({ can_terminate: false, process: null });
    expect(byId.new).toMatchObject({ can_terminate: true, process: { pid: 4242, started_at: '2026-10-13T17:00:00Z' } });
  });

  it('never guesses support from a version string', () => {
    const topology = buildTopology(inputs({ communicators: [communicator('c', {}, { version: '99.0.0' })] }));
    expect(topology.communicators[0]!.can_terminate).toBe(false);
  });
});
