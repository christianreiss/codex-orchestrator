import { describe, expect, it, vi } from 'vitest';
import { createDbFake } from '../../helpers/db-fake.js';
import { CompanionRemote } from '../../../src/services/companion/remote.js';
import { hostDaemonSessions, hostDaemonPortalBindings } from '../../../src/db/schema.js';
import type { RouteContext } from '../../../src/routes/index.js';

function fixture(engine: string, status: string, state: string, reasons: string[], livePortal = false) {
  const row = {
    id: 'logical', owner: 'admin:1', hostId: 7, engine, status, sessionId: 'portal',
    title: 'Task', cwd: '/tmp', createdAt: '2026-10-11T00:00:00Z',
  };
  const db = createDbFake(new Map<unknown, Record<string, unknown>[]>([
    [hostDaemonSessions, [row]],
    [hostDaemonPortalBindings, [{ daemonSessionId: 'logical', portalSessionId: 'portal' }]],
  ]));
  const remote = new CompanionRemote({ db } as unknown as RouteContext);
  vi.spyOn(remote, 'hosts').mockResolvedValue([{
    host_id: 7, fqdn: 'test', engines: ['codex', 'claude', 'grok'], startable: false,
    health: { state, reasons },
  }] as never);
  const project = () => remote.project(1, [{
    id: 'portal', presence: livePortal ? 'working' : 'offline', relay_ready: livePortal,
    read_only: false, upstream_session_id: 'native', notices: [],
  }]);
  return { project, db };
}

describe.each(['codex', 'claude', 'grok'])('%s remote presence', (engine) => {
  it.each(['queued', 'running', 'stopping'])('does not label stale %s work as live', async (status) => {
    const { project, db } = fixture(engine, status, 'red', ['heartbeat_expired']);
    expect((await project()).sessions[0]).toMatchObject({
      presence: 'offline', relay_ready: false, remote_status: status,
    });
    // A network outage cannot prove the native process ended or its outcome.
    expect(db.updates).toEqual([]);
  });
  it.each([
    ['yellow', ['reconnecting']],
    ['yellow', ['installation_pending']],
    ['disabled', []],
  ])('treats an unavailable daemon (%s %j) as offline', async (state, reasons) => {
    const { project } = fixture(engine, 'running', state as string, reasons as string[]);
    expect((await project()).sessions[0]!.presence).toBe('offline');
  });
  it('preserves live daemon work even when all slots are busy', async () => {
    const { project } = fixture(engine, 'running', 'yellow', ['busy']);
    expect((await project()).sessions[0]!.presence).toBe('working');
  });
  it('keeps a reachable bound agent live after its daemon disconnects', async () => {
    const { project } = fixture(engine, 'running', 'red', ['heartbeat_expired'], true);
    expect((await project()).sessions[0]).toMatchObject({ presence: 'working', relay_ready: true });
  });
  it('preserves a terminal outcome', async () => {
    const { project } = fixture(engine, 'unknown', 'red', ['heartbeat_expired']);
    expect((await project()).sessions[0]).toMatchObject({ presence: 'ended', remote_status: 'unknown', read_only: true });
  });
});
